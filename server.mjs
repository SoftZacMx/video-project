// Servidor del ripeador: sirve la UI, empuja eventos por SSE
// y corre el bucle de deteccion/ripeo de discos.
// Cero dependencias: solo modulos nativos de Node.
//
// Uso:  node server.mjs   →  http://localhost:5177

import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findVcd, ripDisc, eject, notify, sleep, estadoLector } from './vcd.mjs'
import { OUT_DIR, SOLO_LOCAL, DEMO, RIPEADOR, PORT, MODO, ES_RIPEADOR, S3 } from './config.mjs'

// En modo ripeador NO se cargan la base ni la autenticacion: la app de
// escritorio no tiene usuarios. Con imports estaticos, better-sqlite3 entraria
// al paquete de Electron sin usarse y arrastraria su recompilacion nativa.
const P = ES_RIPEADOR ? null : await import('./auth.mjs')
const D = ES_RIPEADOR ? null : await import('./db.mjs')

const manejarApi = P ? P.manejarApi : async () => false
const json = (res, codigo, obj) => {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
/** En modo ripeador no hay a quien pedirle sesion: pasa siempre. */
const exigir = P ? P.exigir : () => ({ id: 0, nombre: 'operador', rol: 'ADMIN' })
const infoBase = D ? D.infoBase : () => null
const clavesCompletadas = D ? D.clavesCompletadas : () => []
const registrarDescarga = D ? D.registrarDescarga : () => {}
const aliasDe = D ? D.aliasDe : () => ({})
const ponerAlias = D ? D.ponerAlias : () => null
const limpiarNombre = D ? D.limpiarNombre : (t) => String(t || '').trim()
import {
  estadoSubida,
  onCambio,
  cargarPendientes,
  reintentarPendientes,
  probarAcceso,
  ripDiscDirectoS3,
  listarDiscos,
  abrirDescarga,
  abrirRango,
} from './uploader.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const POLL_MS = 2000
let accesoS3 = 'sin-probar'
// cuanto esperar a que macOS monte un disco antes de declararlo ilegible
const ESPERA_MONTAJE_MS = 45000

// -------------------------------------------------------------- estado + SSE

/** Estado unico. La UI siempre lo recibe completo al conectarse. */
const state = {
  fase: 'esperando', // esperando | ripeando | saca-disco | error
  salida: OUT_DIR,
  disco: null, // { label, carpeta, total }
  archivo: null, // { index, total, archivo, pct, leidos, size }
  discos: [], // historial, mas reciente primero
  contador: 0,
  revisar: [], // discos que fallaron la lectura y no se guardaron
  // destino remoto: null cuando corre en modo solo-local
  s3: DEMO
    ? { bucket: '(demostración)', region: '—', prefijo: 'discos' }
    : SOLO_LOCAL
      ? null
      : { bucket: S3.bucket, region: S3.region, prefijo: S3.prefix },
  demo: DEMO,
  modo: MODO,
  subida: estadoSubida, // la referencia es viva: el uploader la muta
}

const clients = new Set()

function broadcast(evento) {
  const payload = `data: ${JSON.stringify(evento)}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

/** Publica el estado completo; la UI solo repinta con esto. */
function push() {
  broadcast({ type: 'state', state })
}

// ------------------------------------------------------------------ servidor

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // Salud del servicio, para el healthcheck de Docker/Dokploy.
  // No exige sesion: lo consulta el orquestador, no una persona. No expone
  // credenciales, solo si las piezas responden.
  if (url.pathname === '/salud') {
    const b = infoBase()
    const sano = ES_RIPEADOR ? true : b.escribible && b.integridad === 'ok'
    json(res, sano ? 200 : 503, {
      estado: sano ? 'ok' : 'degradado',
      modo: MODO,
      base: b
        ? {
            escribible: b.escribible,
            integridad: b.integridad,
            usuarios: b.usuarios,
            error: b.error,
          }
        : 'no-aplica',
      s3: SOLO_LOCAL || DEMO ? 'no-aplica' : accesoS3,
      lector: RIPEADOR ? 'activo' : 'sin-lector',
    })
    return
  }

  // login, usuarios, ajustes y registro
  if (await manejarApi(req, res, url)) return

  // el estado del disco es solo para el admin
  if (url.pathname === '/events') {
    if (!exigir(req, res, 'ADMIN')) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ type: 'state', state })}\n\n`)
    clients.add(res)
    const ka = setInterval(() => res.write(': keepalive\n\n'), 20000)
    req.on('close', () => {
      clearInterval(ka)
      clients.delete(res)
    })
    return
  }

  // abrir la carpeta de destino en Finder
  if (url.pathname === '/abrir' && req.method === 'POST') {
    if (!exigir(req, res, 'ADMIN')) return
    execFile('open', [state.salida], () => {})
    res.writeHead(204).end()
    return
  }

  // expulsar a mano
  if (url.pathname === '/expulsar' && req.method === 'POST') {
    if (!exigir(req, res, 'ADMIN')) return
    const disc = await findVcd()
    if (disc) await eject(disc.mount)
    res.writeHead(204).end()
    return
  }

  // listar los discos que hay en S3
  if (url.pathname === '/discos') {
    const u = exigir(req, res)
    if (!u) return
    try {
      const discos = await listarDiscos()
      const yaBajadas = new Set(clavesCompletadas(u.id))
      const alias = aliasDe(u.id)
      // el estado y el alias son de ESTE usuario: cada uno nombra sus videos
      const conEstado = discos.map((d) => ({
        ...d,
        descargada: d.archivos.some((a) => yaBajadas.has(a.key)),
        alias: alias[d.archivos[0]?.key] || null,
      }))
      json(res, 200, conEstado)
    } catch (e) {
      json(res, 500, { error: String(e.message || e) })
    }
    return
  }

  // ver la vista previa dentro del navegador.
  // Importante: esto NO se registra como descarga; si contara, ver 10
  // segundos marcaria el video como "ya lo tienes" y arruinaria el contador.
  if (url.pathname === '/ver') {
    const u = exigir(req, res)
    if (!u) return
    const key = url.searchParams.get('key')
    if (!key) return res.writeHead(400).end('falta key')
    try {
      const d = await abrirRango(key, req.headers.range)
      const cab = {
        'Content-Type': d.tipo || 'video/mp4',
        'Content-Length': d.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      }
      if (d.rango) {
        cab['Content-Range'] = d.rango
        res.writeHead(206, cab) // respuesta parcial: el reproductor puede buscar
      } else {
        res.writeHead(200, cab)
      }
      d.body.pipe(res)
    } catch (e) {
      res.writeHead(404).end(String(e.message || e))
    }
    return
  }

  // descargar un objeto de S3 pasando por el servidor
  if (url.pathname === '/descargar') {
    const u = exigir(req, res)
    if (!u) return
    const key = url.searchParams.get('key')
    if (!key) return res.writeHead(400).end('falta key')
    try {
      const d = await abrirDescarga(key)
      const original = key.slice(key.lastIndexOf('/') + 1)
      const partes = key.split('/')
      const disco = partes.length > 2 ? partes[partes.length - 2] : key

      // el usuario puede elegir con que nombre se guarda el archivo;
      // se conserva la extension o el archivo no abriria con doble clic
      const pedido = limpiarNombre(url.searchParams.get('nombre') || '')
      let nombre = original
      if (pedido) {
        ponerAlias(u.id, key, pedido)
        const ext = original.slice(original.lastIndexOf('.'))
        nombre = pedido.toLowerCase().endsWith(ext.toLowerCase()) ? pedido : pedido + ext
      }

      res.writeHead(200, {
        'Content-Type': d.tipo || 'application/octet-stream',
        'Content-Length': d.size,
        // fuerza "guardar como" en el navegador
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      })

      // Se registra al CERRAR, con lo que de verdad se envio: una descarga
      // cancelada a la mitad no debe contar como bajada.
      let enviados = 0
      let anotado = false
      d.body.on('data', (c) => (enviados += c.length))
      res.on('close', () => {
        if (anotado) return
        anotado = true
        registrarDescarga({
          usuarioId: u.id,
          clave: key,
          disco,
          bytes: enviados,
          completada: d.size > 0 && enviados >= d.size,
        })
      })

      d.body.pipe(res)
    } catch (e) {
      res.writeHead(500).end(String(e.message || e))
    }
    return
  }

  // cambiar el nombre de un video sin volver a descargarlo
  if (url.pathname === '/api/alias' && req.method === 'POST') {
    const u = exigir(req, res)
    if (!u) return
    const partes = []
    for await (const c of req) partes.push(c)
    try {
      const { key, alias } = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')
      if (!key) return json(res, 400, { error: 'falta key' })
      json(res, 200, { alias: ponerAlias(u.id, key, alias) })
    } catch (e) {
      json(res, 400, { error: String(e.message || e) })
    }
    return
  }

  // reintentar las subidas que quedaron pendientes
  if (url.pathname === '/reintentar' && req.method === 'POST') {
    if (!exigir(req, res, 'ADMIN')) return
    await reintentarPendientes()
    res.writeHead(204).end()
    return
  }

  // archivos estaticos
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
  if (file.includes('..')) return res.writeHead(400).end()
  try {
    const body = await readFile(join(__dirname, 'public', file))
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('no encontrado')
  }
})

