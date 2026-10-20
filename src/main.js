const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SIDEBAR = 220;
const TOP = 88; // 标签栏 40 + 工具栏 48

let win = null;
let profiles = [];
let currentId = null;
let modalOpen = false;
// profileId -> { tabs: [{id, view, title, url, loading}], activeId }
const runtime = new Map();

const storeFile = () => path.join(app.getPath('userData'), 'profiles.json');
const partitionOf = (id) => `persist:profile-${id}`;

function loadProfiles() {
  try { profiles = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { profiles = []; }
}
function saveProfiles() {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(profiles, null, 2));
}

function defaultUA() {
  return session.defaultSession.getUserAgent()
    .replace(/\s*Electron\/\S+/, '')
    .replace(new RegExp(`\\s*${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S+`), '');
}

function applySession(p) {
  const ses = session.fromPartition(partitionOf(p.id));
  ses.setUserAgent(p.ua || defaultUA(), p.lang || 'zh-CN,zh;q=0.9,en;q=0.8');
  ses.setProxy(p.proxy ? { proxyRules: p.proxy } : { mode: 'system' });
  return ses;
}

const rt = (id) => {
  if (!runtime.has(id)) runtime.set(id, { tabs: [], activeId: null });
  return runtime.get(id);
};

function normalizeUrl(input) {
  const s = (input || '').trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?/.test(s)) return 'https://' + s;
  return 'https://www.baidu.com/s?wd=' + encodeURIComponent(s);
}

function snapshot() {
  const r = currentId ? rt(currentId) : null;
  const active = r && r.tabs.find((t) => t.id === r.activeId);
  const wc = active && active.view.webContents;
  return {
    profiles: profiles.map((p) => ({ ...p, tabCount: runtime.has(p.id) ? runtime.get(p.id).tabs.length : 0 })),
    currentId,
    tabs: r ? r.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, loading: t.loading })) : [],
    activeId: r ? r.activeId : null,
    canGoBack: !!wc && wc.navigationHistory.canGoBack(),
    canGoForward: !!wc && wc.navigationHistory.canGoForward(),
    defaultUA: defaultUA(),
  };
}
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); };

function layout() {
  if (!win || !currentId) return;
  const [w, h] = win.getContentSize();
  const r = rt(currentId);
  for (const t of r.tabs) {
    const show = !modalOpen && t.id === r.activeId;
    t.view.setVisible(show);
    t.view.setBounds({ x: SIDEBAR, y: TOP, width: Math.max(0, w - SIDEBAR), height: Math.max(0, h - TOP) });
  }
}

function hideAllViews() {
  for (const r of runtime.values()) for (const t of r.tabs) t.view.setVisible(false);
}

async function setupEmulation(wc, p) {
  if (!p.timezone && !p.locale) return;
  try {
    wc.debugger.attach('1.3');
    if (p.timezone) await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: p.timezone });
    const loc = (p.lang || '').split(',')[0].trim();
    if (loc) await wc.debugger.sendCommand('Emulation.setLocaleOverride', { locale: loc });
  } catch (e) { console.warn('emulation failed', e.message); }
}

function createTab(profileId, url) {
  const p = profiles.find((x) => x.id === profileId);
  if (!p) return;
  const ses = applySession(p);
  const view = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const wc = view.webContents;
  const tab = { id: crypto.randomUUID(), view, title: '新标签页', url: '', loading: false };
  const r = rt(profileId);
  r.tabs.push(tab);
  r.activeId = tab.id;
  win.contentView.addChildView(view);
  setupEmulation(wc, p);

  const upd = () => { tab.url = wc.getURL(); tab.title = wc.getTitle() || tab.url || '新标签页'; push(); };
  wc.on('page-title-updated', upd);
  wc.on('did-navigate', upd);
  wc.on('did-navigate-in-page', upd);
  wc.on('did-start-loading', () => { tab.loading = true; push(); });
  wc.on('did-stop-loading', () => { tab.loading = false; upd(); });
  wc.setWindowOpenHandler(({ url: u }) => { createTab(profileId, u); layout(); push(); return { action: 'deny' }; });

  wc.loadURL(normalizeUrl(url || p.home || 'https://www.baidu.com'));
  layout();
  push();
}

