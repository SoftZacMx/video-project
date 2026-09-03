// Ingesta de disco de datos optico.
//
// No es DVD-Video ni VCD: son archivos sueltos (un .mpg de 4 GB de vacaciones,
// varios .avi, etc.). Se COPIAN tal cual, sin recodificar. El disco es de
// solo lectura; se escribe en el Mac / S3.
//
// Si no hay videos, se lanza error (el operador ve "disco danado" con un
// mensaje claro). Fotos sueltas no se respaldan en este corte.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, writeFile, stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, extname } from 'node:path'
import { once } from 'node:events'
import { slug, nombreS3 } from './vcd.mjs'
import { hayFfmpeg, generarVistaPrevia, ARCHIVO_PREVIA } from './preview.mjs'

const VIDEO_EXT = new Set(['.mpg', '.mpeg', '.mp4', '.avi', '.mov', '.m4v', '.mkv', '.wmv', '.m2ts', '.mts'])
const SKIP_DIR = new Set(['VIDEO_TS', 'AUDIO_TS', 'MPEGAV', 'BDMV', '.TRASHES', '.FSEVENTSD', '.SPOTLIGHT-V100'])
const MIN_BYTES = 64 * 1024

function esVideo(nombre) {
  return VIDEO_EXT.has(extname(nombre).toLowerCase())
}

async function recorrer(dir, raiz, acc) {
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('._')) continue
    if (SKIP_DIR.has(name.toUpperCase())) continue
    const ruta = join(dir, name)
    const st = await stat(ruta).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) await recorrer(ruta, raiz, acc)
    else if (st.isFile() && esVideo(name) && st.size >= MIN_BYTES) {
      acc.push({
        origen: ruta,
        relativo: relative(raiz, ruta),
        nombre: name,
        size: st.size,
      })
    }
  }
}

/** Videos en el volumen, mas grandes primero. */
export async function listarVideosDatos(mount) {
  const acc = []
  await recorrer(mount, mount, acc)
  acc.sort((a, b) => b.size - a.size || a.relativo.localeCompare(b.relativo))
  return acc
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
  await mkdir(dirname(dest), { recursive: true })
  const rs = createReadStream(src, { highWaterMark: 1024 * 1024 })
  const ws = createWriteStream(dest)
  let copiados = 0
  const tick = setInterval(() => onBytes(copiados), 250)
  try {
    rs.on('error', (e) => ws.destroy(e))
    for await (const chunk of rs) {
      copiados += chunk.length
      if (!ws.write(chunk)) await once(ws, 'drain')
    }
    ws.end()
    await once(ws, 'close')
    onBytes(size)
  } finally {
    clearInterval(tick)
  }
}

/**
 * Copia los videos del volumen a outDir/<slug>/ + manifest.json
 * y, si hay ffmpeg, vista-previa.mp4 del archivo mas grande.
 */
export async function ripDatos(disc, outDir, onEvent = () => {}) {
  const videos = await listarVideosDatos(disc.mount)
  if (!videos.length) {
    throw new Error('No hay videos en este disco (se buscan .mpg, .mp4, .avi, .mov…).')
  }

  const carpeta = slug(disc.label) || 'disco-sin-nombre'
  const dest = join(outDir, carpeta)
  await mkdir(dest, { recursive: true })

  const totalBytes = videos.reduce((a, v) => a + v.size, 0)
  onEvent({
    type: 'disc:start',
    label: disc.label,
    carpeta,
    destino: dest,
    total: videos.length,
    bytes: totalBytes,
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
        total: videos.length,
        archivo,
        leidos: 0,
        size: v.size,
        pct: 0,
      })

      await copiarConProgreso(v.origen, ruta, v.size, (leidos) => {
        onEvent({
          type: 'file:progress',
          index: i + 1,
          total: videos.length,
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
        total: videos.length,
        archivo,
        bytes_origen: v.size,
        bytes: v.size,
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

  const resumen = {
    etiqueta_disco: disc.label,
    carpeta,
    destino: dest,
    formato_origen: 'Disco de datos (copia de archivos de video)',
    kind: 'data',
    ripeado_en: new Date(t0).toISOString(),
    duracion_seg: Math.round((Date.now() - t0) / 1000),
    archivo: principal.archivo,
    bytes_totales: totalBytes,
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
