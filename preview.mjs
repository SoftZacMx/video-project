// Vista previa de 1 minuto en MP4/H.264.
//
// El video del disco es MPEG-1 y NINGUN navegador lo reproduce, por eso hay
// que recodificar. Se genera aqui, en la Mac, y se sube a S3 junto al video;
// el portal en la nube solo la sirve (no necesita ffmpeg).
//
// Requiere ffmpeg (brew install ffmpeg). Si no esta, no se genera nada y el
// ripeo sigue normal: la vista previa es una comodidad, no un requisito.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const run = promisify(execFile)

/**
 * En la app de escritorio ffmpeg viene empaquetado y el proceso principal de
 * Electron pasa su ruta por FFMPEG_PATH. Corriendo con `npm start` se usa el
 * del sistema (brew install ffmpeg).
 */
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

export const ARCHIVO_PREVIA = 'vista-previa.mp4'

/** Segundos de clip. */
const DURACION = 60

/** Desde que segundo cortar: estos discos suelen abrir en negro o con menu. */
const DESDE = 10

/**
 * Bytes del inicio del video que hay que capturar para poder cortar el clip.
 * Un VCD va a ~1.4 Mbps (video 1.15 + audio 0.22), o sea ~10.5 MB por minuto.
 * Con 24 MB alcanzan de sobra los 70 s que necesitamos (DESDE + DURACION).
 */
export const BYTES_MUESTRA = 24 * 1024 * 1024

let disponible = null

export async function hayFfmpeg() {
  if (disponible !== null) return disponible
  try {
    await run(FFMPEG, ['-version'])
    disponible = true
  } catch {
    disponible = false
  }
  return disponible
}

/**
 * Corta un clip de DURACION segundos y lo devuelve como MP4 en memoria.
 * `muestra` son los primeros bytes del MPEG-1, capturados mientras subia.
 * Devuelve null si no se pudo (sin ffmpeg, muestra muy corta, etc).
 */
export async function vistaPreviaDesdeMuestra(muestra) {
  if (!muestra?.length || !(await hayFfmpeg())) return null

  const base = join(tmpdir(), `vcd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const mpg = `${base}.mpg`
  const mp4 = `${base}.mp4`

  try {
    await writeFile(mpg, muestra)

    // si el video es mas corto que DESDE, se corta desde el principio
    for (const desde of [DESDE, 0]) {
      try {
        await run(
          FFMPEG,
          [
            '-nostdin',
            '-y',
            '-ss', String(desde),
            '-i', mpg,
            '-t', String(DURACION),
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '26',
            // yadif: puede venir entrelazado y se veria "peinado"
            // no se escala hacia arriba: 352x240 ampliado solo infla el archivo
            '-vf', 'yadif,scale=480:-2',
            '-c:a', 'aac',
            '-b:a', '96k',
            // faststart: el navegador empieza a reproducir sin bajarlo todo
            '-movflags', '+faststart',
            mp4,
          ],
          { timeout: 180000 },
        )
        const { size } = await stat(mp4)
        if (size > 10000) return await readFile(mp4)
      } catch {
        // ese punto de corte no existe: se prueba el siguiente
      }
    }
    return null
  } catch {
    return null
  } finally {
    await unlink(mpg).catch(() => {})
    await unlink(mp4).catch(() => {})
  }
}
