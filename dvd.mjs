// Ingesta de DVD-Video: pista principal (VIDEO_TS) → MP4 H.264.
//
// No usa libdvdread: concatena los .VOB del titulo mas grande y recodifica
// con ffmpeg. Sirve para DVD caseros / autorados. Un DVD comercial con CSS
// suele fallar aqui (ffmpeg no desencripta); ese disco va a revision.
//
// El transcode escribe a disco local (ffmpeg no se streamea bien a S3).
// server.mjs encola la subida cuando no es SOLO_LOCAL.

import { createReadStream } from 'node:fs'
import { mkdir, readdir, writeFile, stat, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { slug, nombreS3 } from './vcd.mjs'
import { hayFfmpeg, ffmpegBin, generarVistaPrevia, ARCHIVO_PREVIA } from './preview.mjs'

const INTENTOS = 2

export function nombreSalidaDvd(label) {
  return `${nombreS3(label)}_completo.mp4`
}

function escaparConcat(ruta) {
  return `file '${String(ruta).replace(/'/g, "'\\''")}'`
}

function parseReloj(s) {
  const m = String(s || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return 0
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) | 0
}

/**
 * Agrupa VTS_nn_pp.VOB por titulo, ignora el _0 (menu) y elige el mas pesado.
 */
export async function pistaPrincipal(mount) {
  const raiz = await readdir(mount).catch(() => [])
  const videoTsNombre = raiz.find((n) => n.toUpperCase() === 'VIDEO_TS')
  if (!videoTsNombre) throw new Error('No se encontró VIDEO_TS en este disco')
  const videoTs = join(mount, videoTsNombre)

  const files = await readdir(videoTs)
  const titulos = new Map()
  for (const f of files) {
    const m = f.match(/^VTS_(\d+)_(\d+)\.VOB$/i)
    if (!m) continue
    const titulo = m[1]
    const parte = Number(m[2])
    if (parte === 0) continue // menu
    const ruta = join(videoTs, f)
    const size = await stat(ruta).then((s) => s.size).catch(() => 0)
    if (!titulos.has(titulo)) titulos.set(titulo, [])
    titulos.get(titulo).push({ archivo: f, ruta, parte, size })
  }

  let mejor = null
  for (const [titulo, partes] of titulos) {
    partes.sort((a, b) => a.parte - b.parte)
    const bytes = partes.reduce((a, p) => a + p.size, 0)
    if (!mejor || bytes > mejor.bytes) mejor = { titulo, partes, bytes }
  }
  if (!mejor?.partes.length) throw new Error('No hay pistas de video (VOB) en VIDEO_TS')
  return { videoTs, ...mejor }
}

async function sha256Archivo(ruta) {
  const hash = createHash('sha256')
  const rs = createReadStream(ruta)
  for await (const chunk of rs) hash.update(chunk)
  return hash.digest('hex')
}

/** ~6 Mbps: bitrate típico de DVD-Video. Sirve hasta que ffmpeg publique Duration. */
function estimarDuracionMs(bytes) {
  return Math.max(30_000, Math.round((Number(bytes) || 0) * 8 / 6_000_000 * 1000))
}

function transcodificar({ lista, salida, bytesOrigen, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-y',
      '-fflags', '+genpts',
      '-f', 'concat',
      '-safe', '0',
      '-i', lista,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-vf', 'yadif',
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', '160k',
      '-movflags', '+faststart',
      '-stats_period', '0.5',
      '-progress', 'pipe:1',
      salida,
    ]

    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let duracionMs = estimarDuracionMs(bytesOrigen)
    let stderr = ''
    let stdout = ''
    let ultimoAviso = 0

    const avisar = (outTime) => {
      if (!outTime && outTime !== 0) return
      const ahora = Date.now()
      if (ahora - ultimoAviso < 250) return
      ultimoAviso = ahora
      const tope = Math.max(duracionMs, outTime + 1000)
      const pct = Math.min(99, Math.floor((outTime / tope) * 100))
      const leidos = Math.min(bytesOrigen, Math.floor((bytesOrigen * outTime) / tope))
      onProgress({ pct, leidos, size: bytesOrigen })
    }

    const ingerirTiempo = (texto) => {
      const plano = String(texto).replace(/\r/g, '\n')
      for (const m of plano.matchAll(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/g)) {
        const ms = parseReloj(m[1])
        // concat a veces solo reporta el primer VOB: no acortar la estimacion
        if (ms > duracionMs) duracionMs = ms
      }
      const t = plano.match(/time=\s*(\d+:\d+:\d+(?:\.\d+)?)/)
      if (t) avisar(parseReloj(t[1]))
    }

    child.stderr.on('data', (buf) => {
      const t = buf.toString()
      stderr += t
      if (stderr.length > 8000) stderr = stderr.slice(-4000)
      ingerirTiempo(t)
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
 * Recodifica la pista principal a outDir/<slug>/<NOMBRE>_completo.mp4
 * + manifest.json y, si hay ffmpeg, vista-previa.mp4.
 */
export async function ripDvd(disc, outDir, onEvent = () => {}) {
  if (!(await hayFfmpeg())) {
    throw new Error('No está ffmpeg. En la Mac: brew install ffmpeg. En la app de escritorio debería venir empaquetado.')
  }

  const carpeta = slug(disc.label) || 'disco-sin-nombre'
  const dest = join(outDir, carpeta)
  const archivo = nombreSalidaDvd(disc.label)
  const ruta = join(dest, archivo)
  const lista = join(dest, '.concat-dvd.txt')

  // La UI tiene que pasar a "Copiando" ya, no esperar a terminar de listar VOB.
  onEvent({
    type: 'disc:start',
    label: disc.label,
    carpeta,
    destino: dest,
    total: 1,
    bytes: disc.totalBytes || 1,
  })

  const pista = await pistaPrincipal(disc.mount)
  await mkdir(dest, { recursive: true })

  onEvent({
    type: 'disc:start',
    label: disc.label,
    carpeta,
    destino: dest,
    total: 1,
    bytes: pista.bytes,
  })

  const t0 = Date.now()
  let ultimoError

  for (let intento = 1; intento <= INTENTOS; intento++) {
    if (intento > 1) onEvent({ type: 'disc:retry', intento, total: INTENTOS })
    await rm(ruta, { force: true })

    onEvent({
      type: 'file:start',
      index: 1,
      total: 1,
      archivo,
      leidos: 0,
      size: pista.bytes,
      pct: 0,
    })

    try {
      await writeFile(lista, pista.partes.map((p) => escaparConcat(p.ruta)).join('\n') + '\n')
      await transcodificar({
        lista,
        salida: ruta,
        bytesOrigen: pista.bytes,
        onProgress: (p) =>
          onEvent({
            type: 'file:progress',
            index: 1,
            total: 1,
            archivo,
            ...p,
          }),
      })

      const { size } = await stat(ruta)
      if (size < 10000) throw new Error('El MP4 quedó vacío; el disco puede estar dañado o protegido (CSS)')

      const sha256 = await sha256Archivo(ruta)
      onEvent({ type: 'file:done', index: 1, total: 1, archivo, bytes_origen: pista.bytes, bytes: size })

      let vistaPrevia = null
      try {
        onEvent({ type: 'previa:inicio' })
        const previaRuta = join(dest, ARCHIVO_PREVIA)
        if (await generarVistaPrevia(ruta, previaRuta)) vistaPrevia = ARCHIVO_PREVIA
      } catch {
        /* la previa es opcional */
      } finally {
        onEvent({ type: 'previa:fin' })
      }

      const resumen = {
        etiqueta_disco: disc.label,
        carpeta,
        destino: dest,
        formato_origen: 'DVD-Video (VIDEO_TS / MPEG-2)',
        kind: 'dvd',
        ripeado_en: new Date(t0).toISOString(),
        duracion_seg: Math.round((Date.now() - t0) / 1000),
        archivo,
        bytes_totales: size,
        sha256,
        fragmentos: pista.partes.map((p, i) => ({
          origen: p.archivo,
          orden: i + 1,
          bytes_origen: p.size,
        })),
        errores: [],
        ok: true,
        vista_previa: vistaPrevia,
        titulo_vts: pista.titulo,
        intentos: intento,
      }
      await writeFile(join(dest, 'manifest.json'), JSON.stringify(resumen, null, 2))
      await rm(lista, { force: true })
      onEvent({ type: 'disc:done', ...resumen })
      return resumen
    } catch (e) {
      ultimoError = e
      await rm(ruta, { force: true })
      onEvent({ type: 'file:error', index: 1, total: 1, origen: archivo, error: String(e.message || e) })
    }
  }

  await rm(lista, { force: true })
  throw ultimoError
}
