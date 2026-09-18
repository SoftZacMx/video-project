// Ingesta de disco de datos optico.
//
// No es DVD-Video ni VCD: son archivos sueltos (un .mpg de 4 GB de vacaciones,
// varios .avi, etc.). Se COPIAN tal cual, sin recodificar. El disco es de
// solo lectura; se escribe en el Mac / S3.
//
// Si hay fotos (JPEG/PNG/…) y no hay video, se arma un MP4 de diapositivas.
// Si hay ambos, se copian los videos y se agrega el slideshow aparte.

import { createReadStream } from 'node:fs'
import { mkdir, readdir, writeFile, stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, extname } from 'node:path'
import { slug, nombreS3 } from './vcd.mjs'
import { hayFfmpeg, generarVistaPrevia, ARCHIVO_PREVIA } from './preview.mjs'
import { esFoto, MIN_FOTO_BYTES, crearSlideshow, nombreSalidaFotos } from './fotos.mjs'
import { copiarArchivo } from './copia.mjs'

const VIDEO_EXT = new Set(['.mpg', '.mpeg', '.mp4', '.avi', '.mov', '.m4v', '.mkv', '.wmv', '.m2ts', '.mts'])
const SKIP_DIR = new Set([
  'VIDEO_TS',
  'AUDIO_TS',
  'MPEGAV',
  'BDMV',
  'OPENDVD',
  'SEGMENT',
  'CDI',
  'VCD',
  '.TRASHES',
  '.FSEVENTSD',
  '.SPOTLIGHT-V100',
])
const MIN_BYTES = 64 * 1024

function esVideo(nombre) {
  return VIDEO_EXT.has(extname(nombre).toLowerCase())
}

function entrada(ruta, raiz, name, size) {
  return {
    origen: ruta,
    relativo: relative(raiz, ruta),
    nombre: name,
    size,
  }
}

async function recorrer(dir, raiz, videos, fotos) {
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('._')) continue
    if (SKIP_DIR.has(name.toUpperCase())) continue
    const ruta = join(dir, name)
    const st = await stat(ruta).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) await recorrer(ruta, raiz, videos, fotos)
    else if (st.isFile() && esVideo(name) && st.size >= MIN_BYTES) {
      videos.push(entrada(ruta, raiz, name, st.size))
    } else if (st.isFile() && esFoto(name) && st.size >= MIN_FOTO_BYTES) {
      fotos.push(entrada(ruta, raiz, name, st.size))
    }
  }
}

/** Videos y fotos del volumen. Videos: mas grandes primero. Fotos: por ruta. */
export async function listarMediosDatos(mount) {
  const videos = []
  const fotos = []
  await recorrer(mount, mount, videos, fotos)
  videos.sort((a, b) => b.size - a.size || a.relativo.localeCompare(b.relativo))
  fotos.sort((a, b) =>
    a.relativo.localeCompare(b.relativo, undefined, { numeric: true, sensitivity: 'base' }),
  )
  return { videos, fotos }
}

/** Videos en el volumen, mas grandes primero. */
export async function listarVideosDatos(mount) {
  const { videos } = await listarMediosDatos(mount)
  return videos
}

function nombreDestino(relativo, usados) {
  const partes = relativo.split(/[/\\]/)
  const file = partes.pop() || 'video'
  const ext = extname(file)
  const stem = nombreS3(file.slice(0, file.length - ext.length) || file)
  const prefijo = partes.length ? `${nombreS3(partes.join('-'))}-` : ''
  let candidato = `${prefijo}${stem}${ext}`
  let n = 2
  while (usados.has(candidato.toLowerCase())) {
    candidato = `${prefijo}${stem}-${n}${ext}`
    n++
  }
  usados.add(candidato.toLowerCase())
  return candidato
}

async function sha256Archivo(ruta) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(ruta)) hash.update(chunk)
  return hash.digest('hex')
}

async function copiarConProgreso(src, dest, size, onBytes) {
  const copiados = await copiarArchivo(src, dest, onBytes)
  onBytes(size || copiados)
}

/**
 * Copia los videos del volumen a outDir/<slug>/ + manifest.json.
 * Si hay fotos, arma un MP4 de diapositivas. La previa es del archivo mas grande.
 */
