// 本地中转代理:Chrome 连 127.0.0.1 上的端口(不需要密码),
// 这里替它带上账号密码转发给上游代理(HTTP 或 SOCKS5)。
// 这样既不会弹出代理登录框,也不需要装任何插件,无痕窗口同样生效。
const http = require('http');
const net = require('net');
const tls = require('tls');

const TIMEOUT = 20000;

// 从 socket 上按需读取 n 个字节 / 读到某个分隔符,用完后把多读的数据退回去
function reader(sock) {
  let buf = Buffer.alloc(0);
  let want = null;
  const onData = (d) => { buf = Buffer.concat([buf, d]); check(); };
  const onEnd = () => { if (want) { const w = want; want = null; w.reject(new Error('上游代理断开了连接')); } };
  sock.on('data', onData);
  sock.on('end', onEnd);
  sock.on('error', onEnd);
  sock.resume(); // 套在前置代理隧道上的 socket 是暂停状态,要手动恢复
  function check() {
    if (!want) return;
    let n = -1;
    if (typeof want.n === 'number') { if (buf.length >= want.n) n = want.n; }
    else { const i = buf.indexOf(want.n); if (i >= 0) n = i + want.n.length; }
    if (n < 0) return;
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    const w = want; want = null; w.resolve(out);
  }
  return {
    read: (n) => new Promise((resolve, reject) => { want = { n, resolve, reject }; check(); }),
    done() {
      sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onEnd);
      sock.pause();
      if (buf.length) sock.unshift(buf);
    },
  };
}

const basicAuth = (u) => 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');

// up.via:前置代理(如本机 Clash 127.0.0.1:7890)。先通过它出国,再连上游代理。
// 国内直连海外 HTTP/SOCKS5 代理是明文的,访问被封网站会被防火墙重置连接,加一层加密的前置代理就能解决。
async function connectUpstream(up) {
  if (up.via) {
    try { return await openTunnel(up.via, up.host, up.port); } catch (e) {
      const msg = e.code === 'ECONNREFUSED' ? `连不上前置代理 ${up.via.host}:${up.via.port},请确认 Clash 等代理软件已打开` : '前置代理:' + e.message;
      throw Object.assign(new Error(msg), { status: e.status });
    }
  }
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: up.host, port: up.port });
    s.setTimeout(TIMEOUT, () => s.destroy(new Error('连接上游代理超时')));
    s.once('connect', () => { s.setTimeout(0); resolve(s); });
    s.once('error', reject);
  });
}

async function httpTunnel(up, host, port) {
  const s = await connectUpstream(up);
  const auth = up.username ? `Proxy-Authorization: ${basicAuth(up)}\r\n` : '';
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const r = reader(s);
  try {
    const head = (await r.read(Buffer.from('\r\n\r\n'))).toString('latin1');
    const status = Number((/^HTTP\/\d\.\d (\d{3})/.exec(head) || [])[1]);
    if (status !== 200) {
      const msg = status === 407 ? '代理账号或密码错误(407)' : `上游代理拒绝了连接(${status || '无响应'})`;
      throw Object.assign(new Error(msg), { status });
    }
    r.done();
    return s;
  } catch (e) { s.destroy(); throw e; }
}

async function socksTunnel(up, host, port) {
  const s = await connectUpstream(up);
  const r = reader(s);
  try {
    const useAuth = !!up.username;
    s.write(Buffer.from([5, 1, useAuth ? 2 : 0]));
    const [ver, method] = await r.read(2);
    if (ver !== 5 || method === 0xff) throw new Error('SOCKS5 代理不接受该认证方式');
    if (method === 2) {
      const u = Buffer.from(up.username), p = Buffer.from(up.password || '');
      s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const [, ok] = await r.read(2);
      if (ok !== 0) throw new Error('代理账号或密码错误(SOCKS5)');
    }
    const h = Buffer.from(host);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
    const [, rep, , atyp] = await r.read(4);
    if (rep !== 0) throw new Error(`SOCKS5 连接目标失败(错误码 ${rep})`);
    const len = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.read(1))[0];
    await r.read(len + 2);
    r.done();
    return s;
  } catch (e) { s.destroy(); throw e; }
}

const openTunnel = (up, host, port) => (up.protocol === 'socks5' ? socksTunnel : httpTunnel)(up, host, Number(port));

