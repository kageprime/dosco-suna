// Preload for the HTTP Basic credential dialog (assets/basic-auth.html).
// Isolated context; the page gets three functions and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  /** Main → page: host / realm / prefilled user / error text. */
  onInit: (cb) => ipcRenderer.on('kortix:basic-auth:init', (_e, init) => cb(init)),
  submit: ({ user, password, remember }) =>
    ipcRenderer.send('kortix:basic-auth:submit', {
      user: String(user ?? ''),
      password: String(password ?? ''),
      remember: Boolean(remember),
    }),
  cancel: () => ipcRenderer.send('kortix:basic-auth:cancel'),
};

contextBridge.exposeInMainWorld('doscoBasicAuth', api);
contextBridge.exposeInMainWorld('kortixBasicAuth', api);
