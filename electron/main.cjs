// Proceso principal de Electron.
//
// No reimplementa nada: arranca el mismo servidor que se usa con
// `npm start` y abre una ventana apuntando a localhost. La interfaz y toda
// la logica quedan intactas.
//
// CommonJS a proposito: el soporte de ESM en el main de Electron es reciente
// y esto funciona en cualquier version. El servidor sigue siendo ESM y se
// carga con import() dinamico.

const electron = require('electron')

// Si ELECTRON_RUN_AS_NODE esta puesto, Electron corre como Node plano y
// require('electron') devuelve una ruta en vez de la API. Pasa al lanzarlo
// desde la terminal integrada de VSCode, que define esa variable.
if (typeof electron === 'string' || !electron.app) {
  console.error('\n  ✗ Electron esta corriendo como Node plano.')
  console.error('    Causa: la variable ELECTRON_RUN_AS_NODE esta definida')
  console.error('    (la pone la terminal de VSCode, entre otras).\n')
  console.error('    Solucion:  env -u ELECTRON_RUN_AS_NODE npx electron .\n')
  process.exit(1)
}

const { app, BrowserWindow, ipcMain, shell, dialog } = electron
const { join } = require('node:path')
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs')

const RAIZ = join(__dirname, '..')

// Puerto libre en lugar de uno fijo.
//
// Con 5177 fijo, la app moria con EADDRINUSE si algo mas usaba ese puerto
// (por ejemplo el servidor de `npm start`, u otra copia de la app). El puerto
// aqui es un detalle interno: nadie lo escribe a mano.
let PUERTO = 0

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const net = require('node:net')
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// Una sola instancia: dos ventanas pelearian por el mismo puerto
if (!app.requestSingleInstanceLock()) app.quit()

// ------------------------------------------------------------ configuracion

/**
 * La config vive FUERA del .app, en Application Support.
 *
 * Meter las credenciales dentro del paquete seria un error: un .app es solo
 * una carpeta, y cualquiera que reciba el instalador podria abrirla y leerlas.
 */
function rutaConfig() {
  return join(app.getPath('userData'), 'config.json')
}

function leerConfig() {
  try {
    return JSON.parse(readFileSync(rutaConfig(), 'utf8'))
  } catch {
    return null
  }
}

function guardarConfig(datos) {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  writeFileSync(rutaConfig(), JSON.stringify(datos, null, 2), { mode: 0o600 })
}

const configCompleta = (c) =>
  Boolean(c?.AWS_ACCESS_KEY_ID && c?.AWS_SECRET_ACCESS_KEY && c?.AWS_REGION && c?.S3_BUCKET)

// --------------------------------------------------------------- ffmpeg

/**
 * Ruta al ffmpeg empaquetado. Dentro del .app los binarios viven en
 * app.asar.unpacked, no en app.asar, porque un ejecutable no se puede correr
 * desde dentro de un archivo empaquetado.
 */
function rutaFfmpeg() {
  try {
    const p = require('ffmpeg-static')
    return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
  } catch {
    return null // sin vista previa, pero el ripeo funciona igual
  }
}

// --------------------------------------------------------------- ventanas

let ventana = null

function ventanaConfig() {
  ventana = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Configuración',
    webPreferences: { preload: join(__dirname, 'preload.cjs') },
  })
  ventana.loadFile(join(__dirname, 'config.html'))
}

function ventanaApp() {
  ventana = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Digitalizador de discos',
    show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs') },
  })
  ventana.once('ready-to-show', () => ventana.show())
  ventana.loadURL(`http://localhost:${PUERTO}`)

  // los enlaces externos van al navegador, no abren ventanas de Electron
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// --------------------------------------------------------------- arranque

async function arrancarServidor(config) {
  PUERTO = await puertoLibre()
  // el servidor lee su configuracion de process.env, asi que se puebla
  // ANTES de importarlo (config.mjs la evalua al cargar el modulo)
  Object.assign(process.env, config)
  process.env.NO_OPEN = '1' // la ventana la abre Electron, no el navegador
  process.env.PORT = String(PUERTO)
  process.env.OUT_DIR = config.OUT_DIR || join(app.getPath('userData'), 'videos')

  // App de escritorio = solo ripear y subir. Sin usuarios ni base de datos:
  // eso vive en el portal en linea. Asi better-sqlite3 ni entra al paquete.
  process.env.MODO = 'ripeador'

  const ffmpeg = rutaFfmpeg()
  if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg

  await import(`file://${join(RAIZ, 'server.mjs')}`)

  // esperar a que el puerto responda antes de mostrar la ventana
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PUERTO}/salud`)
      if (r.status) return true
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  return false
}

app.whenReady().then(async () => {
  const config = leerConfig()

  if (!configCompleta(config)) {
    ventanaConfig()
    return
  }

  try {
    const ok = await arrancarServidor(config)
    if (!ok) throw new Error('el servidor no respondió a tiempo')
    ventanaApp()
  } catch (e) {
    dialog.showErrorBox(
      'No se pudo arrancar',
      `${e.message}\n\nRevisa la configuración en:\n${rutaConfig()}`,
    )
    ventanaConfig()
  }
})

// ------------------------------------------------------------------- ipc

ipcMain.handle('config:leer', () => {
  const c = leerConfig() || {}
  // nunca se devuelve el secreto a la ventana; solo si ya hay uno guardado
  return { ...c, AWS_SECRET_ACCESS_KEY: c.AWS_SECRET_ACCESS_KEY ? '__GUARDADO__' : '' }
})

ipcMain.handle('config:guardar', (_ev, datos) => {
  const previa = leerConfig() || {}
  // si no lo cambiaron, se conserva el secreto anterior
  if (datos.AWS_SECRET_ACCESS_KEY === '__GUARDADO__')
    datos.AWS_SECRET_ACCESS_KEY = previa.AWS_SECRET_ACCESS_KEY

  if (!configCompleta(datos)) return { ok: false, error: 'Faltan datos obligatorios.' }
  guardarConfig(datos)
  app.relaunch()
  app.exit(0)
  return { ok: true }
})

ipcMain.handle('config:ruta', () => rutaConfig())

// --------------------------------------------------------------- ciclo

app.on('window-all-closed', () => app.quit())

app.on('second-instance', () => {
  if (ventana) {
    if (ventana.isMinimized()) ventana.restore()
    ventana.focus()
  }
})
