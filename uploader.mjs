// Subida a S3 con cola en background.
//
// Diseno: el ripeo y la subida NO se bloquean entre si. En cuanto un disco
// termina de leerse se expulsa y se encola; la subida corre mientras el
// operador ya metio el siguiente disco. Ese es el punto donde se gana tiempo.

import { createReadStream } from 'node:fs'
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, relative, extname } from 'node:path'
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { S3, OUT_DIR, SOLO_LOCAL, DEMO } from './config.mjs'
import { nombreS3, nombreSalida, INTENTOS_LECTURA } from './vcd.mjs'
import {
  vistaPreviaDesdeMuestra,
  BYTES_MUESTRA,
  BYTES_MUESTRA_GRANDE,
  ARCHIVO_PREVIA,
  hayFfmpeg,
  generarVistaPrevia,
} from './preview.mjs'

export { nombreS3 }

const PENDIENTES = join(OUT_DIR, 'pendientes.json')
const REINTENTOS = 3
const LOCAL = 'local/'
const VIDEO_RE = /\.(mpg|mpeg|mp4|avi|mov|m4v|mkv|wmv)$/i
const PREFIJO_MARCA_PREVIA = '.previa-de-'

// sin cliente en solo-local ni en demo: ahi no existe config de S3
const client =
  SOLO_LOCAL || DEMO ? null : new S3Client({ region: S3.region, credentials: S3.credentials })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function marcaPreviaDe(nombre, bytes) {
  return (
    PREFIJO_MARCA_PREVIA +
    createHash('sha256')
      .update(String(nombre || ''))
      .update('\0')
      .update(String(bytes || 0))
      .digest('hex')
      .slice(0, 16)
  )
}

function esCopiaConSufijo(carpeta) {
  return / \(\d+\)$/.test(String(carpeta || ''))
}

function previaDeEsteVideo(item) {
  const video = item?.archivos?.[0]
  if (!video) return false
  return item.marcasPrevia?.has(marcaPreviaDe(video.nombre, video.bytes)) === true
}

async function guardarMarcaPrevia(prefijo, nombre, bytes) {
  if (!client || !prefijo || !nombre) return
  await client.send(
    new PutObjectCommand({
      Bucket: S3.bucket,
      Key: `${prefijo}/${marcaPreviaDe(nombre, bytes)}`,
      Body: '',
      StorageClass: S3.storageClass,
    }),
  )
}

async function leerCuerpo(body) {
  if (!body) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray())
  }
  const partes = []
  for await (const c of body) partes.push(c)
  return Buffer.concat(partes)
}

/**
 * Id derivado del contenido: los primeros 8 hex del sha256 del video unido.
 * Ripear el mismo disco dos veces cae en el mismo prefijo (idempotente) y
 * dos discos con la misma etiqueta no se pisan entre si.
 */
export function idContenido(resumen) {
  if (resumen.sha256) return resumen.sha256.slice(0, 8)
  // resguardo para manifiestos del formato anterior (un .mpg por fragmento)
  const h = createHash('sha256')
  for (const v of resumen.videos || []) h.update(v.sha256)
  return h.digest('hex').slice(0, 8)
}

/**
 * Resuelve el prefijo final consultando S3:
 *   - libre                        -> "<prefix>/<NOMBRE DEL CD>"
 *   - ocupado por el mismo disco   -> el mismo (re-subida idempotente)
 *   - ocupado por OTRO disco       -> "<prefix>/<NOMBRE DEL CD>-<id>"
 *
 * La marca ".id-<hash>" dentro de la carpeta permite distinguirlos con solo
 * permiso de ListBucket, sin necesidad de leer objetos.
 */
export async function resolverPrefijo(resumen) {
  const nombre = nombreS3(resumen.carpeta || resumen.etiqueta_disco)
  const id = idContenido(resumen)
  const base = `${S3.prefix}/${nombre}`

  const r = await client.send(
    new ListObjectsV2Command({ Bucket: S3.bucket, Prefix: `${base}/`, MaxKeys: 200 }),
  )
  const claves = (r.Contents || []).map((o) => o.Key)

  if (!claves.length) return { prefijo: base, id, motivo: 'libre' }

  const marca = claves.find((k) => k.includes('/.id-'))
  const idPrevio = marca?.split('/.id-')[1]
  if (idPrevio === id) return { prefijo: base, id, motivo: 'mismo-disco' }

  return { prefijo: `${base}-${id}`, id, motivo: 'colision' }
}

