const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('launcher', {
  state: call('state'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  save: call('profile:save'),
  remove: call('profile:delete'),
  launch: call('profile:launch'),
  close: call('profile:close'),
  pickDir: call('dialog:dir'),
  scan: call('scan'),
  saveCard: call('card:save'),
  deleteCard: call('card:delete'),
  copyCard: call('card:copy'),
  pickExtension: call('ext:pick'),
  openStore: call('ext:store'),
  pickChrome: call('chrome:pick'),
  revealData: call('data:reveal'),
});
