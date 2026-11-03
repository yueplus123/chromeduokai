// IPRoyal 链式代理自动配置工具(配合 Clash Verge 使用)
//
// 做的事:
//   1. 找到 Clash Verge,连上它的控制接口
//   2. 把当前订阅里的机场节点逐个试一遍:节点能不能连到 IPRoyal、IPRoyal 接不接受、能不能拿到住宅出口 IP
//   3. 把能用的节点写进当前订阅的「编辑节点」「编辑代理组」(原文件先备份)
//   4. 你在 Clash 里点一次「使用」后,自动验证住宅 IP 是否生效
//
// 用法:双击项目根目录的「住宅IP自动配置.bat」,或  node launcher/tools/find-chain.js [代理串]
// 测试用环境变量:CLASH_VERGE_DIR(Clash Verge 数据目录)、FIND_CHAIN_YES=1(不询问直接执行)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tls = require('tls');
const readline = require('readline');
const px = require('../src/proxy');
const { openTunnel } = require('../src/relay');

const PROBE_URL = 'http://www.gstatic.com/generate_204';
const ENTRIES = ['geo.iproyal.com', 'us.proxy.iproyal.com'];
const MAX_NODES = 15;      // 最多实测多少个节点
const WANT_OK = 3;         // 找到几个能用的就停
const STEP_MS = 12000;

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);
const BUILTIN_TYPES = new Set(['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'Dns']);
const RES_PROXY = '住宅IP-美国';
const RES_GROUP = '住宅IP';
const EXIT_GROUP = '住宅出国';

// ---------- 小工具 ----------
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
let rl;
function ask(q) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => r(a.trim())));
}
const yaml = (s) => JSON.stringify(String(s)); // 双引号字符串在 YAML 里同样合法,可以安全放表情和空格

// ---------- 找 Clash Verge ----------
function vergeDirs() {
  if (process.env.CLASH_VERGE_DIR) return [process.env.CLASH_VERGE_DIR];
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return ['io.github.clash-verge-rev.clash-verge-rev', 'clash-verge', 'io.github.clash-verge'].map((d) => path.join(base, d));
}
function findVerge() {
  for (const dir of vergeDirs()) {
    // clash-verge.yaml 是 Clash Verge 生成的运行时配置;老版本可能叫 config.yaml
    for (const f of ['clash-verge.yaml', 'config.yaml']) {
      const runtime = path.join(dir, f);
      if (fs.existsSync(runtime)) return { dir, runtime: fs.readFileSync(runtime, 'utf8') };
    }
  }
  return null;
}
const topKey = (text, key) => {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
};

