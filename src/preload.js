const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('hub', {
  state: call('state'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  saveProfile: call('profile:save'),
  deleteProfile: call('profile:delete'),
  openProfile: call('profile:open'),
  closeProfileTabs: call('profile:closeTabs'),
  newTab: call('tab:new'),
  closeTab: call('tab:close'),
  activateTab: call('tab:activate'),
  go: call('nav:go'),
  back: call('nav:back'),
  forward: call('nav:forward'),
  reload: call('nav:reload'),
  modal: call('ui:modal'),
});
