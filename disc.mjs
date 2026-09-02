// Deteccion y clasificacion de discos opticos en macOS.
//
// No ripea: solo responde "hay un disco, de que tipo, donde esta montado".
// El ripeo VCD sigue en vcd.mjs; DVD/datos/etc. tendran su modulo despues.
//
// Senales, en este orden (el arbol manda sobre diskutil):
//   MPEGAV/AVSEQ*.DAT  → vcd
//   VIDEO_TS/          → dvd
//   BDMV/              → bluray
//   CD Audio           → audio-cd
//   medio optico resto → data
//
// Cero dependencias: diskutil, drutil y el arbol montado en /Volumes.

import { readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const run = promisify(execFile)

const KINDS = ['vcd', 'dvd', 'bluray', 'audio-cd', 'data']

function vacio(v) {
  if (!v) return true
  return /^(not applicable|none|n\/a|-)$/i.test(v.trim())
}

/**
 * Parsea `diskutil info` (texto). Evitamos -plist para no depender de plutil.
 * Las claves existen o no segun el volumen; las que no aplican quedan null.
 */
export function parseDiskutilInfo(text) {
  const get = (key) => {
    const re = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm')
    const m = text.match(re)
    const v = m?.[1]?.trim()
    return vacio(v) ? null : v
  }
  return {
    device: get('Device Node'),
    volumeName: get('Volume Name'),
    mountPoint: get('Mount Point'),
    filesystem: get('File System Personality') || get('Name \\(User Visible\\)'),
    volumeType: get('Type \\(Bundle\\)'),
    mediaName: get('Device / Media Name'),
    opticalDiscType: get('Optical Disc Type'),
    opticalMediaType: get('Optical Media Type'),
    protocol: get('Protocol'),
  }
}

export function esOptico(info) {
  if (!info) return false
  if (info.opticalMediaType || info.opticalDiscType) return true
  if (/CD Audio|cddafs|CD_DA/i.test(info.filesystem || '')) return true
  // Protocol "Optical" es tipico del SuperDrive USB; el interno a veces es SATA
  // con Optical Media Type, que ya cubrimos arriba.
  if (/^optical$/i.test(info.protocol || '')) return true
  return false
}

/**
 * Clasifica a partir del arbol montado + metadata de diskutil.
 * El arbol gana: un VCD montado como ISO9660 solo se distingue por MPEGAV/.
 * Devuelve null si no es un disco que el ripeador deba tocar (APFS, USB de datos, etc.).
 */
export function classifyKind(probe) {
  if (probe.dats?.length) return 'vcd'
  if (probe.hasVideoTs) return 'dvd'
  if (probe.hasBdmv) return 'bluray'
  if (/CD Audio|cddafs|CD_DA/i.test(probe.filesystem || '')) return 'audio-cd'
  if (esOptico(probe)) return 'data'
  return null
}

async function volumeMounts() {
  let names
  try {
    names = await readdir('/Volumes')
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const mount = join('/Volumes', name)
    try {
      const st = await stat(mount)
      if (!st.isDirectory()) continue // ignora el symlink Macintosh HD
      out.push({ name, mount })
    } catch {
      continue
    }
  }
  return out
}

async function probeTree(mount) {
  const entries = await readdir(mount).catch(() => [])
  const upper = new Set(entries.map((e) => e.toUpperCase()))
  const mpegav = entries.find((e) => e.toUpperCase() === 'MPEGAV')
  let dats = []
  let totalBytes = 0
  if (mpegav) {
    const files = await readdir(join(mount, mpegav)).catch(() => [])
    dats = files.filter((f) => /^AVSEQ\d+\.DAT$/i.test(f)).sort()
    const sizes = await Promise.all(
      dats.map((d) =>
        stat(join(mount, mpegav, d))
          .then((s) => s.size)
          .catch(() => 0),
      ),
    )
    totalBytes = sizes.reduce((a, b) => a + b, 0)
  }
  return {
    dats,
    totalBytes,
    mpegavDir: mpegav || 'MPEGAV',
    hasVideoTs: upper.has('VIDEO_TS'),
    hasBdmv: upper.has('BDMV'),
  }
}

async function diskutilInfo(mount) {
  try {
    const { stdout } = await run('diskutil', ['info', mount])
    return parseDiskutilInfo(stdout)
  } catch {
    return null
  }
}

function discoDe({ name, mount, tree, info, kind }) {
  return {
    kind,
    label: name,
    mount,
    device: info?.device || null,
    filesystem: info?.filesystem || null,
    volumeType: info?.volumeType || null,
    mediaType: info?.opticalMediaType || info?.opticalDiscType || info?.mediaName || null,
    dats: kind === 'vcd' ? tree.dats : [],
    totalBytes: tree.totalBytes || 0,
  }
}

/**
 * Inspecciona un mount. El arbol clasifica VCD/DVD/BD sin diskutil;
 * diskutil rellena filesystem/mediaType y decide si un volumen sin firma
 * es un disco de datos optico (si falla, ese volumen se ignora).
 */
export async function inspectMount(mount, name) {
  const tree = await probeTree(mount)
  const kindArbol = classifyKind(tree)
  const info = await diskutilInfo(mount)
  const kind = kindArbol || classifyKind({ ...tree, ...(info || {}) })
  if (!kind) return null
  return discoDe({ name, mount, tree, info, kind })
}

/** Todos los volumenes montados que el ripeador deberia considerar. */
export async function inspectMountedVolumes() {
  const vols = await volumeMounts()
  const out = []
  for (const { name, mount } of vols) {
    try {
      const disc = await inspectMount(mount, name)
      if (disc) out.push(disc)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Primer disco optico (o VCD por firma) listo para procesar.
 * Prioridad: vcd → dvd → bluray → audio-cd → data.
 */
export async function findDisc() {
  const discs = await inspectMountedVolumes()
  for (const kind of KINDS) {
    const d = discs.find((x) => x.kind === kind)
    if (d) return d
  }
  return null
}

/**
 * Busca en /Volumes un disco con MPEGAV/AVSEQ*.DAT. null si no hay.
 * Misma forma que antes ({ label, mount, dats, totalBytes }) mas kind: 'vcd',
 * para que el bucle actual de server.mjs no cambie.
 *
 * Solo mira el arbol: no llama diskutil. Asi el poll cada 2 s no encarece
 * el caso VCD (Macintosh HD y otros volumenes no opticos se saltan igual).
 */
export async function findVcd() {
  for (const { name, mount } of await volumeMounts()) {
    try {
      const tree = await probeTree(mount)
      if (!tree.dats.length) continue
      return {
        kind: 'vcd',
        label: name,
        mount,
        dats: tree.dats,
        totalBytes: tree.totalBytes,
      }
    } catch {
      continue
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

export async function eject(mount) {
  try {
    await run('diskutil', ['eject', mount])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0] }
  }
}
