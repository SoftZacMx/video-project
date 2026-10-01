// Copia de archivo con errores de I/O atrapados (EIO del lector optico).
// Sin listener en WriteStream, Node mata el proceso entero.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Copia src → dest. Rechaza si falla la lectura o la escritura.
 * Nunca deja un 'error' de stream sin listener: no tumba el proceso.
 */
export async function copiarArchivo(src, dest, onBytes = () => {}) {
  await mkdir(dirname(dest), { recursive: true })
  return new Promise((resolve, reject) => {
    const rs = createReadStream(src, { highWaterMark: 1024 * 1024 })
    const ws = createWriteStream(dest)
    let bytes = 0
    let cerrado = false

    const fallar = (err) => {
      if (cerrado) return
      cerrado = true
      rs.destroy()
      ws.destroy()
      rm(dest, { force: true }).finally(() => reject(err))
    }

    rs.on('error', fallar)
    ws.on('error', fallar)
    rs.on('data', (chunk) => {
      bytes += chunk.length
      onBytes(bytes)
    })
    ws.on('finish', () => {
      if (cerrado) return
      cerrado = true
      resolve(bytes)
    })
    rs.pipe(ws)
  })
}
