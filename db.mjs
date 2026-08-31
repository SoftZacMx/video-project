// Base de datos del portal: usuarios, sesiones, registro de descargas y
// ajustes. SQLite en un solo archivo.
//
// La ruta viene de DB_PATH para que en Docker apunte a un volumen; si queda
// dentro del contenedor, cada redeploy borraria los usuarios.

import Database from 'better-sqlite3'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

const RUTA = process.env.DB_PATH || './registro.db'
const DIAS_SESION = 30

mkdirSync(dirname(RUTA), { recursive: true })
const db = new Database(RUTA)
db.pragma('journal_mode = WAL') // aguanta lecturas y escrituras a la vez
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id            INTEGER PRIMARY KEY,
    nombre        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    rol           TEXT NOT NULL CHECK (rol IN ('ADMIN','GUEST')),
    hash          TEXT NOT NULL,
    salt          TEXT NOT NULL,
    debe_cambiar  INTEGER NOT NULL DEFAULT 1,
    creado        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token       TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS descargas (
    id          INTEGER PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    clave_s3    TEXT NOT NULL,
    disco       TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    completada  INTEGER NOT NULL,
    fecha       TEXT NOT NULL
  );

  -- Nombre que cada usuario le puso a cada video. Va aparte de 'descargas'
  -- porque esa es un historico (varias filas por video) y el alias es uno
  -- solo por par usuario-video.
  CREATE TABLE IF NOT EXISTS alias (
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    clave_s3    TEXT NOT NULL,
    alias       TEXT NOT NULL,
    actualizado TEXT NOT NULL,
    PRIMARY KEY (usuario_id, clave_s3)
  );

  CREATE TABLE IF NOT EXISTS config (
    clave  TEXT PRIMARY KEY,
    valor  TEXT NOT NULL
  );
`)

// ------------------------------------------------------------------ ajustes

export function getConfig(clave, porDefecto = null) {
  const r = db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave)
  return r ? r.valor : porDefecto
}

export function setConfig(clave, valor) {
  db.prepare(
    'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
  ).run(clave, String(valor))
}

// arranca permitiendo crear administradores; se apaga desde la UI
if (getConfig('permitir_crear_admin') === null) setConfig('permitir_crear_admin', 'true')

export const permiteCrearAdmin = () => getConfig('permitir_crear_admin') === 'true'

// ------------------------------------------------------------ contraseñas

function hashear(pass, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(pass, salt, 64).toString('hex') }
}

function coincide(pass, salt, hash) {
  const a = Buffer.from(hash, 'hex')
  const b = scryptSync(pass, salt, 64)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Codigo temporal de 6 digitos que el admin le pasa al usuario. */
const codigoTemporal = () => String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0')

// -------------------------------------------------------------- usuarios

export const hayUsuarios = () =>
  db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0

export const contarAdmins = () =>
  db.prepare("SELECT COUNT(*) n FROM usuarios WHERE rol = 'ADMIN'").get().n

export function listarUsuarios() {
  return db
    .prepare('SELECT id, nombre, rol, debe_cambiar, creado FROM usuarios ORDER BY nombre')
    .all()
    .map((u) => ({ ...u, debe_cambiar: !!u.debe_cambiar }))
}

/**
 * Crea un usuario y devuelve su codigo temporal, que se muestra UNA sola vez.
 * La unicidad del nombre la garantiza la base de datos, no este codigo.
 */
export function crearUsuario(nombre, rol) {
  const limpio = String(nombre || '').trim()
  if (!limpio) throw Object.assign(new Error('Escribe un nombre.'), { codigo: 'nombre' })
  if (limpio.length > 40)
    throw Object.assign(new Error('El nombre es demasiado largo.'), { codigo: 'nombre' })
  if (rol !== 'ADMIN' && rol !== 'GUEST')
    throw Object.assign(new Error('Rol inválido.'), { codigo: 'rol' })
  if (rol === 'ADMIN' && !permiteCrearAdmin())
    throw Object.assign(new Error('La creación de administradores está desactivada.'), {
      codigo: 'rol',
    })

  const temporal = codigoTemporal()
  const { hash, salt } = hashear(temporal)
  try {
    const r = db
      .prepare(
        `INSERT INTO usuarios (nombre, rol, hash, salt, debe_cambiar, creado)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(limpio, rol, hash, salt, new Date().toISOString())
    return { id: Number(r.lastInsertRowid), nombre: limpio, rol, temporal }
  } catch (e) {
    if (String(e.code).includes('UNIQUE'))
      throw Object.assign(new Error('Ese nombre ya está usado.'), { codigo: 'duplicado' })
    throw e
  }
}

export function borrarUsuario(id) {
  const u = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(id)
  if (!u) return false
  // no dejar el sistema sin ningun administrador
  if (u.rol === 'ADMIN' && contarAdmins() <= 1)
    throw Object.assign(new Error('No puedes borrar al único administrador.'), { codigo: 'ultimo' })
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id)
  return true
}

