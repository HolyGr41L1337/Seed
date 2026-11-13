// The only bridge between the page and the desktop app: which platform the
// window runs on (for the title bar layout) and the system folder picker.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seedDesktop', {
  platform: process.platform,
  /** Opens the system folder picker. Resolves to the chosen absolute path, or null. */
  chooseFolder: (defaultPath) => ipcRenderer.invoke('seed:choose-folder', typeof defaultPath === 'string' ? defaultPath : null),
});
