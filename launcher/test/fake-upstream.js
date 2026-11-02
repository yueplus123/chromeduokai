// 测试用:带账号密码的假上游代理(HTTP 和 SOCKS5),把所有目标都转到本机的 targetPort
const http = require('http');
const net = require('net');

function fakeHttpProxy({ user, pass, targetPort, port = 0, log = [] }) {
  // pass 可以是字符串,也可以是正则(用于匹配带随机 session 的密码)
  const ok = (h) => {
    if (!h || !h.startsWith('Basic ')) return false;
    const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    const p = rest.join(':');
    return u === user && (pass instanceof RegExp ? pass.test(p) : p === pass);
  };
  const server = http.createServer((req, res) => {
    if (!ok(req.headers['proxy-authorization'])) { res.writeHead(407).end(); return; }
    const u = new URL(req.url);
    log.push({ kind: 'http', host: u.host, auth: req.headers['proxy-authorization'] });
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const up = http.request({ host: '127.0.0.1', port: targetPort, path: u.pathname + u.search, method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  server.on('connect', (req, sock) => {
    if (!ok(req.headers['proxy-authorization'])) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    log.push({ kind: 'connect', host: req.url, auth: req.headers['proxy-authorization'] });
    const t = net.connect(targetPort, '127.0.0.1', () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); t.pipe(sock); sock.pipe(t); });
    t.on('error', () => sock.destroy());
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, port: server.address().port, log })));
}

function fakeSocks5({ user, pass, targetPort, log = [] }) {
  const server = net.createServer((s) => {
    let stage = 0; let buf = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 3) { buf = buf.subarray(2 + buf[1]); s.write(Buffer.from([5, 2])); stage = 1; }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1]; if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString(); const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) { s.end(Buffer.from([1, 1])); return; }
        s.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const hl = buf[4]; if (buf.length < 7 + hl) return;
        const host = buf.subarray(5, 5 + hl).toString(); const port = buf.readUInt16BE(5 + hl);
        const rest = buf.subarray(7 + hl);
        log.push({ kind: 'socks', host: `${host}:${port}` });
        s.off('data', onData);
        const t = net.connect(targetPort, '127.0.0.1', () => {
          s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          if (rest.length) t.write(rest);
          t.pipe(s); s.pipe(t);
        });
        t.on('error', () => s.destroy());
        stage = 3;
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, log })));
}

module.exports = { fakeHttpProxy, fakeSocks5 };