function closeTab(profileId, tabId) {
  const r = rt(profileId);
  const i = r.tabs.findIndex((t) => t.id === tabId);
  if (i < 0) return;
  const [t] = r.tabs.splice(i, 1);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (r.activeId === tabId) r.activeId = r.tabs.length ? r.tabs[Math.min(i, r.tabs.length - 1)].id : null;
  if (!r.tabs.length && profileId === currentId) createTab(profileId);
  layout();
  push();
}

function activeWC() {
  if (!currentId) return null;
  const r = rt(currentId);
  const t = r.tabs.find((x) => x.id === r.activeId);
  return t ? t.view.webContents : null;
}

function destroyProfileRuntime(id) {
  const r = runtime.get(id);
  if (!r) return;
  for (const t of r.tabs) { win.contentView.removeChildView(t.view); t.view.webContents.close(); }
  runtime.delete(id);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#15171c', title: '分身聚合浏览器',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.webContents.on('did-finish-load', push);
}

// ---- IPC ----
ipcMain.handle('state', () => snapshot());

ipcMain.handle('profile:save', (_e, data) => {
  let p = profiles.find((x) => x.id === data.id);
  if (!p) { p = { id: crypto.randomUUID() }; profiles.push(p); }
  Object.assign(p, {
    name: (data.name || '未命名').trim(), color: data.color || '#4f8cff',
    ua: (data.ua || '').trim(), lang: (data.lang || '').trim(), timezone: (data.timezone || '').trim(),
    proxy: (data.proxy || '').trim(), proxyUser: data.proxyUser || '', proxyPass: data.proxyPass || '',
    home: (data.home || '').trim(), note: data.note || '',
  });
  saveProfiles();
  applySession(p);
  push();
  return p.id;
});

ipcMain.handle('profile:delete', async (_e, id) => {
  destroyProfileRuntime(id);
  try { await session.fromPartition(partitionOf(id)).clearStorageData(); } catch {}
  profiles = profiles.filter((p) => p.id !== id);
  saveProfiles();
  if (currentId === id) currentId = null;
  push();
});

ipcMain.handle('profile:open', (_e, id) => {
  if (!profiles.some((p) => p.id === id)) return;
  if (currentId && currentId !== id) for (const t of rt(currentId).tabs) t.view.setVisible(false);
  currentId = id;
  if (!rt(id).tabs.length) createTab(id); else { layout(); push(); }
});

ipcMain.handle('profile:closeTabs', (_e, id) => { destroyProfileRuntime(id); if (currentId === id) currentId = null; push(); });

ipcMain.handle('tab:new', (_e, url) => { if (currentId) createTab(currentId, url); });
ipcMain.handle('tab:close', (_e, id) => { if (currentId) closeTab(currentId, id); });
ipcMain.handle('tab:activate', (_e, id) => { if (currentId) { rt(currentId).activeId = id; layout(); push(); } });
ipcMain.handle('nav:go', (_e, url) => { const wc = activeWC(); if (wc) wc.loadURL(normalizeUrl(url)); });
ipcMain.handle('nav:back', () => { const wc = activeWC(); if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); });
ipcMain.handle('nav:forward', () => { const wc = activeWC(); if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); });
ipcMain.handle('nav:reload', () => { const wc = activeWC(); if (wc) (wc.isLoading() ? wc.stop() : wc.reload()); });
// 弹窗打开时原生视图会盖住 UI,需要先隐藏
ipcMain.handle('ui:modal', (_e, open) => { modalOpen = !!open; layout(); });

// 代理认证
app.on('login', (event, wc, _req, authInfo, cb) => {
  if (!authInfo.isProxy) return;
  for (const [pid, r] of runtime) {
    if (r.tabs.some((t) => t.view.webContents === wc)) {
      const p = profiles.find((x) => x.id === pid);
      if (p && p.proxyUser) { event.preventDefault(); cb(p.proxyUser, p.proxyPass); }
      return;
    }
  }
});

app.whenReady().then(() => { loadProfiles(); createWindow(); });
app.on('window-all-closed', () => app.quit());