// ----------------------------------------------------------------- demo
//
// Simula el ciclo completo de un disco para poder revisar la interfaz sin
// tener el lector conectado. No toca S3 ni el disco duro.

async function loopDemo() {
  const DISCOS = [
    { label: 'BODA MARIA Y JOSE', bytes: 210 * 1024 * 1024, partes: 3 },
    { label: 'CUMPLEAÑOS ABUELA', bytes: 95 * 1024 * 1024, partes: 2 },
    { label: 'DISCO RAYADO', bytes: 150 * 1024 * 1024, partes: 2, falla: true },
  ]
  let i = 0

  for (;;) {
    const d = DISCOS[i++ % DISCOS.length]

    state.fase = 'esperando'
    state.disco = null
    state.progreso = null
    state.sinLector = false
    push()
    await sleep(4000)

    state.fase = 'montando'
    push()
    await sleep(2500)

    state.fase = 'ripeando'
    state.contador++
    state.disco = { label: d.label, total: d.partes, bytes: d.bytes }
    push()

    // avance a ~1.2 MB/s, como el lector real
    const VEL = 1.2 * 1024 * 1024
    const hasta = d.falla ? d.bytes * 0.4 : d.bytes
    for (let leidos = 0; leidos < hasta; leidos += VEL) {
      state.progreso = {
        leidos: Math.min(leidos, hasta),
        total: d.bytes,
        pct: Math.floor((Math.min(leidos, hasta) / d.bytes) * 100),
      }
      state.archivo = {
        index: Math.min(d.partes, Math.floor((leidos / d.bytes) * d.partes) + 1),
        total: d.partes,
        archivo: `AVSEQ0${Math.min(d.partes, Math.floor((leidos / d.bytes) * d.partes) + 1)}.DAT`,
        pct: state.progreso.pct,
        leidos: state.progreso.leidos,
        size: d.bytes,
      }
      push()
      await sleep(1000)
    }

    state.archivo = null

    if (d.falla) {
      state.revisar.unshift({
        label: d.label,
        error: 'EIO: i/o error, read',
        cuando: new Date().toISOString(),
      })
      state.fase = 'disco-danado'
      state.progreso = null
      push()
      await sleep(7000)
      continue
    }

    // subida simulada
    estadoSubida.actual = {
      label: d.label,
      archivo: `${d.label}_completo.mpg`,
      index: 1,
      total: 1,
      pct: 0,
      subidos: 0,
      size: d.bytes,
    }
    for (let p = 0; p <= 100; p += 12) {
      estadoSubida.actual.pct = Math.min(100, p)
      estadoSubida.actual.subidos = (d.bytes * Math.min(100, p)) / 100
      push()
      await sleep(500)
    }
    estadoSubida.actual = null
    estadoSubida.completados.unshift({
      label: d.label,
      prefijo: `discos/${d.label}`,
      archivos: 2,
      bytes: d.bytes,
      segundos: 170,
    })

    state.discos.unshift({
      n: state.contador,
      label: d.label,
      ok: true,
      archivo: `${d.label}_completo.mpg`,
      fragmentos: Array.from({ length: d.partes }, (_, k) => ({ orden: k + 1 })),
      errores: [],
      bytes: d.bytes,
      segundos: 170,
    })

    state.fase = 'saca-disco'
    state.expulsado = true
    state.progreso = null
    push()
    await sleep(6000)
  }
}

