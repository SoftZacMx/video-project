// Slideshow de fotos de un disco de datos → MP4 H.264.
//
// El portal solo sabe mostrar video. Un CD/DVD de JPEG no se copia como
// galeria: se arma un video de diapositivas (3 s por foto) para que el
// operador y Videos lo traten igual que el resto.
//
// No recorre el disco: data.mjs lista las fotos y llama crearSlideshow.

import { mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, extname, join } from 'node:path'
import { nombreS3 } from './vcd.mjs'
import { hayFfmpeg, ffmpegBin } from './preview.mjs'
import { copiarArchivo } from './copia.mjs'

export const FOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp'])
export const MIN_FOTO_BYTES = 8 * 1024
export const MAX_FOTOS = 500
export const SEGUNDOS_POR_FOTO = 3

export function esFoto(nombre) {
  return FOTO_EXT.has(extname(nombre).toLowerCase())
}

export function nombreSalidaFotos(label) {
  return `${nombreS3(label)}_fotos.mp4`
}

function escaparConcat(ruta) {
  return `file '${String(ruta).replace(/'/g, "'\\''")}'`
}

function parseReloj(s) {
  const m = String(s || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return 0
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) | 0
}

function listaConcat(rutas) {
  const lineas = []
  for (let i = 0; i < rutas.length; i++) {
    lineas.push(escaparConcat(rutas[i]))
    lineas.push(`duration ${SEGUNDOS_POR_FOTO}`)
  }
  // concat demuxer: el ultimo archivo hay que repetirlo sin duration
  lineas.push(escaparConcat(rutas[rutas.length - 1]))
  return lineas.join('\n') + '\n'
}

async function copiar(src, dest) {
  await copiarArchivo(src, dest)
}

function transcodificar({ lista, salida, duracionMs, bytesEst, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      lista,
      '-vf',
      'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=25,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-an',
      '-movflags',
      '+faststart',
      '-stats_period',
      '0.5',
      '-progress',
      'pipe:1',
      salida,
    ]

    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    let ultimoAviso = 0
    let tope = Math.max(duracionMs, 1000)

    const avisar = (outTime) => {
      if (!outTime && outTime !== 0) return
      const ahora = Date.now()
      if (ahora - ultimoAviso < 250) return
      ultimoAviso = ahora
      tope = Math.max(tope, outTime + 1000)
      const pct = Math.min(99, Math.floor((outTime / tope) * 100))
      const leidos = Math.min(bytesEst, Math.floor((bytesEst * outTime) / tope))
      onProgress({ pct, leidos, size: bytesEst })
    }

    child.stderr.on('data', (buf) => {
      const t = buf.toString()
      stderr += t
      if (stderr.length > 8000) stderr = stderr.slice(-4000)
      const m = t.replace(/\r/g, '\n').match(/time=\s*(\d+:\d+:\d+(?:\.\d+)?)/)
      if (m) avisar(parseReloj(m[1]))
    })

    child.stdout.on('data', (buf) => {
      stdout += buf.toString().replace(/\r/g, '\n')
      const lineas = stdout.split('\n')
      stdout = lineas.pop() || ''
      let outTime = null
      for (const ln of lineas) {
        if (ln.startsWith('out_time=')) outTime = parseReloj(ln.slice(9))
      }
      if (outTime != null) avisar(outTime)
    })

    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const cola = stderr.trim().split('\n').slice(-6).join(' · ')
        reject(new Error(cola || `ffmpeg salió con código ${code}`))
      }
    })
  })
}

/**
 * Copia las fotos a un tmp local y las recodifica a `salida` (MP4).
 * `fotos` es [{ origen, relativo, nombre, size }, ...] ya ordenado.
 */
export async function crearSlideshow(fotos, salida, onProgress = () => {}) {
  if (!fotos?.length) throw new Error('No hay fotos para armar el video')
  if (!(await hayFfmpeg())) {
    throw new Error('No está ffmpeg. Hace falta para guardar las fotos como video.')
  }

  const usadas = fotos.slice(0, MAX_FOTOS)
  const destDir = dirname(salida)
  const tmp = join(destDir, '.fotos-src')
  const lista = join(destDir, '.fotos-concat.txt')
  const bytesEst = usadas.reduce((a, f) => a + f.size, 0) || 1

  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })

  const locales = []
  let copiados = 0
  let omitidasCopia = 0
  try {
    for (let i = 0; i < usadas.length; i++) {
      const f = usadas[i]
      const ext = extname(f.nombre) || '.jpg'
      const local = join(tmp, `${String(i + 1).padStart(4, '0')}${ext.toLowerCase()}`)
      try {
        await copiar(f.origen, local)
        locales.push(local)
      } catch {
        omitidasCopia++
        await rm(local, { force: true })
      }
      copiados += f.size
      onProgress({
        fase: 'copia',
        pct: Math.min(50, Math.floor((copiados / bytesEst) * 50)),
        leidos: copiados,
        size: bytesEst,
      })
    }

    if (!locales.length) {
      throw new Error('No se pudo leer ninguna foto. El disco está sucio, rayado o dañado.')
    }

    await writeFile(lista, listaConcat(locales))
    const duracionMs = locales.length * SEGUNDOS_POR_FOTO * 1000
    await transcodificar({
      lista,
      salida,
      duracionMs,
      bytesEst,
      onProgress: (p) =>
        onProgress({
          fase: 'encode',
          pct: 50 + Math.min(49, Math.floor((p.pct / 100) * 49)),
          leidos: p.leidos,
          size: p.size,
        }),
    })

    const { size } = await stat(salida)
    if (size < 10000) throw new Error('El video de fotos quedó vacío')
    return {
      archivo: salida,
      bytes: size,
      fotos_usadas: locales.length,
      fotos_omitidas: Math.max(0, fotos.length - usadas.length) + omitidasCopia,
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
    await rm(lista, { force: true })
  }
}