/** Version sincrona para mostrar el destino previsto en la UI. */
export function prefijoDe(resumen) {
  return `${S3.prefix}/${nombreS3(resumen.carpeta || resumen.etiqueta_disco)}`
}

// ------------------------------------------------------------ subir 1 archivo

async function subirArchivo(rutaLocal, key, onProgress) {
  const { size } = await stat(rutaLocal)
  const tipo = /\.mp4$/i.test(key)
    ? 'video/mp4'
    : /\.mpg$/i.test(key)
      ? 'video/mpeg'
      : /\.json$/i.test(key)
        ? 'application/json'
        : undefined

  const up = new Upload({
    client,
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    params: {
      Bucket: S3.bucket,
      Key: key,
      Body: createReadStream(rutaLocal),
      StorageClass: S3.storageClass,
      ChecksumAlgorithm: 'SHA256',
      ...(tipo ? { ContentType: tipo } : {}),
    },
  })

  up.on('httpUploadProgress', (p) => onProgress(p.loaded || 0, size))
  await up.done()
  onProgress(size, size)
  return { key, bytes: size }
}

// -------------------------------------------------------------- cola + worker

const cola = []
let trabajando = false
let notificar = () => {}

/** Estado que consume la UI. */
export const estadoSubida = {
  actual: null, // { label, archivo, index, total, pct, subidos, size }
  enCola: 0,
  completados: [], // { label, prefijo, archivos, bytes, segundos }
  pendientes: [], // fallaron tras los reintentos
}

export function onCambio(fn) {
  notificar = fn
}

function sync() {
  estadoSubida.enCola = cola.length
  notificar()
}

export function encolar(resumen) {
  if (SOLO_LOCAL) return
  cola.push(resumen)
  sync()
  if (!trabajando) drenar()
}

async function subirDisco(resumen) {
  const { prefijo, id, motivo } = await resolverPrefijo(resumen)
  const videos = resumen.videos?.length
    ? resumen.videos.map((v) => v.archivo)
    : resumen.archivo
      ? [resumen.archivo]
      : []
  const archivos = [...videos, ...(resumen.vista_previa ? [resumen.vista_previa] : []), 'manifest.json']
  const t0 = Date.now()
  let bytes = 0

  for (let i = 0; i < archivos.length; i++) {
    const nombre = archivos[i]
    const local = join(resumen.destino, nombre)
    const key = `${prefijo}/${nombre}`

    let ultimoError
    let subido = false
    for (let intento = 1; intento <= REINTENTOS && !subido; intento++) {
      try {
        const r = await subirArchivo(local, key, (subidos, size) => {
          estadoSubida.actual = {
            label: resumen.etiqueta_disco,
            archivo: nombre,
            index: i + 1,
            total: archivos.length,
            pct: size ? Math.min(100, Math.floor((subidos / size) * 100)) : 0,
            subidos,
            size,
            intento,
          }
          sync()
        })
        bytes += r.bytes
        subido = true
      } catch (e) {
        ultimoError = String(e.message || e)
        if (intento < REINTENTOS) await sleep(2000 * intento) // backoff
      }
    }

    if (!subido) {
      // no se pierde nada: queda en pendientes y el archivo sigue en local
      throw new Error(`${nombre}: ${ultimoError}`)
    }
  }

  // marca de identidad: deja saber que disco vive en esta carpeta usando
  // solo ListBucket, sin permiso de lectura de objetos
  try {
    await client.send(
      new PutObjectCommand({ Bucket: S3.bucket, Key: `${prefijo}/.id-${id}`, Body: '' }),
    )
  } catch {
    /* la marca es una comodidad, no un requisito */
  }

  if (resumen.vista_previa && resumen.archivo) {
    await guardarMarcaPrevia(prefijo, resumen.archivo, resumen.bytes_totales).catch(() => {})
  }

  return {
    label: resumen.etiqueta_disco,
    prefijo,
    motivo,
    archivos: archivos.length,
    bytes,
    segundos: Math.round((Date.now() - t0) / 1000),
  }
}

