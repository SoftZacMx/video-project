// Configuracion del proyecto, leida SOLO del .env.
//
// Regla importante: si falta alguna credencial, esto aborta. NO se permite
// que el SDK de AWS caiga en la cadena de credenciales por defecto
// (~/.aws/credentials, variables del sistema, rol de instancia), porque eso
// haria que la herramienta suba a la cuenta equivocada en silencio.

const req = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET']

export const SOLO_LOCAL = process.env.SOLO_LOCAL === '1'

/** Modo demostracion: simula un disco para poder ver la interfaz sin lector. */
export const DEMO = process.env.DEMO === '1'

export const OUT_DIR = process.env.OUT_DIR || '/Users/brrodriguez/videosTest'

/**
 * ¿Corre el lector de discos? En un contenedor no hay lector optico y los
 * comandos de macOS (diskutil, drutil) no existen, asi que el bucle de
 * deteccion no debe arrancar.
 */
export const RIPEADOR = process.env.RIPEADOR !== '0' && process.platform === 'darwin'

export const PORT = Number(process.env.PORT) || 5177

/**
 * Dos papeles para el mismo codigo:
 *
 *   'ripeador' — app de escritorio. Lee discos y sube a S3. SIN login, sin
 *                base de datos, sin usuarios: quien esta frente al lector con
 *                el disco en la mano es el operador, no hay de quien
 *                distinguirlo. Necesita llave con permiso de escritura.
 *
 *   'portal'   — servicio en linea. Usuarios, descargas y registro. No toca
 *                el lector. Le basta una llave de solo lectura.
 *
 * Por defecto 'portal', que es el comportamiento que ya existia.
 */
export const MODO = process.env.MODO === 'ripeador' ? 'ripeador' : 'portal'
export const ES_RIPEADOR = MODO === 'ripeador'

function validar() {
  if (SOLO_LOCAL || DEMO) return null // la demo no toca S3 ni pide credenciales

  const faltan = req.filter((k) => !process.env[k]?.trim())
  if (faltan.length) {
    console.error('\n  ✗ Falta configuracion en .env:\n')
    for (const k of faltan) console.error(`      ${k}`)
    console.error(`
  Pasos:
      cp .env.example .env       # y rellena los valores
      node --env-file=.env server.mjs

  Si solo quieres ripear a disco sin subir a S3:
      SOLO_LOCAL=1 node server.mjs
`)
    process.exit(1)
  }

  return {
    region: process.env.AWS_REGION.trim(),
    bucket: process.env.S3_BUCKET.trim(),
    prefix: (process.env.S3_PREFIX || 'discos').trim().replace(/^\/+|\/+$/g, ''),
    storageClass: (process.env.S3_STORAGE_CLASS || 'STANDARD_IA').trim(),
    // credenciales explicitas: nunca implicitas
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
    },
  }
}

export const S3 = validar()
