const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const chrome = require('./chrome');
const cardLib = require('./card');
const px = require('./proxy');
const { createRelay, checkExit } = require('./relay');
const { attachEmulation } = require('./cdp');

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

// 代理密码同样用 Windows DPAPI 加密保存
const encStr = (str) => safeStorage.encryptString(str).toString('base64');
function decStr(enc) { try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; } }
const findProxy = (id) => data.proxies.find((x) => x.id === id);

// 分身的代理设置:{ proxyId, country, state, city, sticky, session }
const NET_DEFAULT = { proxyId: '', country: 'us', state: '', city: '', sticky: false, session: '' };
const netOf = (p) => ({ ...NET_DEFAULT, ...(p.net || {}) });

// 组装发给上游的账号密码。IPRoyal 的地区和 session 写在密码后面
function upstreamFor(proxy, net, session) {
  const password = decStr(proxy.enc || '');
  if (password === null) throw new Error('代理密码无法解密(可能是从别的电脑复制来的),请到 IP 池重新填写密码');
  const up = { protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username };
  up.password = px.isIproyal(proxy.host)
    ? px.buildIproyalPassword(password, { country: net.country, state: net.state, city: net.city, session, lifetime: net.sticky ? '7d' : '24h' })
    : password;
  return up;
}

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
let data = { chromePath: '', profiles: [], cards: [], proxies: [] };
let running = new Map();
// 走代理启动的分身:profileId -> { relay, child, exit: {ip,country,city,timezone,locale,ms}, startedAt }
const live = new Map();
const launching = new Set();
let tray = null;
let quitting = false;

function load() {
  try { data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { /* 首次运行 */ }
  if (!Array.isArray(data.proxies)) data.proxies = [];
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
      net: netOf(p),
      exit: live.has(p.id) ? live.get(p.id).exit : null,
      // 最近 3 分钟内的转发失败
      netFailures: live.has(p.id) ? live.get(p.id).relay.stats.failures.filter((f) => Date.now() - f.at < 180000) : [],
      launching: launching.has(p.id),
      // 绑定了代理、浏览器开着,但中转不在了(比如启动器被关过):此时浏览器上不了网
      proxyLost: !!(netOf(p).proxyId && findProxy(netOf(p).proxyId) && running.get(chrome.normDir(p.dir)) && !live.has(p.id)),
    })),
    proxies: data.proxies.map((x) => ({
      id: x.id, label: x.label, protocol: x.protocol, host: x.host, port: x.port, username: x.username,
      iproyal: px.isIproyal(x.host), broken: !!x.enc && decStr(x.enc) === null,
      profileIds: data.profiles.filter((p) => netOf(p).proxyId === x.id).map((p) => p.id),
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
  // 有分身正在走代理时,关闭窗口只是收到托盘,否则这些浏览器会断网
  win.on('close', (e) => {
    if (quitting || live.size === 0) return;
    e.preventDefault();
    win.hide();
    showTray(true);
  });
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
  if (d.net) {
    const old = netOf(p);
    const n = {
      proxyId: findProxy(d.net.proxyId) ? d.net.proxyId : '',
      country: px.slug(d.net.country), state: px.slug(d.net.state), city: px.slug(d.net.city),
      sticky: !!d.net.sticky,
    };
    // 固定 IP:地区没变就沿用原 session;改了地区则换新的
    const sameArea = old.proxyId === n.proxyId && old.country === n.country && old.state === n.state && old.city === n.city;
    n.session = n.sticky ? ((sameArea && old.session) || px.newSessionId()) : '';
    p.net = n;
  }
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
  return startProfile(p, { home: 'https://chromewebstore.google.com/detail/' + extId });
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
  return startProfile(p);
});

// 启动分身。绑定了代理的:先开中转、查出口 IP,再带上语言/时区启动
async function startProfile(p, override = {}) {
  const net = netOf(p);
  const proxy = net.proxyId && findProxy(net.proxyId);
  const isRunning = running.has(chrome.normDir(p.dir)) || live.has(p.id);
  if (!proxy || isRunning) {
    // 已经在运行:Chrome 会把新窗口交给原来的进程,沿用原来的代理
    if (proxy && !live.has(p.id)) return { error: '这个分身是在代理断开的状态下运行的,请先关闭它再重新启动' };
    chrome.launch(data.chromePath, { ...p, ...override });
    afterLaunch();
    return { ok: true };
  }
  if (launching.has(p.id)) return { error: '正在启动中,请稍候' };
  launching.add(p.id); push();
  let relay;
  try {
    const session = net.sticky ? (net.session || px.newSessionId()) : px.newSessionId();
    relay = await createRelay(upstreamFor(proxy, net, session));
    const exit = await checkExit(relay.port).catch((e) => { throw new Error(relay.stats.lastError || e.message); });
    exit.locale = px.localeFor(exit.countryCode);
    const acceptLang = px.acceptLanguage(exit.locale);
    try { chrome.patchPreferences(p.dir, { acceptLang }); } catch { /* 偏好文件写不了不影响启动 */ }
    const child = chrome.launchControlled(data.chromePath, { ...p, ...override }, { proxyPort: relay.port, locale: exit.locale, acceptLang });
    attachEmulation(child, { timezoneId: exit.timezone, locale: exit.locale });
    const entry = { relay, child, exit, startedAt: Date.now() };
    live.set(p.id, entry);
    child.on('exit', () => {
      relay.close();
      if (live.get(p.id) === entry) live.delete(p.id);
      refresh();
    });
    afterLaunch();
    return { ok: true, exit };
  } catch (e) {
    if (relay) relay.close();
    return { error: '代理连接失败:' + e.message };
  } finally {
    launching.delete(p.id); push();
  }
}

// ---- IP 池 ----
ipcMain.handle('proxy:save', (_e, d) => {
  const existing = findProxy(d.id);
  let fields = {
    protocol: d.protocol === 'socks5' ? 'socks5' : 'http',
    host: (d.host || '').trim(), port: Number(d.port), username: (d.username || '').trim(), password: d.password || '',
  };
  if ((d.line || '').trim()) {
    const parsed = px.parseProxyLine(d.line);
    if (!parsed) return { error: '无法识别这行代理,支持 host:port:用户名:密码 或 用户名:密码@host:port' };
    fields = parsed;
  }
  if (!fields.host) return { error: '请填写主机' };
  if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535) return { error: '端口不正确' };
  let area = {};
  // 粘贴的 IPRoyal 密码里如果带了地区/session 参数,只保存原始密码,地区在分身里单独设置
  if (px.isIproyal(fields.host) && fields.password) {
    const sp = px.splitIproyalPassword(fields.password);
    fields.password = sp.base;
    area = sp.params;
  }
  if (!fields.password && !(existing && existing.enc) && fields.username) return { error: '请填写密码' };
  if (fields.password && !safeStorage.isEncryptionAvailable()) return { error: '系统加密不可用,无法安全保存密码' };
  let x = existing;
  if (!x) { x = { id: crypto.randomUUID() }; data.proxies.push(x); }
  Object.assign(x, {
    label: (d.label || '').trim() || `${fields.host}:${fields.port}`,
    protocol: fields.protocol, host: fields.host, port: fields.port, username: fields.username,
  });
  if (fields.password) x.enc = encStr(fields.password);
  save(); push();
  return { ok: true, id: x.id, area };
});