async function drenar() {
  trabajando = true
  while (cola.length) {
    const resumen = cola.shift()
    sync()
    try {
      const r = await subirDisco(resumen)
      estadoSubida.completados.unshift(r)
    } catch (e) {
      estadoSubida.pendientes.unshift({
        label: resumen.etiqueta_disco,
        destino: resumen.destino,
        error: String(e.message || e),
      })
      await guardarPendientes()
    }
    estadoSubida.actual = null
    sync()
  }
  trabajando = false
  sync()
}

// ------------------------------------------------- persistencia de pendientes

async function guardarPendientes() {
  try {
    await writeFile(PENDIENTES, JSON.stringify(estadoSubida.pendientes, null, 2))
  } catch {
    /* si no se puede escribir, el archivo local sigue ahi de todos modos */
  }
}

/** Recupera lo que quedo pendiente de una sesion anterior. */
export async function cargarPendientes() {
  if (SOLO_LOCAL || DEMO) return
  try {
    const prev = JSON.parse(await readFile(PENDIENTES, 'utf8'))
    if (Array.isArray(prev) && prev.length) {
      estadoSubida.pendientes = prev
      sync()
    }
  } catch {
    /* no hay pendientes: normal */
  }
}

/** Reintenta los pendientes leyendo su manifest.json de disco. */
export async function reintentarPendientes() {
  if (SOLO_LOCAL) return
  const lista = estadoSubida.pendientes.splice(0)
  await guardarPendientes()
  for (const p of lista) {
    try {
      const resumen = JSON.parse(await readFile(join(p.destino, 'manifest.json'), 'utf8'))
      encolar(resumen)
    } catch (e) {
      estadoSubida.pendientes.push({ ...p, error: `no se pudo releer: ${e.message}` })
    }
  }
  await guardarPendientes()
  sync()
}

// --------------------------------------------------- modo directo (sin local)

/**
 * Busca un nombre de carpeta libre en S3. El hash de contenido no sirve aqui
 * porque solo se conoce al terminar de leer el disco, y la clave hay que
 * elegirla antes de subir. Sufijo numerico para no sobreescribir nunca.
 */
async function nombreLibre(label) {
  const base = nombreS3(label)
  for (let n = 1; n <= 50; n++) {
    const nombre = n === 1 ? base : `${base} (${n})`
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: S3.bucket, Prefix: `${S3.prefix}/${nombre}/`, MaxKeys: 1 }),
    )
    if (!r.Contents?.length) return nombre
  }
  return `${base} (${Date.now()})`
}

/**
 * Ripea el disco y lo manda directo a S3, sin escribir nada en la maquina.
 * El multiparte va en memoria (~32 MB), no usa archivo temporal.
 *
 * Contrapartida: el disco se queda dentro hasta que termina la subida, y si
 * la subida falla hay que releer el disco (no hay copia local de respaldo).
 */
export async function ripDiscDirectoS3(disc, onEvent = () => {}) {
  const SALIDA = nombreSalida(disc.label)

  const nombre = await nombreLibre(disc.label)
  const prefijo = `${S3.prefix}/${nombre}`

  onEvent({ type: 'disc:start', label: disc.label, carpeta: nombre, destino: `s3://${S3.bucket}/${prefijo}`, total: disc.dats.length })

  let ultimoError
  for (let intento = 1; intento <= INTENTOS_LECTURA; intento++) {
    if (intento > 1) onEvent({ type: 'disc:retry', intento, total: INTENTOS_LECTURA })
    try {
      return await intentarDirecto(disc, prefijo, SALIDA, nombre, onEvent)
    } catch (e) {
      ultimoError = e
    }
  }
  throw ultimoError
}

