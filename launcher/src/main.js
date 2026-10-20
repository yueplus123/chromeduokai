const { app, BrowserWindow, Menu, ipcMain, dialog, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const chrome = require('./chrome');
const cardLib = require('./card');

const CLIPBOARD_CLEAR_MS = 30000;
const CARD_FIELDS = ['holder', 'number', 'exp', 'cvv'];

// 卡库:data.cards = [{ id, label, note, enc }],enc 是 Windows DPAPI(safeStorage)加密后的 base64,配置文件里没有明文
// 窗口通过 profile.cardIds 引用卡库里的卡
function readCard(card) {
  if (!card || !card.enc) return null;
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(card.enc, 'base64'))); } catch { return null; }
}
function cardSummary(card) {
  const c = readCard(card);
  const base = { id: card.id, label: card.label, note: card.note || '' };
  if (!c) return { ...base, broken: true };
  return { ...base, last4: cardLib.last4(c.number), holder: c.holder, exp: c.exp, hasCvv: !!c.cvv };
}
const findCard = (id) => data.cards.find((c) => c.id === id);

// 旧版把卡直接存在窗口里(profile.cardEnc),迁移进卡库
function migrateCards() {
  let changed = false;
  for (const p of data.profiles) {
    if (!p.cardEnc) continue;
    const old = { enc: p.cardEnc };
    const c = readCard(old);
    const card = { id: crypto.randomUUID(), label: c ? `${p.name} 的卡 ••${cardLib.last4(c.number)}` : `${p.name} 的卡`, note: '', enc: p.cardEnc };
    data.cards.push(card);
    p.cardIds = [...(p.cardIds || []), card.id];
    delete p.cardEnc;
    changed = true;
  }
  if (changed) save();
}

// 数据放在项目的 data 目录里,换电脑时整个复制过去即可
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'profiles.json');

let win = null;
let data = { chromePath: '', profiles: [], cards: [] };
let running = new Map();

function load() {
  try { data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { /* 首次运行 */ }
  if (!data.chromePath || !fs.existsSync(data.chromePath)) data.chromePath = chrome.findChrome();
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function snapshot() {
  return {
    chromePath: data.chromePath,
    chromeOk: !!data.chromePath && fs.existsSync(data.chromePath),
    profiles: data.profiles.map((p) => ({
      ...p,
      mode: p.mode || 'normal',
      extensions: p.extensions || [],
      cardIds: (p.cardIds || []).filter(findCard),
      dirExists: fs.existsSync(p.dir),
      pid: running.get(chrome.normDir(p.dir)) || null,
    })),
    cards: data.cards.map((c) => ({
      ...cardSummary(c),
      profileIds: data.profiles.filter((p) => (p.cardIds || []).includes(c.id)).map((p) => p.id),
    })),
  };
}
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); };

async function refresh() {
  running = await chrome.listRunning();
  push();
}

const find = (id) => data.profiles.find((p) => p.id === id);
const afterLaunch = () => { setTimeout(refresh, 1500); setTimeout(refresh, 4000); };

