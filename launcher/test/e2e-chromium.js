// 端到端:真 Chromium + 本地中转 + 假上游代理,验证流量走代理、时区/语言被改写、无痕窗口同样生效
// 用法:CHROME_BIN=/path/to/chrome node test/e2e-chromium.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const chrome = require('../src/chrome');
const { createRelay } = require('../src/relay');
const { attachEmulation } = require('../src/cdp');
const { fakeHttpProxy } = require('./fake-upstream');

const BIN = process.env.CHROME_BIN;
if (!BIN) { console.log('skip e2e (set CHROME_BIN)'); process.exit(0); }

const PAGE = `<!doctype html><body></body><script>
const probe = () => ({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, lang: navigator.language, langs: navigator.languages.join(','), offset: new Date().getTimezoneOffset() });
const report = (where, data) => fetch('/report?where=' + where, { method: 'POST', body: JSON.stringify(data) });
report(location.search.includes('frame') ? 'iframe' : 'page', probe());
if (!location.search.includes('frame')) {
  const f = document.createElement('iframe'); f.src = '/page?frame=1'; document.body.append(f);
  const w = new Worker(URL.createObjectURL(new Blob(["postMessage({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date().getTimezoneOffset() })"])));
  w.onmessage = (e) => report('worker', e.data);
}
</script>`;

async function run(mode) {
  const reports = {};
  let resolveAll;
  const all = new Promise((r) => { resolveAll = r; });
  const target = http.createServer((req, res) => {
    if (req.url.startsWith('/report')) {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => {
        reports[new URL(req.url, 'http://x').searchParams.get('where')] = { ...JSON.parse(b), acceptLanguage: req.headers['accept-language'] };
        res.end();
        if (reports.page && reports.iframe && reports.worker) resolveAll();
      });
      return;
    }
    res.setHeader('content-type', 'text/html'); res.end(PAGE);
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const up = await fakeHttpProxy({ user: 'u', pass: 'pw_session-abcd1234', targetPort: target.address().port });
  const relay = await createRelay({ protocol: 'http', host: '127.0.0.1', port: up.port, username: 'u', password: 'pw_session-abcd1234' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prof-'));
  chrome.patchPreferences(dir, { acceptLang: 'ja-JP,ja,en-US,en' });
  const p = { dir, mode, home: 'http://site.test/page', extraArgs: '--headless=new --no-sandbox --disable-gpu' };
  const child = chrome.launchControlled(BIN, p, { proxyPort: relay.port, locale: 'ja-JP', acceptLang: 'ja-JP,ja,en-US,en' });
  attachEmulation(child, { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });

  const timer = setTimeout(() => { console.error(mode, 'timeout, got', reports); process.exit(1); }, 25000);
  await all;
  clearTimeout(timer);

  // 关掉管道后 Chrome 应该退出(启动器退出时不会留下没网的浏览器)
  const exited = new Promise((r) => child.once('exit', r));
  child.stdio[3].end();
  const t2 = setTimeout(() => child.kill(), 8000);
  await exited; clearTimeout(t2);

  relay.close(); up.server.close(); target.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { reports, upstreamLog: up.log };
}

(async () => {
  for (const mode of ['normal', 'incognito']) {
    const { reports, upstreamLog } = await run(mode);
    console.log(mode, JSON.stringify(reports));
    assert.ok(upstreamLog.some((l) => l.host === 'site.test'), 'traffic went through upstream');
    for (const where of ['page', 'iframe', 'worker']) {
      assert.strictEqual(reports[where].tz, 'Asia/Tokyo', `${mode} ${where} tz`);
      assert.strictEqual(reports[where].offset, -540, `${mode} ${where} offset`);
    }
    assert.strictEqual(reports.page.locale, 'ja-JP', mode + ' Intl locale');
    assert.match(reports.page.acceptLanguage, /^ja-JP,ja;q=0\.9/, mode + ' Accept-Language');
  }
  console.log('e2e passed');
})().catch((e) => { console.error(e); process.exit(1); });