ipcMain.handle('proxy:delete', (_e, id) => {
  if (data.profiles.some((p) => netOf(p).proxyId === id && live.has(p.id))) return { error: '有分身正在用这个代理,请先关闭' };
  data.proxies = data.proxies.filter((x) => x.id !== id);
  for (const p of data.profiles) if (p.net && p.net.proxyId === id) p.net.proxyId = '';
  save(); push();
  return { ok: true };
});

// 检测:用一个新 session 连一次,返回出口 IP、地区、时区和耗时
ipcMain.handle('proxy:test', async (_e, id, area = {}) => {
  const proxy = findProxy(id);
  if (!proxy) return { error: '代理不存在' };
  let relay;
  try {
    const net = { ...NET_DEFAULT, ...area, country: px.slug(area.country), state: px.slug(area.state), city: px.slug(area.city) };
    relay = await createRelay(upstreamFor(proxy, net, px.newSessionId()));
    const exit = await checkExit(relay.port).catch((e) => { throw new Error(relay.stats.lastError || e.message); });
    return { ok: true, exit: { ...exit, locale: px.localeFor(exit.countryCode) } };
  } catch (e) {
    return { error: e.message };
  } finally { if (relay) relay.close(); }
});

ipcMain.handle('profile:close', async (_e, id, force) => {
  const p = find(id);
  const pid = p && (running.get(chrome.normDir(p.dir)) || (live.has(p.id) && live.get(p.id).child.pid));
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

const TRAY_ICON = path.join(__dirname, 'ui', 'tray.png');
function showTray(notify) {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Chrome分身启动器');
    tray.on('click', () => { win.show(); win.focus(); });
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: live.size ? `退出(${live.size} 个代理分身会一起关闭)` : '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  if (notify && tray.displayBalloon) {
    tray.displayBalloon({ title: '启动器还在后台运行', content: `有 ${live.size} 个分身正在走代理,关闭启动器会让它们断网。右键托盘图标可以退出。` });
  }
}

ipcMain.handle('data:reveal', () => { save(); shell.showItemInFolder(DATA_FILE); });

app.whenReady().then(() => {
  load();
  migrateCards();
  createWindow();
  setInterval(refresh, 4000);
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
// 退出时关掉所有中转;Chrome 那头的管道断开后会自己关闭
app.on('will-quit', () => { for (const x of live.values()) { try { x.relay.close(); } catch { /* */ } } });
