const assert = require('assert');
const http = require('http');
const px = require('../src/proxy');
const { createRelay } = require('../src/relay');
const { fakeHttpProxy, fakeSocks5 } = require('./fake-upstream');

// ---- 解析代理串 ----
assert.deepStrictEqual(px.parseProxyLine('geo.iproyal.com:12321:user1:pass_country-us'),
  { protocol: 'http', host: 'geo.iproyal.com', port: 12321, username: 'user1', password: 'pass_country-us' });
assert.deepStrictEqual(px.parseProxyLine('user1:p:w@geo.iproyal.com:12321'),
  { protocol: 'http', host: 'geo.iproyal.com', port: 12321, username: 'user1', password: 'p:w' });
assert.deepStrictEqual(px.parseProxyLine('socks5://u:p@1.2.3.4:1080/'),
  { protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
assert.strictEqual(px.parseProxyLine('nonsense'), null);
assert.strictEqual(px.parseProxyLine('host:99999:u:p'), null);

// ---- IPRoyal 密码参数 ----
assert.deepStrictEqual(px.splitIproyalPassword('abc_def_country-us_state-iowa_session-sgn34f3e_lifetime-10m'),
  { base: 'abc_def', params: { country: 'us', state: 'iowa', session: 'sgn34f3e', lifetime: '10m' } });
assert.deepStrictEqual(px.splitIproyalPassword('plain'), { base: 'plain', params: {} });
assert.strictEqual(px.buildIproyalPassword('pw', { country: 'US', state: 'New York', session: 'abcd1234', lifetime: '24h' }),
  'pw_country-us_state-newyork_session-abcd1234_lifetime-24h');
assert.strictEqual(px.buildIproyalPassword('pw', { country: 'de', state: 'x', city: 'Berlin' }), 'pw_country-de_city-berlin');
assert.strictEqual(px.buildIproyalPassword('pw', {}), 'pw');
assert.match(px.newSessionId(), /^[a-z0-9]{8}$/);
assert.notStrictEqual(px.newSessionId(), px.newSessionId());
assert.ok(px.isIproyal('geo.iproyal.com') && px.isIproyal('us.proxy.iproyal.com') && !px.isIproyal('iproyal.com.evil.cn'));

// ---- 语言 ----
assert.strictEqual(px.localeFor('us'), 'en-US');
assert.strictEqual(px.localeFor('JP'), 'ja-JP');
assert.strictEqual(px.localeFor('ZZ'), 'en-US');
assert.strictEqual(px.acceptLanguage('en-US'), 'en-US,en');
assert.strictEqual(px.acceptLanguage('de-DE'), 'de-DE,de,en-US,en');

// ---- 中转:HTTP 和 SOCKS5 上游,带密码 ----
const target = http.createServer((req, res) => res.end(`ok ${req.headers.host} ${req.url}`));

function viaRelay(port, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: '127.0.0.1', port, path: url, headers: { Host: u.host } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
}
function connectVia(port, hostPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: hostPort });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) { sock.destroy(); return resolve({ status: res.statusCode }); }
      sock.write(`GET /tunnel HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
      let b = ''; sock.on('data', (d) => { b += d; }); sock.on('end', () => resolve({ status: 200, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  for (const kind of ['http', 'socks5']) {
    const up = kind === 'http'
      ? await fakeHttpProxy({ user: 'u1', pass: 'secret_country-us', targetPort })
      : await fakeSocks5({ user: 'u1', pass: 'secret_country-us', targetPort });

    const relay = await createRelay({ protocol: kind, host: '127.0.0.1', port: up.port, username: 'u1', password: 'secret_country-us' });
    const a = await viaRelay(relay.port, 'http://example.test/hello?x=1');
    assert.strictEqual(a.status, 200, kind);
    assert.strictEqual(a.body, 'ok example.test /hello?x=1', kind);
    const b = await connectVia(relay.port, 'secure.test:443');
    assert.strictEqual(b.status, 200, kind);
    assert.ok(b.body.endsWith('ok secure.test:443 /tunnel'), kind + ': ' + b.body);
    assert.ok(up.log.length >= 2, kind);
    relay.close();

    // 密码错误:CONNECT 返回 502,并记下原因
    const bad = await createRelay({ protocol: kind, host: '127.0.0.1', port: up.port, username: 'u1', password: 'wrong' });
    const c = await connectVia(bad.port, 'secure.test:443');
    assert.strictEqual(c.status, 502, kind);
    assert.match(bad.stats.lastError, /密码错误/, kind);
    bad.close();
    up.server.close();
  }
  target.close();
  console.log('proxy tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
