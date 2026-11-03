// 测试 tools/find-chain.js:模拟 Clash(mihomo)的控制接口和代理端口、三种机场节点、IPRoyal、ipinfo.io
//   节点 A「🇭🇰 香港 01」:屏蔽 12321 端口(像 mihomo 一样先回 200 再断开)
//   节点 B「🇯🇵 日本 02」:能连到 IPRoyal,但 IPRoyal 收到带密码的请求后直接断开
//   节点 C「🇺🇸 美国 03 CN2」:正常
//   节点 D「🇸🇬 新加坡 dead」:节点本身不通(延迟测试失败)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { execFileSync, spawn } = require('child_process');
const { fakeHttpProxy } = require('./fake-upstream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'findchain-'));

(async () => {
  // ---- 假 ipinfo.io(自签名 TLS)----
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=ipinfo.io'], { stdio: 'ignore' });
  const ipinfo = tls.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (s) => {
    s.once('data', () => {
      const body = JSON.stringify({ ip: '73.10.20.30', city: 'Ashburn', region: 'Virginia', country: 'US', org: 'AS7922 Comcast Cable' });
      s.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    s.on('error', () => {});
  });
  await new Promise((r) => ipinfo.listen(0, '127.0.0.1', r));

  // ---- 假 IPRoyal:正常版 / 拒绝版 ----
  const good = await fakeHttpProxy({ user: 'myuser', pass: /^mypass_country-us_session-[a-z0-9]{8}_lifetime-(10m|24h)$/, targetPort: ipinfo.address().port });
  const reject = http.createServer((req, res) => res.writeHead(407, { 'Proxy-Authenticate': 'Basic' }).end());
  reject.on('connect', (_req, sock) => sock.destroy());
  await new Promise((r) => reject.listen(0, '127.0.0.1', r));

  // ---- Clash Verge 数据目录 ----
  const dir = path.join(tmp, 'verge');
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles.yaml'), [
    'current: RcurUid1', 'items:',
    '- uid: RotherUid', '  type: remote', '  name: 八戒', '  file: RotherUid.yaml', '  option:', '    proxies: potherxx', '    groups: gotherxx',
    '- uid: RcurUid1', '  type: remote', '  name: UfKlsn7', '  file: RcurUid1.yaml', '  option:', '    with_proxy: false', '    merge: Mcur', '    script: Scur', '    rules: rcur', '    proxies: pcurxxxx', '    groups: gcurxxxx',
    '- uid: pcurxxxx', '  type: proxies', '  file: pcurxxxx.yaml',
    '- uid: gcurxxxx', '  type: groups', '  file: gcurxxxx.yaml', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'profiles', 'pcurxxxx.yaml'), "prepend:\n  - name: '住宅IP-美国'\n    dialer-proxy: '这里换成节点名'\nappend: []\ndelete: []\n");
  fs.writeFileSync(path.join(dir, 'profiles', 'gcurxxxx.yaml'), 'prepend: []\nappend: []\ndelete: []\n');

  // ---- 模拟 Clash ----
  const NODES = { '🇭🇰 香港 01': 'block', '🇯🇵 日本 02': 'reject', '🇺🇸 美国 03 CN2': 'good', '🇸🇬 新加坡 dead': 'dead' };
  const state = { mode: 'rule', global: '🇭🇰 香港 01' };
  const SECRET = 's3cret';
  const hasResidential = () => fs.readFileSync(path.join(dir, 'profiles', 'pcurxxxx.yaml'), 'utf8').includes('dialer-proxy: "住宅出国"');
  const api = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) return res.writeHead(401).end();
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(o ? JSON.stringify(o) : ''); };
      if (u.pathname === '/configs' && req.method === 'GET') return send({ mode: state.mode, 'mixed-port': clash.address().port });
      if (u.pathname === '/configs' && req.method === 'PATCH') { state.mode = JSON.parse(body).mode; return send(null, 204); }
      if (u.pathname === '/proxies') {
        const proxies = { GLOBAL: { name: 'GLOBAL', type: 'Selector', now: state.global }, DIRECT: { name: 'DIRECT', type: 'Direct' }, 节点选择: { name: '节点选择', type: 'Selector' } };
        for (const n of Object.keys(NODES)) proxies[n] = { name: n, type: 'Vless' };
        if (hasResidential()) proxies['住宅IP-美国'] = { name: '住宅IP-美国', type: 'Http' };
        return send({ proxies });
      }
      const m = /^\/proxies\/([^/]+)(\/delay)?$/.exec(u.pathname);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (m[2]) return NODES[name] === 'dead' ? send({ message: 'timeout' }, 504) : send({ delay: 120 });
        if (req.method === 'PUT' && name === 'GLOBAL') { state.global = JSON.parse(body).name; return send(null, 204); }
      }
      send({ message: 'not found' }, 404);
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));

  // 代理端口:按 GLOBAL 当前选的节点决定行为
  const pipeTo = (client, port, head) => {
    const t = net.connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head && head.length) t.write(head); t.pipe(client); client.pipe(t); });
    t.on('error', () => client.destroy());
  };
  const clash = http.createServer((_q, r) => r.writeHead(400).end());
  clash.on('connect', (req, client, head) => {
    client.on('error', () => {});
    const [host] = req.url.split(':');
    const node = state.mode === 'global' ? state.global : '🇭🇰 香港 01';
    if (node === '住宅IP-美国') {
      // 链路:经"住宅出国"组 → IPRoyal(正常版)→ 目标,账号密码取自写入的配置
      const text = fs.readFileSync(path.join(dir, 'profiles', 'pcurxxxx.yaml'), 'utf8');
      const user = JSON.parse(/username: (".*")/.exec(text)[1]);
      const pass = JSON.parse(/password: (".*")/.exec(text)[1]);
      const s = net.connect(good.port, '127.0.0.1', () => {
        s.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n\r\n`);
        s.once('data', (d) => {
          if (!/^HTTP\/1\.1 200/.test(String(d))) return client.destroy();
          client.write('HTTP/1.1 200 Connection established\r\n\r\n'); s.pipe(client); client.pipe(s);
        });
      });
      s.on('error', () => client.destroy());
      return;
    }
    const kind = NODES[node];
    if (/iproyal\.com$/.test(host)) {
      if (kind === 'block' || kind === 'dead') { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); return setTimeout(() => client.destroy(), 50); }
      return pipeTo(client, kind === 'reject' ? reject.address().port : good.port, head);
    }
    client.destroy();
  });
  await new Promise((r) => clash.listen(0, '127.0.0.1', r));

  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), [
    `mixed-port: ${clash.address().port}`, `external-controller: 127.0.0.1:${api.address().port}`, `secret: '${SECRET}'`,
    "external-controller-pipe: '\\\\.\\pipe\\verge-mihomo'", 'mode: rule', '',
  ].join('\n'));

  // ---- 运行工具 ----
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'find-chain.js'), 'geo.iproyal.com:12321:myuser:mypass_country-jp_lifetime-1h'], {
      env: { ...process.env, CLASH_VERGE_DIR: dir, FIND_CHAIN_YES: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    let o = ''; child.stdout.on('data', (d) => { o += d; }); child.stderr.on('data', (d) => { o += d; });
    child.on('exit', (code) => resolve({ code, o }));
  });
  if (process.env.SHOW) console.log(out.o);

  try {
    assert.strictEqual(out.code, 0, out.o);
    assert.match(out.o, /能用的节点 3 个/);                       // dead 节点被延迟测试排除
    assert.match(out.o, /✓ 🇺🇸 美国 03 CN2 {2}→ {2}73\.10\.20\.30 {2}AS7922 Comcast Cable/); // 美国节点优先测且成功
    assert.match(out.o, /✗ 🇭🇰 香港 01:没有回复/);
    assert.match(out.o, /✗ 🇯🇵 日本 02:IPRoyal 收到请求后直接断开/);
    assert.match(out.o, /已写入订阅「UfKlsn7」/);
    assert.match(out.o, /🎉 成功!通过 Clash 的出口 IP:73\.10\.20\.30/);

    const proxiesYaml = fs.readFileSync(path.join(dir, 'profiles', 'pcurxxxx.yaml'), 'utf8');
    const groupsYaml = fs.readFileSync(path.join(dir, 'profiles', 'gcurxxxx.yaml'), 'utf8');
    assert.match(proxiesYaml, /password: "mypass_country-us_session-[a-z0-9]{8}_lifetime-24h"/);
    assert.match(proxiesYaml, /server: "geo\.iproyal\.com"/);
    assert.match(groupsYaml, /proxies: \["🇺🇸 美国 03 CN2"\]/);           // 只放实测成功的节点,名字一字不差
    assert.ok(!groupsYaml.includes('日本') && !groupsYaml.includes('香港'));
    assert.ok(fs.readdirSync(path.join(dir, 'profiles')).some((f) => f.startsWith('pcurxxxx.yaml.bak-')), '原文件已备份');
    assert.ok(!fs.readFileSync(path.join(dir, 'profiles.yaml'), 'utf8').includes('住宅'), '没有动别的订阅');
    // 用户原来的模式和选择已恢复
    assert.deepStrictEqual(state, { mode: 'rule', global: '🇭🇰 香港 01' });
    console.log('find-chain tests passed');
  } finally {
    for (const s of [ipinfo, good.server, reject, api, clash]) s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