// --------------------------------------------------------------------- bucle

let desdeCuandoSinMontar = null

async function loop() {
  for (;;) {
    const disc = await findVcd()

    if (!disc) {
      // Distingue "no hay disco" de "hay un disco que no se puede leer".
      // Sin esto, un disco rayado deja la pantalla en "Esperando disco"
      // para siempre y el operador no sabe si esta trabajando o colgada.
      const lector = await estadoLector()
      let fase = 'esperando'

      if (lector.hayDisco) {
        desdeCuandoSinMontar ??= Date.now()
        fase = Date.now() - desdeCuandoSinMontar > ESPERA_MONTAJE_MS ? 'disco-ilegible' : 'montando'
      } else {
        desdeCuandoSinMontar = null
      }

      // ojo: sinLector se compara aparte de la fase, porque desconectar el
      // lector no cambia la fase (sigue "esperando") y si no, nunca se veria
      if (state.fase !== fase || state.sinLector !== !lector.lector) {
        state.fase = fase
        state.disco = null
        state.archivo = null
        state.sinLector = !lector.lector
        push()
      }
      await sleep(POLL_MS)
      continue
    }
    desdeCuandoSinMontar = null

    // disco nuevo: ripear
    state.fase = 'ripeando'
    state.contador++
    state.disco = { label: disc.label, total: disc.dats.length, bytes: disc.totalBytes }
    state.archivo = null
    push()

    // SOLO_LOCAL -> a disco.  Con .env -> directo a S3, nada local.
    const ripear = SOLO_LOCAL
      ? (cb) => ripDisc(disc, OUT_DIR, cb)
      : (cb) => ripDiscDirectoS3(disc, cb)

    // avance acumulado del disco completo, no del fragmento suelto:
    // es lo que la vista de operador necesita para estimar el tiempo
    let leidosPrevios = 0
    const total = disc.totalBytes || 0

    let resumen
    try {
      resumen = await ripear((ev) => {
        if (ev.type === 'disc:start') {
          state.disco = { ...state.disco, carpeta: ev.carpeta, destino: ev.destino }
        } else if (ev.type === 'disc:retry') {
          leidosPrevios = 0 // se relee el disco desde cero
          state.intento = ev.intento
        } else if (ev.type === 'file:start' || ev.type === 'file:progress') {
          state.archivo = {
            index: ev.index,
            total: ev.total,
            archivo: ev.archivo,
            pct: ev.pct ?? 0,
            leidos: ev.leidos ?? 0,
            size: ev.size ?? 0,
          }
          const leidos = leidosPrevios + (ev.leidos ?? 0)
          state.progreso = { leidos, total, pct: total ? Math.min(100, Math.floor((leidos / total) * 100)) : 0 }
        } else if (ev.type === 'file:done') {
          leidosPrevios += ev.bytes_origen ?? 0
          state.archivo = null
        } else if (ev.type === 'file:error') {
          state.archivo = null
        }
        push()
      })
    } catch (e) {
      // Agotados los intentos de lectura: NO se guardo nada (ni local ni en
      // S3). El disco va a la pila de revision para que alguien lo limpie o
      // lo pruebe en otro lector.
      state.revisar.unshift({
        label: disc.label,
        error: String(e.message || e),
        cuando: new Date().toISOString(),
      })
      state.fase = 'disco-danado'
      state.archivo = null
      push()
      await notify('Disco con errores de lectura', 'No se guardó nada. Límpialo y prueba otra vez.', 'Basso')
      await eject(disc.mount)
      while (await findVcd()) await sleep(POLL_MS)
      continue
    }

    state.discos.unshift({
      n: state.contador,
      label: resumen.etiqueta_disco,
      carpeta: resumen.carpeta,
      ok: resumen.ok,
      archivo: resumen.archivo,
      sha256: resumen.sha256,
      fragmentos: resumen.fragmentos,
      errores: resumen.errores,
      bytes: resumen.bytes_totales,
      segundos: resumen.duracion_seg,
    })
    state.archivo = null

    await notify(
      resumen.ok ? `Disco ${state.contador} listo` : `Disco ${state.contador} con errores`,
      resumen.ok ? 'Saca el disco y mete el siguiente' : `${resumen.errores.length} archivo(s) fallaron`,
      resumen.ok ? 'Glass' : 'Basso',
    )

    const ej = await eject(disc.mount)
    state.fase = 'saca-disco'
    state.expulsado = ej.ok
    state.expulsarError = ej.ok ? null : ej.error
    push()

    // no re-ripear el mismo disco: esperar a que salga
    while (await findVcd()) await sleep(POLL_MS)
  }
}

