// Vista previa de 1 minuto en MP4/H.264.
//
// El video del disco (MPEG-1/2) NINGUN navegador lo reproduce, por eso hay
// que recodificar. Se genera en la Mac y se sube a S3 junto al video;
// el portal en la nube solo la sirve (no necesita ffmpeg).
//
// En archivos grandes (un .mpg de varios GB) ffmpeg NO debe abrir el archivo
// entero: se limita probesize y, si falla, se corta el clip de los primeros MB
// (igual que en el VCD). Si no esta ffmpeg, el ripeo sigue sin previa.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { open, writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

/**
 * Electron pone FFMPEG_PATH. Con `npm start` no hay ffmpeg en PATH:
 * se usa el binario de ffmpeg-static (ya es dependencia del proyecto).
 */
function candidatosFfmpeg() {
  const out = []
  if (process.env.FFMPEG_PATH) out.push(process.env.FFMPEG_PATH)
  try {
    const empaquetado = require('ffmpeg-static')
    if (empaquetado) out.push(empaquetado)
  } catch {
    /* paquete ausente */
  }
  out.push('ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg')
  return [...new Set(out)]
}

let binario = null

/** Ruta resuelta; llamar despues de hayFfmpeg(). */
export function ffmpegBin() {
  return binario || process.env.FFMPEG_PATH || 'ffmpeg'
}

export const ARCHIVO_PREVIA = 'vista-previa.mp4'

/** Segundos de clip. */
const DURACION = 60

/** Desde que segundo cortar: estos discos suelen abrir en negro o con menu. */
const DESDE = 10

/**
 * Bytes del inicio del video para armar el clip sin leer el archivo entero.
 * Un VCD va a ~1.4 Mbps (~10.5 MB/min). Un MPEG de vacaciones en DVD-R puede
 * ir a ~8 Mbps: 48 MB cubren ~50 s, bastante para un minuto con margen.
 */
export const BYTES_MUESTRA = 24 * 1024 * 1024
const BYTES_MUESTRA_GRANDE = 48 * 1024 * 1024

let disponible = null

export async function hayFfmpeg() {
  if (disponible !== null) return disponible
  for (const cand of candidatosFfmpeg()) {
    try {
      await run(cand, ['-version'], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 })
      binario = cand
      process.env.FFMPEG_PATH = cand
      disponible = true
      console.log(`  ffmpeg: ${cand}`)
      return true
    } catch {
      /* probar el siguiente */
    }
  }
  disponible = false
  return false
}

function argsClip(desde, entrada, salida, formato) {
  const args = [
    '-nostdin',
    '-y',
    '-probesize', '4M',
    '-analyzeduration', '4000000',
  ]
  if (formato) args.push('-f', formato)
  args.push(
    '-ss', String(desde),
    '-i', entrada,
    '-t', String(DURACION),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-vf', 'yadif,scale=480:-2',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    salida,
  )
  return args
}

async function recortar(entrada, salida, formato) {
  for (const desde of [DESDE, 0]) {
    try {
      await run(ffmpegBin(), argsClip(desde, entrada, salida, formato), { timeout: 120000 })
      const { size } = await stat(salida)
      if (size > 10000) return true
    } catch {
      await unlink(salida).catch(() => {})
    }
  }
  return false
}

async function leerInicio(ruta, max) {
  const fh = await open(ruta, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, max))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Corta un clip de DURACION segundos y lo devuelve como MP4 en memoria.
 * `muestra` son los primeros bytes del video (VCD u otro MPEG).
 */
export async function vistaPreviaDesdeMuestra(muestra) {
  if (!muestra?.length || !(await hayFfmpeg())) return null

  const base = join(tmpdir(), `prev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const orig = `${base}.mpg`
  const mp4 = `${base}.mp4`

  try {
    await writeFile(orig, muestra)
    if (await recortar(orig, mp4, 'mpeg')) return await readFile(mp4)
    if (await recortar(orig, mp4)) return await readFile(mp4)
    return null
  } catch {
    return null
  } finally {
    await unlink(orig).catch(() => {})
    await unlink(mp4).catch(() => {})
  }
}

/**
 * Clip de 1 minuto a partir de un archivo en disco (DVD MP4 o .mpg grande).
 * Primero intenta un seek ligero; si ffmpeg se atasca, usa solo el inicio.
 */
export async function generarVistaPrevia(origen, destino) {
  if (!origen || !(await hayFfmpeg())) return null

  const { size } = await stat(origen).catch(() => ({ size: 0 }))
  // Un .mpg de varios GB: no invocar ffmpeg sobre el archivo entero.
  if (size && size < 80 * 1024 * 1024) {
    if (await recortar(origen, destino)) return destino
  }

  try {
    const n = Math.min(size || BYTES_MUESTRA_GRANDE, BYTES_MUESTRA_GRANDE)
    if (n < 10000) return null
    const buf = await vistaPreviaDesdeMuestra(await leerInicio(origen, n))
    if (!buf) return null
    await writeFile(destino, buf)
    return destino
  } catch {
    await unlink(destino).catch(() => {})
    return null
  }
}
