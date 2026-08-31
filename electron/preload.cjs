// Puente entre la ventana de configuracion y el proceso principal.
// Solo expone estas tres funciones: la ventana no tiene acceso a Node.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cfg', {
  leer: () => ipcRenderer.invoke('config:leer'),
  guardar: (datos) => ipcRenderer.invoke('config:guardar', datos),
  ruta: () => ipcRenderer.invoke('config:ruta'),
})