// 启动中转,返回 { port, close, stats }。只监听 127.0.0.1,外部访问不到
function createRelay(upstream) {
  const sockets = new Set();
  // failures:最近几次转发失败(网站 + 原因),显示在分身卡片上方便排查
  const stats = { lastError: '', tunnels: 0, failures: [] };
  const fail = (host, msg) => {
    stats.lastError = msg;
    stats.failures = [{ host, msg, at: Date.now() }, ...stats.failures.filter((f) => f.host !== host)].slice(0, 5);
  };
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); return s; };

  const server = http.createServer((req, res) => {
    // 普通 http:// 请求(Chrome 发来的是完整网址)
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const opts = { method: req.method, headers };
    if (upstream.protocol === 'socks5') {
      Object.assign(opts, { host: url.hostname, port: url.port || 80, path: url.pathname + url.search });
      opts.createConnection = (_o, cb) => { openTunnel(upstream, url.hostname, url.port || 80).then((s) => { cb(null, s); s.resume(); }, cb); };
    } else {
      Object.assign(opts, { host: upstream.host, port: upstream.port, path: req.url });
      if (upstream.username) headers['proxy-authorization'] = basicAuth(upstream);
      if (upstream.via) opts.createConnection = (_o, cb) => { connectUpstream(upstream).then((s) => { cb(null, s); s.resume(); }, cb); };
    }
    const up = http.request(opts, (ur) => {
      // 上游代理自己返回的 5xx(如目标网站被代理商拦截)
      if (ur.statusCode >= 500 && upstream.protocol !== 'socks5') fail(url.host, `代理商返回 ${ur.statusCode}`);
      res.writeHead(ur.statusCode, ur.headers); ur.pipe(res);
    });
    up.setTimeout(TIMEOUT, () => up.destroy(new Error('超时')));
    up.on('error', (e) => { fail(url.host, e.message); if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  // https:// 等走 CONNECT 隧道
  server.on('connect', (req, client, head) => {
    track(client);
    const [host, port] = req.url.split(':');
    openTunnel(upstream, host, port || 443).then((s) => {
      track(s);
      stats.tunnels++;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) s.write(head);
      s.pipe(client); client.pipe(s);
      s.resume();
      const end = () => { s.destroy(); client.destroy(); };
      s.on('close', end); client.on('close', end);
    }, (e) => {
      fail(host, e.message);
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  server.on('connection', track);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        close() { server.close(); for (const s of sockets) s.destroy(); },
      });
    });
  });
}

// 通过中转查出口 IP 的位置和时区。先试 ipinfo.io(https),失败再试 ip-api.com(http)
function getJson(relayPort, target) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const done = (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve({ json: JSON.parse(body), ms: Date.now() - t0 }); } catch { reject(new Error(`查询出口 IP 失败(HTTP ${res.statusCode})`)); } });
    };
    const u = new URL(target);
    let req;
    if (u.protocol === 'http:') {
      req = http.get({ host: '127.0.0.1', port: relayPort, path: target, headers: { Host: u.host } }, done);
    } else {
      req = http.request({ host: '127.0.0.1', port: relayPort, method: 'CONNECT', path: `${u.hostname}:443` });
      req.on('connect', (res, sock) => {
        if (res.statusCode !== 200) { sock.destroy(); return reject(new Error('代理连接失败,请检查账号密码或余额')); }
        const ts = tls.connect({ socket: sock, servername: u.hostname });
        const r2 = http.get({ host: u.hostname, path: u.pathname + u.search, createConnection: () => ts, headers: { 'User-Agent': 'curl/8' } }, done);
        r2.on('error', reject);
      });
      req.end();
    }
    req.setTimeout(TIMEOUT, () => req.destroy(new Error('查询出口 IP 超时')));
    req.on('error', reject);
  });
}

async function checkExit(relayPort) {
  try {
    const { json: j, ms } = await getJson(relayPort, 'https://ipinfo.io/json');
    if (j.ip && j.timezone) return { ip: j.ip, countryCode: j.country, country: j.country, region: j.region, city: j.city, timezone: j.timezone, ms };
  } catch (e) { if (/账号|余额/.test(e.message)) throw e; }
  const { json: j, ms } = await getJson(relayPort, 'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,timezone,query');
  if (j.status !== 'success') throw new Error('查询出口 IP 失败:' + (j.message || '未知错误'));
  return { ip: j.query, countryCode: j.countryCode, country: j.country, region: j.regionName, city: j.city, timezone: j.timezone, ms };
}

module.exports = { createRelay, checkExit, openTunnel };