// La carpeta local solo se usa al ripear. En el contenedor puede no existir
// ni poder crearse, y eso NO debe impedir que el portal arranque.
try {
  await mkdir(OUT_DIR, { recursive: true })
} catch (e) {
  console.log(`  aviso: no se pudo usar la carpeta local ${OUT_DIR} (${e.code})`)
}

// la UI se repinta sola cuando el uploader avanza
onCambio(push)
if (!ES_RIPEADOR) await cargarPendientes()

console.log(`\n  Ripeador de Video CD  →  http://localhost:${PORT}`)
console.log(`  guardando en ${OUT_DIR}`)

// --- base de datos (solo en modo portal) ---
const base = infoBase()
if (base && !base.escribible) {
  console.error(`\n  ✗ La base de datos no se puede escribir`)
  console.error(`    ruta:  ${base.ruta}`)
  console.error(`    causa: ${base.error || 'desconocida'}`)
  console.error(`    ¿Está el volumen montado en solo lectura?\n`)
  process.exit(1)
}
if (base) {
  console.log(
    `  base de datos OK  ${base.ruta}  (${base.usuarios} usuario(s), ${base.admins} admin)`,
  )
  if (base.integridad !== 'ok') console.log(`  aviso: integridad = ${base.integridad}`)
} else {
  console.log('  modo ripeador: sin base de datos ni usuarios')
}

