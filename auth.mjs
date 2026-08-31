// Sesiones, login y administracion de usuarios.
//
// Regla: los permisos se validan AQUI, en el servidor. Esconder botones en la
// interfaz no protege nada — un invitado podria llamar los endpoints a mano.

import {
  autenticar,
  cambiarPassword,
  crearSesion,
  cerrarSesion,
  usuarioDeSesion,
  crearUsuario,
  borrarUsuario,
  listarUsuarios,
  reiniciarPassword,
  hayUsuarios,
  permiteCrearAdmin,
  setConfig,
  registroCompleto,
} from './db.mjs'

const COOKIE = 'sesion'
const SEGURA = process.env.COOKIE_SEGURA === '1'
const DIAS = 30

// ------------------------------------------------------------- utilidades

export function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => {
        const i = c.indexOf('=')
        return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]
      })
      .filter(([k]) => k),
  )
}

export function json(res, codigo, obj) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

async function leerJson(req) {
  const partes = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 100000) throw new Error('cuerpo demasiado grande')
    partes.push(c)
  }
  if (!partes.length) return {}
  return JSON.parse(Buffer.concat(partes).toString('utf8'))
}

/** Usuario de la sesion actual, o null. */
export const sesionDe = (req) => usuarioDeSesion(cookies(req)[COOKIE])

function ponerCookie(res, token) {
  const partes = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${DIAS * 86400}`,
    'SameSite=Lax',
  ]
  if (SEGURA) partes.push('Secure')
  res.setHeader('Set-Cookie', partes.join('; '))
}

function quitarCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`)
}

/**
 * Portero. Devuelve el usuario si pasa, o null habiendo respondido ya.
 *   rol: 'ADMIN' para exigir administrador.
 */
export function exigir(req, res, rol = null) {
  const u = sesionDe(req)
  if (!u) {
    json(res, 401, { error: 'Inicia sesión para continuar.' })
    return null
  }
  if (u.debe_cambiar) {
    json(res, 409, { error: 'Tienes que cambiar tu contraseña.', debe_cambiar: true })
    return null
  }
  if (rol && u.rol !== rol) {
    json(res, 403, { error: 'No tienes permiso para esto.' })
    return null
  }
  return u
}

// ------------------------------------------------------------- rutas

/**
 * Atiende /api/*. Devuelve true si la ruta era suya.
 *
 * Arranque: mientras NO exista ningun usuario, crear usuarios queda abierto
 * para que puedas hacer el primero. En cuanto hay uno, hace falta ser ADMIN.
 */
export async function manejarApi(req, res, url) {
  const ruta = url.pathname
  if (!ruta.startsWith('/api/')) return false

  try {
    // --- quien soy (no exige sesion) ---
    if (ruta === '/api/yo') {
      const u = sesionDe(req)
      json(res, 200, {
        usuario: u,
        sinUsuarios: !hayUsuarios(),
        permiteCrearAdmin: permiteCrearAdmin(),
      })
      return true
    }

    // --- login ---
    if (ruta === '/api/login' && req.method === 'POST') {
      const { nombre, password } = await leerJson(req)
      const { usuario, motivo } = autenticar(nombre, password)
      if (!usuario) {
        // el usuario ve un mensaje generico; el log dice cual de los dos fue
        const detalle =
          motivo === 'no-existe'
            ? 'ese usuario NO existe en esta base de datos'
            : 'contraseña incorrecta'
        console.log(`  login fallido: ${JSON.stringify(String(nombre || ''))} — ${detalle}`)
        json(res, 401, { error: 'Nombre o contraseña incorrectos.' })
        return true
      }
      console.log(`  login: ${usuario.nombre} (${usuario.rol})`)
      ponerCookie(res, crearSesion(usuario.id))
      json(res, 200, { usuario })
      return true
    }

    if (ruta === '/api/logout' && req.method === 'POST') {
      cerrarSesion(cookies(req)[COOKIE])
      quitarCookie(res)
      json(res, 200, { ok: true })
      return true
    }

    // --- cambiar contraseña: permitido AUN con debe_cambiar activo,
    //     porque es justo lo que hay que hacer en el primer acceso ---
    if (ruta === '/api/cambiar-password' && req.method === 'POST') {
      const u = sesionDe(req)
      if (!u) {
        json(res, 401, { error: 'Inicia sesión para continuar.' })
        return true
      }
      const { nueva } = await leerJson(req)
      cambiarPassword(u.id, nueva)
      // la sesion se invalido al cambiar: se abre una nueva
      ponerCookie(res, crearSesion(u.id))
      json(res, 200, { ok: true })
      return true
    }

    // --- usuarios ---
    if (ruta === '/api/usuarios' && req.method === 'GET') {
      if (!exigir(req, res, 'ADMIN')) return true
      json(res, 200, { usuarios: listarUsuarios(), permiteCrearAdmin: permiteCrearAdmin() })
      return true
    }

    if (ruta === '/api/usuarios' && req.method === 'POST') {
      // el primer usuario se crea sin sesion; despues hace falta ADMIN
      if (hayUsuarios() && !exigir(req, res, 'ADMIN')) return true
      const { nombre, rol } = await leerJson(req)
      const nuevo = crearUsuario(nombre, rol)
      json(res, 200, { usuario: nuevo }) // incluye el codigo temporal, una sola vez
      return true
    }

    if (ruta.startsWith('/api/usuarios/') && req.method === 'DELETE') {
      if (!exigir(req, res, 'ADMIN')) return true
      const id = Number(ruta.slice('/api/usuarios/'.length))
      json(res, 200, { borrado: borrarUsuario(id) })
      return true
    }

    // --- restablecer la contraseña de alguien ---
    if (ruta.startsWith('/api/reiniciar/') && req.method === 'POST') {
      const admin = exigir(req, res, 'ADMIN')
      if (!admin) return true
      const id = Number(ruta.slice('/api/reiniciar/'.length))
      const r = reiniciarPassword(id)
      json(res, 200, { ...r, esMiUsuario: id === admin.id })
      return true
    }

    // --- interruptor de creacion de administradores ---
    if (ruta === '/api/permitir-admin' && req.method === 'POST') {
      if (!exigir(req, res, 'ADMIN')) return true
      const { valor } = await leerJson(req)
      setConfig('permitir_crear_admin', valor ? 'true' : 'false')
      json(res, 200, { permiteCrearAdmin: permiteCrearAdmin() })
      return true
    }

    // --- registro de descargas ---
    if (ruta === '/api/registro') {
      if (!exigir(req, res, 'ADMIN')) return true
      json(res, 200, { registro: registroCompleto() })
      return true
    }

    json(res, 404, { error: 'no encontrado' })
    return true
  } catch (e) {
    // los errores con codigo son de validacion: mensaje util para el usuario
    const esValidacion = Boolean(e.codigo)
    json(res, esValidacion ? 400 : 500, { error: e.message || 'Error inesperado' })
    return true
  }
}
