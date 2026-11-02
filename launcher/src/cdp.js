// 通过 --remote-debugging-pipe 控制 Chrome,把每个页面的时区和区域设置改成出口 IP 所在地。
// 走的是进程间管道(fd 3/4),不开任何网络端口,网页无法连上。
// Windows 版 Chrome 不认 TZ 环境变量,这是改时区唯一可靠的办法。
const TYPES = new Set(['page', 'iframe', 'worker', 'shared_worker', 'service_worker']);

function attachEmulation(child, { timezoneId, locale }) {
  const out = child.stdio[3];
  const inp = child.stdio[4];
  let nextId = 1;
  let buf = '';
  const send = (method, params = {}, sessionId) => {
    const msg = { id: nextId++, method, params };
    if (sessionId) msg.sessionId = sessionId;
    try { out.write(JSON.stringify(msg) + '\0'); } catch { /* Chrome 已退出 */ }
  };

  function onAttached({ sessionId, targetInfo, waitingForDebugger }) {
    if (TYPES.has(targetInfo.type)) {
      if (timezoneId) send('Emulation.setTimezoneOverride', { timezoneId }, sessionId);
      if (locale) send('Emulation.setLocaleOverride', { locale }, sessionId);
      // 页面里的 iframe、worker 也要覆盖到
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    }
    if (waitingForDebugger) send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  inp.setEncoding('utf8');
  inp.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(raw); } catch { continue; }
      if (process.env.CDP_DEBUG) console.log('CDP<', raw.slice(0, 300));
      if (m.method === 'Target.attachedToTarget') onAttached(m.params);
    }
  });
  inp.on('error', () => {});
  out.on('error', () => {});

  // 浏览器级自动附加:新开的标签页、窗口(包括无痕窗口)都会先暂停,设置好时区后再继续运行
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return { send };
}

module.exports = { attachEmulation };