// Aviso importante para el despliegue: si la base se crea de cero en cada
// arranque, el volumen NO esta funcionando y los usuarios se pierden en
// cada redeploy. Ese fallo es silencioso si nadie lo dice.
if (base?.recienCreada) {
  console.log('')
  console.log('  ┌──────────────────────────────────────────────────────────┐')
  console.log('  │ BASE DE DATOS NUEVA: no había ninguna en esa ruta.       │')
  console.log('  │ Si es el primer arranque, normal: crea tu admin ya.      │')
  console.log('  │ Si NO lo es, el volumen no está montado y vas a perder   │')
  console.log('  │ los usuarios en cada redeploy. Revisa DB_PATH.           │')
  console.log('  └──────────────────────────────────────────────────────────┘')
  console.log('')
}

// Verifica el acceso a S3 ANTES de ripear: mejor fallar aqui que
// descubrir a los 50 discos que las credenciales no servian.
if (DEMO) {
  console.log('  MODO DEMOSTRACION: disco simulado, no toca S3 ni el disco duro')
} else if (SOLO_LOCAL) {
  console.log('  modo SOLO_LOCAL: no se sube nada a S3')
} else {
  process.stdout.write(`  probando acceso a s3://${S3.bucket} … `)
  const prueba = await probarAcceso()
  accesoS3 = prueba.ok ? 'ok' : 'fallo'
  if (prueba.ok) {
    console.log('OK')
    console.log(`  subiendo a s3://${S3.bucket}/${S3.prefix}/ (${S3.storageClass})`)
  } else {
    console.log('FALLO')
    console.error(`\n  ✗ No se pudo escribir en s3://${prueba.bucket}`)
    console.error(`    ${prueba.error}\n`)
    console.error('  Revisa AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET en .env')
    console.error('  o arranca sin subir:  SOLO_LOCAL=1 node server.mjs\n')
    process.exit(1)
  }
}

if (estadoSubida.pendientes.length) {
  console.log(`  ${estadoSubida.pendientes.length} subida(s) pendiente(s) de una sesion anterior`)
}

// Sin esto, un puerto ocupado sale como excepcion sin manejar: en Electron
// se ve como un dialogo de "Uncaught Exception" con un stack trace.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ El puerto ${PORT} ya está en uso.`)
    console.error('    Otra copia de la app o del servidor está corriendo.')
    console.error(`    Puedes ver quién con:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
    console.error(`    O usar otro puerto:    PORT=5178 npm start\n`)
  } else {
    console.error(`\n  ✗ El servidor no pudo arrancar: ${e.code} ${e.message}\n`)
  }
  process.exit(1)
})

server.listen(PORT, () => {
  console.log('  Ctrl+C para salir\n')
  if (!process.env.NO_OPEN) execFile('open', [`http://localhost:${PORT}`], () => {})
})
if (DEMO) loopDemo()
else if (RIPEADOR) loop()
else {
  // sin lector: la app queda solo como portal de descargas
  state.fase = 'esperando'
  state.sinLector = true
  console.log('  sin lector de discos: modo portal (solo descargas)')
}