// ---------- Clash 控制接口 ----------
function makeApi(runtime) {
  const pipe = topKey(runtime, 'external-controller-pipe');
  const ctl = topKey(runtime, 'external-controller');
  const secret = topKey(runtime, 'secret') || '';
  let target;
  if (process.platform === 'win32' && pipe) target = { socketPath: pipe };
  else if (ctl) {
    const [h, p] = ctl.replace(/^\[|\]$/g, '').split(/:(?=\d+$)/);
    target = { host: !h || h === '0.0.0.0' ? '127.0.0.1' : h, port: Number(p) };
  } else if (topKey(runtime, 'external-controller-unix')) target = { socketPath: topKey(runtime, 'external-controller-unix') };
  if (!target) return null;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ ...target, method, path: p, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`Clash 接口返回 ${res.statusCode}`), { status: res.statusCode }));
        try { resolve(b ? JSON.parse(b) : null); } catch { resolve(null); }
      });
    });
    req.setTimeout(STEP_MS, () => req.destroy(new Error('Clash 接口无响应')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  return {
    desc: target.socketPath || `${target.host}:${target.port}`,
    configs: () => call('GET', '/configs'),
    setMode: (mode) => call('PATCH', '/configs', { mode }),
    proxies: () => call('GET', '/proxies'),
    select: (group, name) => call('PUT', `/proxies/${encodeURIComponent(group)}`, { name }),
    delay: (name, ms = 5000) => call('GET', `/proxies/${encodeURIComponent(name)}/delay?timeout=${ms}&url=${encodeURIComponent(PROBE_URL)}`).then((r) => r && r.delay).catch(() => null),
  };
}

// ---------- 通过 Clash 测试链路 ----------
// 第 1 步:经节点连到 IPRoyal,不带密码发一个请求,IPRoyal 回 407 就说明"节点能连到 IPRoyal"
async function probeReach(front, entry) {
  const s = await withTimeout(openTunnel(front, entry, 12321), STEP_MS, '连接超时');
  try {
    const first = await withTimeout(new Promise((resolve, reject) => {
      let b = '';
      s.on('data', (d) => { b += d; if (b.includes('\r\n')) resolve(b.split('\r\n')[0]); });
      s.on('end', () => reject(new Error('没有回复(节点连不上 IPRoyal,多半屏蔽了 12321 端口)')));
      s.on('error', (e) => reject(e));
      s.resume();
      s.write(`GET / HTTP/1.1\r\nHost: ${entry}:12321\r\nConnection: close\r\n\r\n`);
    }), STEP_MS, '没有回复(节点连不上 IPRoyal,多半屏蔽了 12321 端口)');
    if (!/^HTTP\/1\.\d (407|400|403|200)/.test(first)) throw new Error('回复异常:' + first);
  } finally { s.destroy(); }
}

// 第 2、3 步:带账号密码经 IPRoyal 访问 ipinfo.io,读出口 IP
async function probeExit(front, entry, username, password) {
  const up = { protocol: 'http', host: entry, port: 12321, username, password, via: front };
  const s = await withTimeout(openTunnel(up, 'ipinfo.io', 443), STEP_MS * 2, 'IPRoyal 没有回应');
  try {
    return await withTimeout(new Promise((resolve, reject) => {
      const t = tls.connect({ socket: s, servername: 'ipinfo.io' });
      let b = '';
      t.setEncoding('utf8');
      t.on('secureConnect', () => t.write('GET /json HTTP/1.1\r\nHost: ipinfo.io\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n'));
      t.on('data', (d) => { b += d; });
      t.on('end', () => { try { resolve(JSON.parse(b.slice(b.indexOf('{')))); } catch { reject(new Error('读不到出口 IP')); } });
      t.on('error', (e) => reject(new Error('加密连接失败:' + e.message)));
    }), STEP_MS, '读取出口 IP 超时');
  } finally { s.destroy(); }
}

function explain(e) {
  const m = e.message || String(e);
  if (/407/.test(m)) return '账号或密码被 IPRoyal 拒绝';
  if (/断开/.test(m)) return 'IPRoyal 收到请求后直接断开(可能不接受这个节点的 IP)';
  return m;
}

// ---------- 写入 Clash Verge 订阅的增强配置 ----------
function findProfileFiles(dir) {
  const f = path.join(dir, 'profiles.yaml');
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const current = topKey(text, 'current');
  if (!current) return null;
  const blocks = text.split(/\n(?=- uid:)/);
  const block = blocks.find((b) => new RegExp(`^- uid:\\s*['"]?${current}['"]?\\s*$`, 'm').test(b));
  if (!block) return null;
  const name = (/^\s+name:\s*(.*)$/m.exec(block) || [])[1] || current;
  const fileOf = (uid) => {
    const item = blocks.find((b) => new RegExp(`^- uid:\\s*['"]?${uid}['"]?\\s*$`, 'm').test(b));
    const file = item && (/^\s+file:\s*['"]?([^'"\s]+)/m.exec(item) || [])[1];
    return path.join(dir, 'profiles', file || `${uid}.yaml`);
  };
  const opt = (k) => (new RegExp(`^\\s+${k}:\\s*['"]?([^'"\\s]+)`, 'm').exec(block) || [])[1];
  const proxiesUid = opt('proxies');
  const groupsUid = opt('groups');
  if (!proxiesUid || !groupsUid) return null;
  return { name: name.replace(/^['"]|['"]$/g, ''), proxies: fileOf(proxiesUid), groups: fileOf(groupsUid) };
}

function buildYaml({ entry, username, password, nodes }) {
  const proxies = [
    'prepend:',
    `  - name: ${yaml(RES_PROXY)}`,
    '    type: http',
    `    server: ${yaml(entry)}`,
    '    port: 12321',
    `    username: ${yaml(username)}`,
    `    password: ${yaml(password)}`,
    `    dialer-proxy: ${yaml(EXIT_GROUP)}`,
    'append: []',
    'delete: []',
    '',
  ].join('\n');
  const groups = [
    'prepend:',
    `  - name: ${yaml(RES_GROUP)}`,
    '    type: select',
    `    proxies: [${yaml(RES_PROXY)}]`,
    `  - name: ${yaml(EXIT_GROUP)}`,
    '    type: fallback',
    `    proxies: [${nodes.map(yaml).join(', ')}]`,
    `    url: ${yaml(PROBE_URL)}`,
    '    interval: 300',
    'append: []',
    'delete: []',
    '',
  ].join('\n');
  return { proxies, groups };
}

function backupAndWrite(file, content) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------- 主流程 ----------
async function main() {
  log('\n=== 住宅 IP 链式代理自动配置(IPRoyal + Clash Verge)===\n');

  const verge = findVerge();
  if (!verge) throw new Error('没找到 Clash Verge 的配置目录。请确认 Clash Verge 已安装并打开过。');
  const api = makeApi(verge.runtime);
  if (!api) throw new Error('Clash 没有开启控制接口。请在 Clash Verge「设置」里打开「外部控制」后重试。');
  let cfg;
  try { cfg = await api.configs(); } catch (e) {
    throw new Error(`连不上 Clash 控制接口(${api.desc}):${e.message}。请确认 Clash Verge 正在运行。`);
  }
  const mixed = cfg['mixed-port'] || cfg.port;
  if (!mixed) throw new Error('Clash 没有开启 HTTP/混合代理端口');
  const front = { protocol: 'http', host: '127.0.0.1', port: mixed };
  log(`✓ 已连上 Clash(控制接口 ${api.desc},代理端口 ${mixed})`);

  let line = process.argv[2] || process.env.FIND_CHAIN_PROXY || '';
  if (!line) line = await ask('\n请粘贴 IPRoyal 代理(格式 geo.iproyal.com:12321:用户名:密码),然后按回车:\n> ');
  const parsed = px.parseProxyLine(line);
  if (!parsed || !parsed.username) throw new Error('代理格式不对,应为 host:port:用户名:密码');
  const base = px.splitIproyalPassword(parsed.password).base;
  const username = parsed.username;

  // 记住用户原来的模式和选择,结束时恢复
  const all = await api.proxies();
  const orig = { mode: cfg.mode, global: all.proxies.GLOBAL && all.proxies.GLOBAL.now };
  let restored = false;
  const restore = async () => {
    if (restored) return; restored = true;
    try { if (orig.global) await api.select('GLOBAL', orig.global); } catch { /* */ }
    try { await api.setMode(orig.mode); } catch { /* */ }
  };
  process.on('SIGINT', async () => { log('\n已中断,正在恢复 Clash 原来的设置…'); await restore(); process.exit(1); });

  try {
    const nodes = Object.values(all.proxies).filter((p) => !GROUP_TYPES.has(p.type) && !BUILTIN_TYPES.has(p.type) && !/住宅IP/.test(p.name));
    if (!nodes.length) throw new Error('当前订阅里没有找到机场节点');
    log(`\n[1/4] 当前订阅有 ${nodes.length} 个节点,先测哪些节点本身能用…`);
    const alive = [];
    for (let i = 0; i < nodes.length; i += 10) {
      const batch = nodes.slice(i, i + 10);
      const ds = await Promise.all(batch.map((n) => api.delay(n.name)));
      batch.forEach((n, j) => { if (ds[j]) alive.push({ name: n.name, delay: ds[j] }); });
    }
    if (!alive.length) throw new Error('所有节点都测不通,请先确认机场能正常上网');
    // 美国节点优先(离 IPRoyal 美国出口近),其余按延迟排
    const isUS = (n) => /美国|美國|US|United States|🇺🇸|洛杉矶|圣何塞|硅谷|西雅图|纽约/i.test(n);
    alive.sort((a, b) => (isUS(b.name) - isUS(a.name)) || (a.delay - b.delay));
    log(`    能用的节点 ${alive.length} 个`);

    log(`\n[2/4] 逐个测试节点能否经 IPRoyal 拿到住宅 IP(最多测 ${MAX_NODES} 个,找到 ${WANT_OK} 个就停)…`);
    await api.setMode('global');
    const ok = [];
    let entryOk = null;
    for (const n of alive.slice(0, MAX_NODES)) {
      await api.select('GLOBAL', n.name);
      await sleep(300);
      let result = null;
      let reason = '';
      for (const entry of entryOk ? [entryOk] : ENTRIES) {
        try {
          await probeReach(front, entry);
        } catch (e) { reason = explain(e); continue; }
        try {
          const pass = px.buildIproyalPassword(base, { country: 'us', session: px.newSessionId(), lifetime: '10m' });
          const j = await probeExit(front, entry, username, pass);
          result = { entry, ip: j.ip, org: j.org || '', loc: [j.country, j.region, j.city].filter(Boolean).join(' / ') };
          break;
        } catch (e) { reason = explain(e); if (/账号或密码/.test(reason)) throw new Error('IPRoyal 拒绝了账号密码,请检查用户名和密码'); }
      }
      if (result) {
        entryOk = result.entry;
        ok.push(n.name);
        log(`    ✓ ${n.name}  →  ${result.ip}  ${result.org}  (${result.loc})`);
        if (ok.length >= WANT_OK) break;
      } else {
        log(`    ✗ ${n.name}:${reason}`);
      }
    }
    await restore();

    if (!ok.length) {
      log('\n✗ 没有找到能用的节点。');
      log('  · 如果大多是"没有回复":这家机场屏蔽了 IPRoyal 的端口,请在 Clash 里切换到别的订阅,再运行一次本工具。');
      log('  · 如果大多是"直接断开":IPRoyal 不接受这家机场的 IP,同样换一家机场的订阅再试。');
      return 1;
    }

    log(`\n[3/4] 找到 ${ok.length} 个能用的节点,写入 Clash 配置…`);
    const pass = px.buildIproyalPassword(base, { country: 'us', session: px.newSessionId(), lifetime: '24h' });
    const y = buildYaml({ entry: entryOk, username, password: pass, nodes: ok });
    const files = findProfileFiles(verge.dir);
    if (!files) {
      log('  没能自动定位订阅文件,请手动粘贴:');
      log('\n  —— 右键当前订阅 → 编辑节点 → 文本模式,粘贴:\n' + y.proxies);
      log('  —— 右键当前订阅 → 编辑代理组 → 文本模式,粘贴:\n' + y.groups);
    } else {
      if (process.env.FIND_CHAIN_YES !== '1') {
        const a = await ask(`  将写入订阅「${files.name}」的「编辑节点」和「编辑代理组」(原文件会备份),继续吗?(Y/n) `);
        if (/^n/i.test(a)) { log('  已取消。'); return 1; }
      }
      backupAndWrite(files.proxies, y.proxies);
      backupAndWrite(files.groups, y.groups);
      log(`  ✓ 已写入订阅「${files.name}」`);
    }

    log('\n[4/4] 请到 Clash Verge:「订阅」页面 → 右键这个订阅 → 选「使用」。');
    if (process.env.FIND_CHAIN_YES !== '1') await ask('  完成后按回车,我来验证住宅 IP 是否生效…');
    for (let i = 0; i < 20; i++) {
      const p = await api.proxies();
      if (p.proxies[RES_PROXY]) break;
      if (i === 19) { log('  ✗ Clash 里还没出现「住宅IP-美国」,请确认已点「使用」,或重启 Clash Verge。'); return 1; }
      await sleep(1000);
    }
    const before = await api.configs();
    const beforeGlobal = (await api.proxies()).proxies.GLOBAL.now;
    try {
      await api.setMode('global');
      await api.select('GLOBAL', RES_PROXY);
      await sleep(500);
      const s = await withTimeout(openTunnel(front, 'ipinfo.io', 443), STEP_MS, '超时');
      const j = await withTimeout(new Promise((resolve, reject) => {
        const t = tls.connect({ socket: s, servername: 'ipinfo.io' });
        let b = ''; t.setEncoding('utf8');
        t.on('secureConnect', () => t.write('GET /json HTTP/1.1\r\nHost: ipinfo.io\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n'));
        t.on('data', (d) => { b += d; });
        t.on('end', () => { try { resolve(JSON.parse(b.slice(b.indexOf('{')))); } catch { reject(new Error('读不到')); } });
        t.on('error', reject);
      }), STEP_MS * 2, '超时');
      log(`\n🎉 成功!通过 Clash 的出口 IP:${j.ip}  ${j.org || ''}  (${[j.country, j.region, j.city].filter(Boolean).join(' / ')})`);
      log('\n以后怎么用:Clash「代理」页面 → 全局模式 → GLOBAL 里选「住宅IP-美国」。');
      log('住宅流量按 GB 收费,不用时记得切回普通节点或「规则」模式。');
    } catch (e) {
      log(`\n✗ 验证没通过:${e.message}。可以在 Clash 里手动选「住宅IP-美国」打开 ipinfo.io 再看看。`);
      return 1;
    } finally {
      try { await api.select('GLOBAL', beforeGlobal); } catch { /* */ }
      try { await api.setMode(before.mode); } catch { /* */ }
    }
    return 0;
  } finally {
    await restore();
  }
}

main().then((code) => { if (rl) rl.close(); process.exitCode = code || 0; }, (e) => {
  log('\n✗ ' + e.message);
  if (rl) rl.close();
  process.exitCode = 1;
});
