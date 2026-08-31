# Imagen del portal (usuarios y descargas).
#
# El ripeador NO corre aqui: necesita el lector optico y comandos de macOS
# (diskutil, drutil, osascript). Por eso RIPEADOR=0, que desactiva el bucle
# de deteccion de discos. El ripeo se sigue haciendo nativo en la Mac.
#
# Debian (slim) y no Alpine a proposito: better-sqlite3 es un modulo nativo y
# en Alpine (musl) no hay binario precompilado, habria que compilarlo.

# --- etapa 1: dependencias -------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app

# por si el precompilado de better-sqlite3 no estuviera disponible
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# --- etapa 2: imagen final -------------------------------------------------
FROM node:20-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=5177 \
    DB_PATH=/datos/registro.db \
    OUT_DIR=/datos/local \
    RIPEADOR=0 \
    COOKIE_SEGURA=1

# el volumen debe pertenecer al usuario que corre el proceso
RUN mkdir -p /datos/local && chown -R node:node /datos

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# nunca correr como root
USER node

EXPOSE 5177
VOLUME ["/datos"]

# la base de datos vive en el volumen: sin esto, cada redeploy borra usuarios
CMD ["node", "server.mjs"]