export async function ripDatos(disc, outDir, onEvent = () => {}) {
  const { videos, fotos } = await listarMediosDatos(disc.mount)
  if (!videos.length && !fotos.length) {
    throw new Error('No hay videos ni fotos en este disco (se buscan .mpg, .mp4, .jpg…).')
  }

  const carpeta = slug(disc.label) || 'disco-sin-nombre'
  const dest = join(outDir, carpeta)
  await mkdir(dest, { recursive: true })

  const pasos = videos.length + (fotos.length ? 1 : 0)
  const bytesVideos = videos.reduce((a, v) => a + v.size, 0)
  const bytesFotos = fotos.reduce((a, f) => a + f.size, 0)
  const totalBytes = bytesVideos + bytesFotos
  onEvent({
    type: 'disc:start',
    label: disc.label,
    carpeta,
    destino: dest,
    total: pasos,
    bytes: totalBytes || 1,
  })

  const t0 = Date.now()
  const usados = new Set()
  const copiados = []

  try {
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i]
      const archivo = nombreDestino(v.relativo, usados)
      const ruta = join(dest, archivo)

      onEvent({
        type: 'file:start',
        index: i + 1,
        total: pasos,
        archivo,
        leidos: 0,
        size: v.size,
        pct: 0,
      })

      await copiarConProgreso(v.origen, ruta, v.size, (leidos) => {
        onEvent({
          type: 'file:progress',
          index: i + 1,
          total: pasos,
          archivo,
          leidos,
          size: v.size,
          pct: v.size ? Math.min(100, Math.floor((leidos / v.size) * 100)) : 0,
        })
      })

      copiados.push({
        origen: v.relativo,
        archivo,
        bytes_origen: v.size,
        bytes: v.size,
        orden: i + 1,
      })
      onEvent({
        type: 'file:done',
        index: i + 1,
        total: pasos,
        archivo,
        bytes_origen: v.size,
        bytes: v.size,
      })
    }

    if (fotos.length) {
      const archivo = nombreSalidaFotos(disc.label)
      usados.add(archivo.toLowerCase())
      const ruta = join(dest, archivo)
      const index = videos.length + 1
      onEvent({
        type: 'file:start',
        index,
        total: pasos,
        archivo,
        leidos: 0,
        size: bytesFotos || 1,
        pct: 0,
      })

      const slide = await crearSlideshow(fotos, ruta, (p) => {
        onEvent({
          type: 'file:progress',
          index,
          total: pasos,
          archivo,
          leidos: p.leidos,
          size: p.size,
          pct: p.pct,
        })
      })

      copiados.push({
        origen: `${fotos.length} foto(s)`,
        archivo,
        bytes_origen: bytesFotos,
        bytes: slide.bytes,
        orden: index,
        fotos_usadas: slide.fotos_usadas,
        fotos_omitidas: slide.fotos_omitidas,
      })
      onEvent({
        type: 'file:done',
        index,
        total: pasos,
        archivo,
        bytes_origen: bytesFotos,
        bytes: slide.bytes,
      })
    }
  } catch (e) {
    await rm(dest, { recursive: true, force: true })
    throw e
  }

  const principal = copiados[0]
  const sha256 = await sha256Archivo(join(dest, principal.archivo))

  let vistaPrevia = null
  try {
    onEvent({ type: 'previa:inicio' })
    const previaRuta = join(dest, ARCHIVO_PREVIA)
    if (await hayFfmpeg() && (await generarVistaPrevia(join(dest, principal.archivo), previaRuta))) {
      vistaPrevia = ARCHIVO_PREVIA
    }
  } catch {
    /* opcional */
  } finally {
    onEvent({ type: 'previa:fin' })
  }

  const hayVideo = videos.length > 0
  const hayFoto = fotos.length > 0
  const formato_origen = hayVideo && hayFoto
    ? 'Disco de datos (video + fotos como diapositivas)'
    : hayFoto
      ? 'Disco de datos (fotos como diapositivas)'
      : 'Disco de datos (copia de archivos de video)'

  const resumen = {
    etiqueta_disco: disc.label,
    carpeta,
    destino: dest,
    formato_origen,
    kind: 'data',
    ripeado_en: new Date(t0).toISOString(),
    duracion_seg: Math.round((Date.now() - t0) / 1000),
    archivo: principal.archivo,
    bytes_totales: copiados.reduce((a, c) => a + (c.bytes || 0), 0),
    sha256,
    fragmentos: copiados,
    videos: copiados,
    errores: [],
    ok: true,
    vista_previa: vistaPrevia,
  }
  await writeFile(join(dest, 'manifest.json'), JSON.stringify(resumen, null, 2))
  onEvent({ type: 'disc:done', ...resumen })
  return resumen
}