function createWindow() {
  Menu.setApplicationMenu(null); // 先去掉菜单栏,否则隐藏后内容区会被撑高
  win = new BrowserWindow({
    // 固定窗口大小:界面按这个尺寸设计,不允许拖动改变,也不允许最大化/全屏
    width: 1280, height: 780, useContentSize: true,
    minWidth: 1280, minHeight: 780, maxWidth: 1280, maxHeight: 780,
    resizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#f2f0eb', title: 'Chrome分身启动器',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // 禁止 Ctrl+滚轮 / Ctrl+± 缩放页面,避免字体大小被改动
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.control && ['+', '-', '=', '0'].includes(input.key)) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.on('did-finish-load', () => { push(); refresh(); });
}

ipcMain.handle('state', () => snapshot());

ipcMain.handle('profile:save', (_e, d) => {
  if (!d.dir || !d.dir.trim()) return { error: '请选择数据文件夹' };
  const dir = d.dir.trim();
  const dup = data.profiles.find((p) => p.id !== d.id && chrome.normDir(p.dir) === chrome.normDir(dir));
  if (dup) return { error: `该文件夹已被「${dup.name}」使用` };
  let p = find(d.id);
  if (!p) { p = { id: crypto.randomUUID(), cardIds: [] }; data.profiles.push(p); }
  Object.assign(p, {
    name: (d.name || '').trim() || path.basename(dir), dir, color: d.color || '#00754A',
    mode: d.mode === 'incognito' ? 'incognito' : 'normal',
    home: (d.home || '').trim(), extraArgs: (d.extraArgs || '').trim(), note: d.note || '',
    extensions: Array.isArray(d.extensions) ? d.extensions.filter((x) => chrome.isExtensionDir(x)) : (p.extensions || []),
  });
  delete p.proxy;
  save(); refresh();
  return { ok: true };
});

// 保存一张卡并设置它用于哪些窗口。编辑时卡号留空 = 沿用旧卡号;填了新卡号则 CVV 不再沿用旧的
ipcMain.handle('card:save', (_e, d) => {
  const existing = findCard(d.id);
  const input = cardLib.normalizeCard(d);
  const old = (existing && readCard(existing)) || {};
  const merged = { ...input, number: input.number || old.number || '', cvv: input.cvv || (input.number ? '' : old.cvv || '') };
  const err = cardLib.validateCard(merged);
  if (err) return { error: err };
  if (!safeStorage.isEncryptionAvailable()) return { error: '系统加密不可用,无法安全保存卡信息' };
  const enc = safeStorage.encryptString(JSON.stringify(merged)).toString('base64');
  let card = existing;
  if (!card) { card = { id: crypto.randomUUID() }; data.cards.push(card); }
  Object.assign(card, {
    enc, note: (d.note || '').trim(),
    label: (d.label || '').trim() || `卡 ••${cardLib.last4(merged.number)}`,
  });
  const use = new Set(Array.isArray(d.profileIds) ? d.profileIds : []);
  for (const p of data.profiles) {
    const ids = (p.cardIds || []).filter((x) => x !== card.id);
    if (use.has(p.id)) ids.push(card.id);
    p.cardIds = ids;
  }
  save(); push();
  return { ok: true };
});

ipcMain.handle('card:delete', (_e, id) => {
  data.cards = data.cards.filter((c) => c.id !== id);
  for (const p of data.profiles) p.cardIds = (p.cardIds || []).filter((x) => x !== id);
  save(); push();
});

ipcMain.handle('card:copy', (_e, id, field) => {
  if (!CARD_FIELDS.includes(field)) return { error: '未知字段' };
  const c = readCard(findCard(id));
  if (!c || !c[field]) return { error: '没有这项信息' };
  clipboard.writeText(c[field]);
  const copied = c[field];
  setTimeout(() => { if (clipboard.readText() === copied) clipboard.clear(); }, CLIPBOARD_CLEAR_MS);
  return { ok: true, seconds: CLIPBOARD_CLEAR_MS / 1000 };
});

ipcMain.handle('ext:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择已解压的插件文件夹(里面要有 manifest.json)', properties: ['openDirectory'] });
  if (r.canceled) return null;
  if (!chrome.isExtensionDir(r.filePaths[0])) return { error: '该文件夹里没有 manifest.json,不是插件目录' };
  return { dir: r.filePaths[0] };
});

// 在该分身里打开插件商店页面,安装后插件会保存在分身自己的数据里
ipcMain.handle('ext:store', (_e, id, input) => {
  const p = find(id);
  if (!p) return { error: '分身不存在' };
  if (!data.chromePath || !fs.existsSync(data.chromePath)) return { error: '找不到 Chrome' };
  const extId = chrome.parseStoreId(input);
  if (!extId) return { error: '没找到有效的插件 ID(32 位字母),请粘贴商店链接或 ID' };
  chrome.launch(data.chromePath, { ...p, home: 'https://chromewebstore.google.com/detail/' + extId });
  afterLaunch();
  return { ok: true };
});

ipcMain.handle('profile:delete', (_e, id) => {
  // 只删除这条记录,绝不动磁盘上的数据文件夹,也不删卡库里的卡
  data.profiles = data.profiles.filter((p) => p.id !== id);
  save(); push();
});

ipcMain.handle('profile:launch', (_e, id) => {
  const p = find(id);
  if (!p) return { error: '分身不存在' };
  if (!data.chromePath || !fs.existsSync(data.chromePath)) return { error: '找不到 Chrome,请先在右上角设置 Chrome 路径' };
  chrome.launch(data.chromePath, p);
  afterLaunch();
  return { ok: true };
});

ipcMain.handle('profile:close', async (_e, id, force) => {
  const p = find(id);
  const pid = p && running.get(chrome.normDir(p.dir));
  if (pid) await chrome.closeProcess(pid, force);
  afterLaunch();
});

ipcMain.handle('dialog:dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择存放各分身数据文件夹的上级目录', properties: ['openDirectory'] });
  if (r.canceled) return null;
  const known = new Set(data.profiles.map((p) => chrome.normDir(p.dir)));
  const found = chrome.scanProfileDirs(r.filePaths[0]);
  let added = 0;
  for (const dir of found) {
    if (known.has(chrome.normDir(dir))) continue;
    data.profiles.push({ id: crypto.randomUUID(), name: path.basename(dir), dir, color: '#00754A', mode: 'normal', home: '', extensions: [], extraArgs: '', note: '' });
    added++;
  }
  if (added) { save(); refresh(); }
  return { found: found.length, added };
});

ipcMain.handle('chrome:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择 chrome.exe', properties: ['openFile'], filters: [{ name: 'chrome.exe', extensions: ['exe'] }] });
  if (r.canceled) return;
  data.chromePath = r.filePaths[0];
  save(); push();
});

ipcMain.handle('data:reveal', () => { save(); shell.showItemInFolder(DATA_FILE); });

app.whenReady().then(() => {
  load();
  migrateCards();
  createWindow();
  setInterval(refresh, 4000);
});
app.on('window-all-closed', () => app.quit());