async function intentarDirecto(disc, prefijo, SALIDA, carpeta, onEvent) {
  const { crearRipStream } = await import('./vcd.mjs')
  const { PassThrough } = await import('node:stream')

  const rip = crearRipStream(disc, onEvent)
  const body = new PassThrough()

  const up = new Upload({
    client,
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    params: {
      Bucket: S3.bucket,
      Key: `${prefijo}/${SALIDA}`,
      Body: body,
      StorageClass: S3.storageClass,
      ChecksumAlgorithm: 'SHA256',
    },
  })

  up.on('httpUploadProgress', (p) => {
    estadoSubida.actual = {
      label: disc.label,
      archivo: SALIDA,
      index: 1,
      total: 1,
      // el total real no se sabe hasta terminar de leer; se usa el tamano
      // de los .DAT como estimacion (el video pesa ~1.3% menos)
      pct: disc.totalBytes ? Math.min(99, Math.floor(((p.loaded || 0) / disc.totalBytes) * 100)) : 0,
      subidos: p.loaded || 0,
      size: disc.totalBytes || 0,
    }
    sync()
  })

  // Se guardan los primeros MB en memoria para poder cortar la vista previa
  // sin volver a bajar el video de S3 ni guardarlo completo en disco.
  const muestra = []
  let bytesMuestra = 0

  // alimenta la subida con los bytes que va produciendo el ripeo
  const bombeo = (async () => {
    try {
      for await (const chunk of rip.chunks()) {
        if (bytesMuestra < BYTES_MUESTRA) {
          const falta = BYTES_MUESTRA - bytesMuestra
          const trozo = chunk.length <= falta ? chunk : chunk.subarray(0, falta)
          muestra.push(Buffer.from(trozo))
          bytesMuestra += trozo.length
        }
        if (!body.write(chunk)) await new Promise((r) => body.once('drain', r))
      }
      body.end()
    } catch (e) {
      body.destroy(e)
      throw e
    }
  })()

  try {
    await Promise.all([bombeo, up.done()])
  } catch (e) {
    // CLAVE: abortar la multiparte. Sin esto quedarian partes huerfanas
    // cobrando almacenamiento, o peor, un objeto incompleto en el bucket.
    await up.abort().catch(() => {})
    estadoSubida.actual = null
    sync()
    throw e
  }

  const resumen = rip.resumen({ destino: `s3://${S3.bucket}/${prefijo}`, prefijo_s3: prefijo, carpeta })

  // vista previa de 1 minuto: el MPEG-1 no lo reproduce ningun navegador,
  // asi que se sube un MP4 corto al lado. Si falla, no pasa nada.
  try {
    onEvent({ type: 'previa:inicio' })
    const mp4 = await vistaPreviaDesdeMuestra(Buffer.concat(muestra))
    if (mp4) {
      await client.send(
        new PutObjectCommand({
          Bucket: S3.bucket,
          Key: `${prefijo}/${ARCHIVO_PREVIA}`,
          Body: mp4,
          ContentType: 'video/mp4',
          StorageClass: S3.storageClass,
        }),
      )
      resumen.vista_previa = ARCHIVO_PREVIA
      await guardarMarcaPrevia(prefijo, SALIDA, resumen.bytes_totales).catch(() => {})
    } else if (!(await hayFfmpeg())) {
      resumen.vista_previa = null
      resumen.nota_previa = 'sin ffmpeg: no se genero vista previa'
    }
  } catch (e) {
    resumen.nota_previa = `vista previa fallida: ${e.message}`
  } finally {
    onEvent({ type: 'previa:fin' })
  }

  // manifiesto y marca de identidad, ya conociendo el sha256
  await client.send(
    new PutObjectCommand({
      Bucket: S3.bucket,
      Key: `${prefijo}/manifest.json`,
      Body: JSON.stringify(resumen, null, 2),
      ContentType: 'application/json',
    }),
  )
  await client
    .send(
      new PutObjectCommand({
        Bucket: S3.bucket,
        Key: `${prefijo}/.id-${idContenido(resumen)}`,
        Body: '',
      }),
    )
    .catch(() => {})

  estadoSubida.actual = null
  estadoSubida.completados.unshift({
    label: disc.label,
    prefijo,
    motivo: 'directo',
    archivos: 2,
    bytes: resumen.bytes_totales,
    segundos: resumen.duracion_seg,
  })
  sync()

  onEvent({ type: 'disc:done', ...resumen })
  return resumen
}

