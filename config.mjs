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