/**
 * Genera una contraseña temporal nueva y vuelve a exigir el cambio.
 * Cierra las sesiones de ese usuario: si le restableces la contraseña es
 * porque la perdio o alguien mas la sabia, y en ambos casos hay que sacarlo.
 * Devuelve el codigo, que se muestra una sola vez.
 */
export function reiniciarPassword(id) {
  const u = db.prepare('SELECT id, nombre FROM usuarios WHERE id = ?').get(id)
  if (!u) throw Object.assign(new Error('Ese usuario ya no existe.'), { codigo: 'noexiste' })

  const temporal = codigoTemporal()
  const { hash, salt } = hashear(temporal)
  db.prepare('UPDATE usuarios SET hash = ?, salt = ?, debe_cambiar = 1 WHERE id = ?').run(
    hash,
    salt,
    id,
  )
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id)
  return { nombre: u.nombre, temporal }
}

/** Devuelve el usuario si la contraseña es correcta, o null. */
export function autenticar(nombre, pass) {
  const u = db.prepare('SELECT * FROM usuarios WHERE nombre = ?').get(String(nombre || '').trim())
  if (!u) return null
  if (!coincide(String(pass || ''), u.salt, u.hash)) return null
  return { id: u.id, nombre: u.nombre, rol: u.rol, debe_cambiar: !!u.debe_cambiar }
}

/** Cambia la contraseña y apaga el flag que fuerza el cambio. */
export function cambiarPassword(id, nueva) {
  const n = String(nueva || '')
  if (n.length < 4)
    throw Object.assign(new Error('La contraseña debe tener al menos 4 caracteres.'), {
      codigo: 'corta',
    })
  const { hash, salt } = hashear(n)
  db.prepare('UPDATE usuarios SET hash = ?, salt = ?, debe_cambiar = 0 WHERE id = ?').run(
    hash,
    salt,
    id,
  )
  // cerrar las demas sesiones del usuario
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id)
}

// -------------------------------------------------------------- sesiones

export function crearSesion(usuarioId) {
  const token = randomBytes(32).toString('hex')
  const expira = new Date(Date.now() + DIAS_SESION * 86400000).toISOString()
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)').run(
    token,
    usuarioId,
    expira,
  )
  return token
}

export function usuarioDeSesion(token) {
  if (!token) return null
  db.prepare('DELETE FROM sesiones WHERE expira < ?').run(new Date().toISOString())
  const r = db
    .prepare(
      `SELECT u.id, u.nombre, u.rol, u.debe_cambiar
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token = ?`,
    )
    .get(token)
  return r ? { ...r, debe_cambiar: !!r.debe_cambiar } : null
}

export const cerrarSesion = (token) =>
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(token)

// ------------------------------------------------------------- descargas

/** Se registra al CERRAR la conexion, con lo que de verdad se envió. */
export function registrarDescarga({ usuarioId, clave, disco, bytes, completada }) {
  db.prepare(
    `INSERT INTO descargas (usuario_id, clave_s3, disco, bytes, completada, fecha)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(usuarioId, clave, disco, bytes, completada ? 1 : 0, new Date().toISOString())
}

/** Claves que este usuario ya bajó COMPLETAS. Las canceladas no cuentan. */
export function clavesCompletadas(usuarioId) {
  return db
    .prepare('SELECT DISTINCT clave_s3 FROM descargas WHERE usuario_id = ? AND completada = 1')
    .all(usuarioId)
    .map((r) => r.clave_s3)
}

// ---------------------------------------------------------------- alias

/**
 * Limpia un nombre para que sirva como nombre de archivo en cualquier
 * sistema. Los dos puntos y las barras romperian la ruta al guardar.
 */
export function limpiarNombre(txt) {
  return (
    String(txt || '')
      .replace(/[/\\:*?"<>|]/g, '-')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '') // Windows no admite puntos al inicio ni al final
      .trim()
      .slice(0, 80)
  )
}

export function ponerAlias(usuarioId, clave, alias) {
  const limpio = limpiarNombre(alias)
  if (!limpio) return null
  db.prepare(
    `INSERT INTO alias (usuario_id, clave_s3, alias, actualizado) VALUES (?, ?, ?, ?)
     ON CONFLICT(usuario_id, clave_s3) DO UPDATE
       SET alias = excluded.alias, actualizado = excluded.actualizado`,
  ).run(usuarioId, clave, limpio, new Date().toISOString())
  return limpio
}

/** Mapa clave_s3 -> alias, para el usuario dado. */
export function aliasDe(usuarioId) {
  return Object.fromEntries(
    db
      .prepare('SELECT clave_s3, alias FROM alias WHERE usuario_id = ?')
      .all(usuarioId)
      .map((r) => [r.clave_s3, r.alias]),
  )
}

export function registroCompleto(limite = 500) {
  return db
    .prepare(
      `SELECT d.id, u.nombre AS usuario, d.disco, d.clave_s3, d.bytes, d.completada, d.fecha
         FROM descargas d JOIN usuarios u ON u.id = d.usuario_id
        ORDER BY d.fecha DESC LIMIT ?`,
    )
    .all(limite)
    .map((r) => ({ ...r, completada: !!r.completada }))
}

export default db