// -------------------------------------------------------------- descarga

/**
 * Lista los discos que hay en S3, agrupados por carpeta.
 * Requiere s3:ListBucket (ya lo tiene) y, para descargar, s3:GetObject.
 */
async function listarS3() {
  const carpetas = new Map()
  let token

  do {
    const r = await client.send(
      new ListObjectsV2Command({
        Bucket: S3.bucket,
        Prefix: `${S3.prefix}/`,
        ContinuationToken: token,
      }),
    )
    for (const o of r.Contents || []) {
      const resto = o.Key.slice(S3.prefix.length + 1)
      const corte = resto.indexOf('/')
      if (corte < 0) continue
      const carpeta = resto.slice(0, corte)
      const archivo = resto.slice(corte + 1)
      if (!archivo) continue
      if (archivo.startsWith('.') && !archivo.startsWith(PREFIJO_MARCA_PREVIA)) continue

      if (!carpetas.has(carpeta))
        carpetas.set(carpeta, {
          carpeta,
          bytes: 0,
          archivos: [],
          previa: null,
          previaEn: null,
          marcasPrevia: new Set(),
          subido: null,
        })
      const c = carpetas.get(carpeta)

      if (archivo.startsWith(PREFIJO_MARCA_PREVIA)) {
        c.marcasPrevia.add(archivo)
        continue
      }

      // la vista previa se expone aparte: no es un archivo para descargar
      if (archivo === ARCHIVO_PREVIA) {
        c.previa = o.Key
        c.previaEn = o.LastModified ? new Date(o.LastModified).toISOString() : null
        continue
      }
      if (!VIDEO_RE.test(archivo)) continue // fuera manifest.json

      c.bytes += o.Size || 0
      c.archivos.push({ nombre: archivo, key: o.Key, bytes: o.Size || 0 })
      const cuando = o.LastModified ? new Date(o.LastModified).toISOString() : null
      if (cuando && (!c.subido || cuando > c.subido)) c.subido = cuando
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)

  return [...carpetas.values()]
    .filter((c) => c.archivos.length)
    .map((c) => {
      c.archivos.sort((a, b) => b.bytes - a.bytes)
      return c
    })
    .sort(porReciente)
}

function tipoDeNombre(nombre) {
  const e = String(nombre).toLowerCase()
  if (e.endsWith('.mp4') || e.endsWith('.m4v')) return 'video/mp4'
  if (e.endsWith('.mpg') || e.endsWith('.mpeg')) return 'video/mpeg'
  if (e.endsWith('.mov')) return 'video/quicktime'
  if (e.endsWith('.avi')) return 'video/x-msvideo'
  if (e.endsWith('.mkv')) return 'video/x-matroska'
  if (e.endsWith('.wmv')) return 'video/x-ms-wmv'
  return 'application/octet-stream'
}

function rutaLocalSegura(key) {
  if (!key?.startsWith(LOCAL)) return null
  const rel = key.slice(LOCAL.length)
  if (!rel || rel.includes('\0') || rel.split('/').includes('..')) throw new Error('clave inválida')
  const abs = resolve(OUT_DIR, rel)
  const raiz = resolve(OUT_DIR)
  const relSeguro = relative(raiz, abs)
  if (relSeguro.startsWith('..') || resolve(raiz, relSeguro) !== abs) throw new Error('clave inválida')
  return abs
}

async function listarLocales() {
  let dirs
  try {
    dirs = await readdir(OUT_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dest = join(OUT_DIR, d.name)
    // La identidad es el nombre del directorio, no la etiqueta del disco:
    // varios CDs de fábrica traen el mismo rótulo (MUVEE060510) y cada uno
    // vive en su propia carpeta (…, MUVEE060510 (2), …).
    let subido = null
    try {
      const man = JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8'))
      if (man.ripeado_en) subido = man.ripeado_en
    } catch {
      /* carpeta sin manifiesto: se usa el nombre del directorio */
    }
    const files = await readdir(dest).catch(() => [])
    const item = { carpeta: d.name, bytes: 0, archivos: [], previa: null, subido }
    for (const f of files) {
      if (f.startsWith('.')) continue
      const st = await stat(join(dest, f)).catch(() => null)
      if (!st?.isFile()) continue
      const key = `${LOCAL}${d.name}/${f}`
      if (f === ARCHIVO_PREVIA) {
        item.previa = key
        continue
      }
      if (!VIDEO_RE.test(f)) continue
      item.bytes += st.size
      item.archivos.push({ nombre: f, key, bytes: st.size })
      const cuando = st.mtime?.toISOString?.()
      if (cuando && (!item.subido || cuando > item.subido)) item.subido = cuando
    }
    if (item.archivos.length) {
      item.archivos.sort((a, b) => b.bytes - a.bytes)
      if (!item.previa) {
        const origen = join(dest, item.archivos[0].nombre)
        const previaRuta = join(dest, ARCHIVO_PREVIA)
        try {
          if (await generarVistaPrevia(origen, previaRuta)) item.previa = `${LOCAL}${d.name}/${ARCHIVO_PREVIA}`
        } catch (e) {
          console.warn(`  no se pudo generar vista previa de ${origen}: ${e.message || e}`)
        }
      }
      out.push(item)
    }
  }
  return out
}

const colaPreviasS3 = []
const previaEnCola = new Set()
const previaHecha = new Set()
const previaFallida = new Set()
let regenerandoPrevias = false

function idPreviaS3(item) {
  const v = item?.archivos?.[0]
  return `${item.carpeta}\0${v?.nombre || ''}\0${v?.bytes || 0}`
}

function encolarPreviaS3(item) {
  if (!client || SOLO_LOCAL || DEMO || !item?.archivos?.[0]) return
  const id = idPreviaS3(item)
  if (previaHecha.has(id) || previaFallida.has(item.carpeta) || previaEnCola.has(id)) return
  previaEnCola.add(id)
  colaPreviasS3.push(item)
  void drenarPreviasS3()
}

async function drenarPreviasS3() {
  if (regenerandoPrevias) return
  regenerandoPrevias = true
  while (colaPreviasS3.length) {
    const item = colaPreviasS3.shift()
    const id = idPreviaS3(item)
    try {
      const ok = await regenerarPreviaS3(item)
      if (ok) previaHecha.add(id)
      else previaFallida.add(item.carpeta)
    } catch (e) {
      previaFallida.add(item.carpeta)
      console.warn(`  no se pudo reconstruir vista previa de ${item.carpeta}: ${e.message || e}`)
    } finally {
      previaEnCola.delete(id)
    }
  }
  regenerandoPrevias = false
}

/**
 * Arma vista-previa.mp4 con los primeros MB del video de ESA carpeta en S3.
 * Asi se corrigen clips que se copiaron de otro disco con el mismo rótulo.
 */
async function regenerarPreviaS3(item) {
  if (!(await hayFfmpeg())) return false
  const video = item.archivos[0]
  const n = Math.min(video.bytes || BYTES_MUESTRA_GRANDE, BYTES_MUESTRA_GRANDE)
  if (n < 10000) return false

  const r = await client.send(
    new GetObjectCommand({
      Bucket: S3.bucket,
      Key: video.key,
      Range: `bytes=0-${n - 1}`,
    }),
  )
  const muestra = await leerCuerpo(r.Body)
  const mp4 = await vistaPreviaDesdeMuestra(muestra, extname(video.nombre) || '.mpg')
  if (!mp4) throw new Error('ffmpeg no pudo cortar el clip')

  const prefijo = `${S3.prefix}/${item.carpeta}`
  await client.send(
    new PutObjectCommand({
      Bucket: S3.bucket,
      Key: `${prefijo}/${ARCHIVO_PREVIA}`,
      Body: mp4,
      ContentType: 'video/mp4',
      StorageClass: S3.storageClass,
    }),
  )
  await guardarMarcaPrevia(prefijo, video.nombre, video.bytes)
  console.log(`  vista previa reconstruida: ${item.carpeta}`)
  return true
}

function localDe(c, locPorCarpeta) {
  return locPorCarpeta.get(c.carpeta.toLowerCase()) || null
}

function masReciente(a, b) {
  if (!a) return b || null
  if (!b) return a
  return a >= b ? a : b
}

function porReciente(a, b) {
  const da = Date.parse(a.subido || 0) || 0
  const db = Date.parse(b.subido || 0) || 0
  if (db !== da) return db - da
  return a.carpeta.localeCompare(b.carpeta)
}

function fusionar(nube, locales) {
  const locPorCarpeta = new Map(locales.map((l) => [l.carpeta.toLowerCase(), l]))
  const cubiertos = new Set()

  const mezclados = nube.map((c) => {
    const loc = localDe(c, locPorCarpeta)
    if (loc) cubiertos.add(loc)
    const resto = { ...c }
    delete resto.marcasPrevia
    let previa = c.previa
    const marcada = previaDeEsteVideo(c)
    if (!marcada) {
      if (esCopiaConSufijo(c.carpeta) || !previa) encolarPreviaS3(c)
      // Las copias MUVEE060510 (2), (3)… pueden tener el clip del disco
      // anterior. No se muestra hasta reconstruirla del video de ESTA carpeta.
      if (esCopiaConSufijo(c.carpeta)) previa = null
    } else if (!previa && loc?.previa) {
      previa = loc.previa
      subirPreviaSiFalta(c, loc.previa)
    }
    return { ...resto, previa, subido: masReciente(c.subido, loc?.subido) }
  })

  const extra = locales.filter((l) => !cubiertos.has(l))
  return [...mezclados, ...extra].sort(porReciente)
}

/** Si el clip se genero al listar, copiarlo al bucket en segundo plano. */
function subirPreviaSiFalta(nubeItem, previaLocal) {
  if (!client || SOLO_LOCAL || DEMO || !nubeItem?.carpeta || !previaLocal) return
  let ruta
  try {
    ruta = rutaLocalSegura(previaLocal)
  } catch {
    return
  }
  if (!ruta) return
  const key = `${S3.prefix}/${nubeItem.carpeta}/${ARCHIVO_PREVIA}`
  readFile(ruta)
    .then((Body) =>
      client.send(
        new PutObjectCommand({
          Bucket: S3.bucket,
          Key: key,
          Body,
          ContentType: 'video/mp4',
          StorageClass: S3.storageClass,
        }),
      ),
    )
    .then(async () => {
      const video = nubeItem.archivos?.[0]
      if (video) await guardarMarcaPrevia(`${S3.prefix}/${nubeItem.carpeta}`, video.nombre, video.bytes)
      console.log(`  vista previa subida: ${key}`)
    })
    .catch((e) => console.warn(`  no se pudo subir vista previa (${key}): ${e.message || e}`))
}

/**
 * Lista discos en S3 y, en esta máquina, los que ya se copiaron a OUT_DIR.
 * Videos se llena desde S3: un ripeo local (DVD/datos) tardaba minutos en
 * aparecer porque la subida de varios GB va en segundo plano.
 */
export async function listarDiscos() {
  if (DEMO) return []
  const locales = await listarLocales()
  if (SOLO_LOCAL) return locales.sort(porReciente)

  let nube = []
  try {
    nube = await listarS3()
  } catch (e) {
    if (!locales.length) throw e
    return locales.sort(porReciente)
  }
  return fusionar(nube, locales)
}

async function abrirLocal(key, rango) {
  const ruta = rutaLocalSegura(key)
  if (!ruta) throw new Error('clave inválida')
  const { size } = await stat(ruta)
  const tipo = tipoDeNombre(ruta)
  if (!rango) {
    return { body: createReadStream(ruta), size, tipo, rango: null, total: size }
  }
  const m = String(rango).match(/bytes=(\d*)-(\d*)/i)
  let start = m?.[1] ? Number(m[1]) : 0
  let end = m?.[2] ? Number(m[2]) : size - 1
  if (!Number.isFinite(start) || start < 0) start = 0
  if (!Number.isFinite(end) || end >= size) end = size - 1
  if (start > end) start = 0
  const chunk = Math.max(0, end - start + 1)
  return {
    body: createReadStream(ruta, { start, end }),
    size: chunk,
    tipo,
    rango: `bytes ${start}-${end}/${size}`,
    total: size,
  }
}

/** Abre un objeto de S3 (o una copia local) para servirlo al navegador. */
export async function abrirDescarga(key) {
  if (key?.startsWith(LOCAL)) {
    const d = await abrirLocal(key, null)
    return { body: d.body, size: d.size, tipo: d.tipo }
  }
  const r = await client.send(new GetObjectCommand({ Bucket: S3.bucket, Key: key }))
  return { body: r.Body, size: r.ContentLength, tipo: r.ContentType }
}

/**
 * Igual que abrirDescarga pero pasando el Range del navegador a S3 (o al archivo local).
 * Sin esto el reproductor no puede adelantar ni retroceder el video.
 */
export async function abrirRango(key, rango) {
  if (key?.startsWith(LOCAL)) return abrirLocal(key, rango)
  const r = await client.send(
    new GetObjectCommand({ Bucket: S3.bucket, Key: key, Range: rango || undefined }),
  )
  return {
    body: r.Body,
    size: r.ContentLength,
    tipo: r.ContentType,
    rango: r.ContentRange || null,
    total: r.ContentRange ? Number(r.ContentRange.split('/')[1]) : r.ContentLength,
  }
}

// ---------------------------------------------------------------- borrado

/**
 * Borra un disco completo del bucket: video, vista previa, manifiesto y marca.
 *
 * El bucket NO tiene versionado, asi que esto es DEFINITIVO: no hay marcador
 * de borrado que deshacer. Si el disco original esta rayado o se perdio, ese
 * video no se recupera. Por eso el endpoint exige que se escriba el nombre.
 */
export async function borrarDisco(carpeta) {
  if (SOLO_LOCAL || DEMO) throw new Error('No hay bucket configurado.')

  const nombre = nombreS3(carpeta)
  const prefijo = `${S3.prefix}/${nombre}/`

  // se listan TODAS las claves de la carpeta: dejar huerfanos significa
  // pagar almacenamiento por archivos que nadie puede ver ni usar
  const claves = []
  let token
  do {
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: S3.bucket, Prefix: prefijo, ContinuationToken: token }),
    )
    for (const o of r.Contents || []) claves.push({ Key: o.Key })
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)

  if (!claves.length) return { borrados: 0, claves: [], noExistia: true }

  const errores = []
  // DeleteObjects acepta hasta 1000 por llamada
  for (let i = 0; i < claves.length; i += 1000) {
    const lote = claves.slice(i, i + 1000)
    const r = await client.send(
      new DeleteObjectsCommand({ Bucket: S3.bucket, Delete: { Objects: lote, Quiet: false } }),
    )
    for (const e of r.Errors || []) errores.push(`${e.Key}: ${e.Message}`)
  }

  if (errores.length) throw new Error(errores.join('; '))
  return { borrados: claves.length, claves: claves.map((c) => c.Key) }
}

/** Comprueba credenciales y acceso al bucket antes de ripear nada. */
export async function probarAcceso() {
  if (SOLO_LOCAL) return { ok: true, modo: 'solo-local' }
  const key = `${S3.prefix}/.prueba-acceso-${Date.now()}`
  try {
    const { PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await client.send(
      new PutObjectCommand({ Bucket: S3.bucket, Key: key, Body: 'ok', ChecksumAlgorithm: 'SHA256' }),
    )
    // borrar es opcional: si la politica no lo permite, no es un fallo
    try {
      await client.send(new DeleteObjectCommand({ Bucket: S3.bucket, Key: key }))
    } catch {}
    return { ok: true, bucket: S3.bucket, region: S3.region }
  } catch (e) {
    return { ok: false, error: String(e.message || e), bucket: S3.bucket }
  }
}
