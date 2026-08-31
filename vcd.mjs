// Nucleo del ripeador de Video CD.
// No imprime nada: reporta todo por el callback onEvent para que lo consuma
// quien quiera (servidor web, CLI, tests).
// Cero dependencias: solo modulos nativos de Node.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, writeFile, stat, rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const run = promisify(execFile)

export const SECTOR = 2352 // sector de CD Mode 2 Form 2
const PAYLOAD_OFF = 24 // 12 sync + 4 header + 8 subheader
const PAYLOAD_LEN = 2324 // datos utiles por sector

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function slug(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export async function notify(title, msg, sound = 'Glass') {
  const esc = (s) => String(s).replace(/["\\]/g, '')
  try {
    await run('osascript', [
      '-e',
      `display notification "${esc(msg)}" with title "${esc(title)}" sound name "${esc(sound)}"`,
    ])
  } catch {
    /* una notificacion fallida nunca debe tumbar el ripeo */
  }
}

// ------------------------------------------------- desempaquetador RIFF CDXA

/**
 * Convierte un .DAT de VCD (RIFF CDXA) en MPEG-1 program stream limpio.
 * Quita la cabecera RIFF, las cabeceras de cada sector y los sectores de
 * relleno del arranque, hasta el primer pack header (00 00 01 BA).
 * NO recodifica: los bytes de video y audio salen identicos al original.
 */
export class CdxaUnwrap extends Transform {
  constructor() {
    super()
    this.buf = Buffer.alloc(0)
    this.headerDone = false
    this.started = false
    this.passthrough = false
    this.sectors = 0
    this.skipped = 0
    this.inBytes = 0
  }

  _transform(chunk, _enc, cb) {
    this.inBytes += chunk.length
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk

    if (!this.headerDone) {
      if (this.buf.length < 44) return cb()
      const isRiff = this.buf.subarray(0, 4).toString('latin1') === 'RIFF'
      const isCdxa = this.buf.subarray(8, 12).toString('latin1') === 'CDXA'
      if (isRiff && isCdxa) this.buf = this.buf.subarray(44)
      else this.passthrough = true // algunos VCD traen MPEG directo
      this.headerDone = true
    }

    if (this.passthrough) {
      this.push(this.buf)
      this.buf = Buffer.alloc(0)
      return cb()
    }

    const out = []
    let off = 0
    while (this.buf.length - off >= SECTOR) {
      const p = this.buf.subarray(off + PAYLOAD_OFF, off + PAYLOAD_OFF + PAYLOAD_LEN)
      off += SECTOR
      if (!this.started) {
        if (p[0] === 0x00 && p[1] === 0x00 && p[2] === 0x01 && p[3] === 0xba) this.started = true
        else {
          this.skipped++
          continue
        }
      }
      this.sectors++
      out.push(Buffer.from(p))
    }
    this.buf = this.buf.subarray(off) // conserva el sector parcial
    if (out.length) this.push(Buffer.concat(out))
    cb()
  }

  _flush(cb) {
    if (this.passthrough && this.buf.length) this.push(this.buf)
    cb()
  }
}

// ----------------------------------------------------------- deteccion disco

/** Busca en /Volumes un disco con MPEGAV/AVSEQ*.DAT. null si no hay. */
export async function findVcd() {
  let vols
  try {
    vols = await readdir('/Volumes')
  } catch {
    return null
  }
  for (const v of vols) {
    const mount = join('/Volumes', v)
    try {
      const st = await stat(mount)
      if (!st.isDirectory()) continue // ignora el symlink Macintosh HD
      const files = await readdir(join(mount, 'MPEGAV'))
      const dats = files.filter((f) => /^AVSEQ\d+\.DAT$/i.test(f)).sort()
      if (dats.length) {
        const sizes = await Promise.all(
          dats.map((d) =>
            stat(join(mount, 'MPEGAV', d))
              .then((s) => s.size)
              .catch(() => 0),
          ),
        )
        return { label: v, mount, dats, totalBytes: sizes.reduce((a, b) => a + b, 0) }
      }
    } catch {
      continue // no es un VCD
    }
  }
  return null
}

/**
 * Estado del lector optico, independiente de si macOS logro montar el disco.
 *
 * Es la diferencia entre "no hay disco" y "hay un disco que no se puede leer".
 * Sin esto, un disco rayado deja la pantalla en "Esperando disco" para siempre
 * y el operador no sabe si la herramienta se colgo o el disco esta malo.
 */
export async function estadoLector() {
  try {
    const { stdout } = await run('drutil', ['status'])

    // Sin lector conectado, drutil sale con exito pero NO imprime nada.
    // Hay que exigir una linea "Type:" para afirmar que hay disco; asumir
    // lo contrario hacia que la UI reportara un disco inexistente.
    const lector = /Vendor|Type:/i.test(stdout)
    const tipo = stdout.match(/Type:\s*(.+)/)?.[1]?.trim()

    if (!lector || !tipo || /No Media Inserted/i.test(tipo)) {
      return { lector, hayDisco: false }
    }
    return { lector: true, hayDisco: true, tipo }
  } catch {
    // drutil no disponible (no deberia pasar en macOS)
    return { lector: false, hayDisco: false }
  }
}

/** Cuantos intentos de lectura antes de mandar el disco a revision. */
export const INTENTOS_LECTURA = 3

export async function eject(mount) {
  try {
    await run('diskutil', ['eject', mount])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0] }
  }
}

// ----------------------------------------------------------------- ripeo

// ------------------------------------------------------------------ nombres
//
// Los videos de un disco se unen en UN solo archivo: la particion en
// AVSEQ01/02/03 es un artefacto del software de autoria, y el reproductor los
// pasa seguidos como un video unico. Como la union es concatenacion pura de
// bytes (el MPEG-1 program stream lo permite), el manifiesto guarda el rango
// de bytes de cada fragmento y se pueden volver a separar sin perdida.

/**
 * Nombre de carpeta/archivo derivado de la etiqueta del CD, tal cual, quitando
 * solo lo que rompe una clave de S3 o un nombre de archivo. Se conservan
 * mayusculas y acentos: el objetivo es que se llame como el disco.
 */
export function nombreS3(label) {
  return (
    String(label || '')
      .replace(/[/\\]/g, '-') // una barra crearia subcarpetas: se vuelve guion
      .replace(/[{}^%`[\]"<>~#|]/g, '') // resto de caracteres problematicos
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ') // colapsa los espacios dobles
      .trim()
      .replace(/^\.+|\.+$/g, '') // sin puntos al inicio/fin
      .slice(0, 200) || 'DISCO SIN NOMBRE'
  )
}

/** BRAYAN ALEXIS DE BEBE  ->  "BRAYAN ALEXIS DE BEBE_completo.mpg" */
export function nombreSalida(label) {
  return `${nombreS3(label)}_completo.mpg`
}

/**
 * Fuente unica del ripeo: un generador que emite los bytes del video unido
 * mientras registra offsets, hashes y errores.
 *
 * Lo consumen los dos modos (a disco local, o directo a S3) para que la
 * logica de offsets y hashes NO se duplique entre ellos.
 */
export function crearRipStream(disc, onEvent = () => {}) {
  const fragmentos = []
  const errores = []
  const hashTotal = createHash('sha256')
  const t0 = Date.now()
  let offset = 0

  async function* chunks() {
    for (let i = 0; i < disc.dats.length; i++) {
      const origen = disc.dats[i]
      const src = join(disc.mount, 'MPEGAV', origen)
      const { size } = await stat(src).catch(() => ({ size: 0 }))

      onEvent({ type: 'file:start', index: i + 1, total: disc.dats.length, archivo: origen })

      const unwrap = new CdxaUnwrap()
      const hashFrag = createHash('sha256')
      const inicio = offset
      let bytesFrag = 0

      const tick = setInterval(
        () =>
          onEvent({
            type: 'file:progress',
            index: i + 1,
            total: disc.dats.length,
            archivo: origen,
            leidos: unwrap.inBytes,
            size,
            pct: size ? Math.min(100, Math.floor((unwrap.inBytes / size) * 100)) : 0,
          }),
        250,
      )

      try {
        const rs = createReadStream(src, { highWaterMark: SECTOR * 64 })
        rs.on('error', (e) => unwrap.destroy(e))
        rs.pipe(unwrap)

        for await (const chunk of unwrap) {
          hashTotal.update(chunk)
          hashFrag.update(chunk)
          bytesFrag += chunk.length
          offset += chunk.length
          yield chunk
        }

        const info = {
          origen,
          orden: i + 1,
          bytes_origen: size, // para calcular el avance total del disco
          byte_inicio: inicio,
          byte_fin: offset, // exclusivo: [inicio, fin)
          bytes: bytesFrag,
          sectores: unwrap.sectors,
          sectores_relleno_descartados: unwrap.skipped,
          sha256: hashFrag.digest('hex'),
          modo: unwrap.passthrough ? 'copia-directa' : 'cdxa-desempaquetado',
        }
        fragmentos.push(info)
        onEvent({ type: 'file:done', index: i + 1, total: disc.dats.length, ...info })
      } catch (e) {
        // Un error de lectura es FATAL para el disco entero.
        //
        // No se puede "deshacer" lo ya emitido (en modo directo esos bytes ya
        // viajaron a S3), asi que continuar produciria un video truncado que
        // nadie notaria. El disco se reintenta completo desde cero, o se manda
        // a revision. Nunca se guarda un video incompleto.
        const err = new Error(`${origen}: ${String(e.message || e)}`)
        err.fragmento = origen
        err.lectura = true
        errores.push({ origen, orden: i + 1, error: String(e.message || e) })
        onEvent({ type: 'file:error', index: i + 1, total: disc.dats.length, origen, error: err.message })
        throw err
      } finally {
        clearInterval(tick)
      }
    }
  }

  /** Solo valido despues de agotar el generador. */
  function resumen(extra = {}) {
    return {
      etiqueta_disco: disc.label,
      carpeta: slug(disc.label) || 'disco-sin-nombre',
      formato_origen: 'Video CD (RIFF CDXA / MPEG-1)',
      ripeado_en: new Date(t0).toISOString(),
      duracion_seg: Math.round((Date.now() - t0) / 1000),
      archivo: nombreSalida(disc.label),
      bytes_totales: offset,
      sha256: hashTotal.digest('hex'),
      fragmentos,
      errores,
      ok: errores.length === 0 && fragmentos.length > 0,
      ...extra,
    }
  }

  return { chunks, resumen, get bytes() { return offset } }
}

/**
 * Modo local: ripea a outDir/<carpeta>/<NOMBRE>_completo.mpg + manifest.json.
 *
 * Si la lectura falla, reintenta el disco completo. Tras agotar los intentos
 * borra el archivo parcial y lanza el error: nunca deja un video truncado
 * haciendose pasar por bueno.
 */
export async function ripDisc(disc, outDir, onEvent = () => {}) {
  const carpeta = slug(disc.label) || 'disco-sin-nombre'
  const dest = join(outDir, carpeta)
  const ruta = join(dest, nombreSalida(disc.label))
  await mkdir(dest, { recursive: true })

  onEvent({ type: 'disc:start', label: disc.label, carpeta, destino: dest, total: disc.dats.length })

  let ultimoError
  for (let intento = 1; intento <= INTENTOS_LECTURA; intento++) {
    if (intento > 1) onEvent({ type: 'disc:retry', intento, total: INTENTOS_LECTURA })

    const rip = crearRipStream(disc, onEvent)
    const ws = createWriteStream(ruta)
    try {
      for await (const chunk of rip.chunks()) {
        if (!ws.write(chunk)) await once(ws, 'drain') // respeta backpressure
      }
      ws.end()
      await once(ws, 'close')

      const resumen = rip.resumen({ destino: dest, intentos: intento })
      await writeFile(join(dest, 'manifest.json'), JSON.stringify(resumen, null, 2))
      onEvent({ type: 'disc:done', ...resumen })
      return resumen
    } catch (e) {
      ultimoError = e
      ws.destroy()
      await rm(ruta, { force: true }) // fuera el parcial
    }
  }

  await rm(dest, { recursive: true, force: true })
  throw ultimoError
}
