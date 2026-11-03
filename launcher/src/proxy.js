// 代理相关的纯函数:解析代理串、生成 IPRoyal 密码参数、国家 → 语言
const crypto = require('crypto');

// IPRoyal 写在密码后面的参数关键字,见 https://docs.iproyal.com/proxies/residential/proxy
const IPROYAL_KEYS = ['country', 'region', 'state', 'city', 'session', 'lifetime', 'streaming', 'skipispstatic', 'skipipslist', 'killswitch', 'forcerandom'];
const PARAM_RE = new RegExp(`_(${IPROYAL_KEYS.join('|')})-`);

const isIproyal = (host) => /(^|\.)iproyal\.com$/i.test(String(host || '').trim());

// 支持这几种写法:
//   host:port:user:pass
//   user:pass@host:port
//   http://user:pass@host:port   socks5://user:pass@host:port
function parseProxyLine(line) {
  let s = String(line || '').trim();
  if (!s) return null;
  let protocol = 'http';
  const scheme = /^(https?|socks5h?):\/\//i.exec(s);
  if (scheme) {
    protocol = scheme[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http';
    s = s.slice(scheme[0].length);
  }
  let host, port, username = '', password = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    const cred = s.slice(0, at);
    const hp = s.slice(at + 1).replace(/\/+$/, '');
    const i = cred.indexOf(':');
    username = i >= 0 ? cred.slice(0, i) : cred;
    password = i >= 0 ? cred.slice(i + 1) : '';
    [host, port] = hp.split(':');
  } else {
    const parts = s.split(':');
    if (parts.length < 2) return null;
    [host, port] = parts;
    username = parts[2] || '';
    password = parts.slice(3).join(':');
  }
  port = Number(port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { protocol, host: host.trim(), port, username: decodeURIComponent(username), password: decodeURIComponent(password) };
}

// 把 "pass_country-us_session-abc_lifetime-1h" 拆成 { base: 'pass', params: { country: 'us', ... } }
function splitIproyalPassword(pass) {
  const s = String(pass || '');
  const m = PARAM_RE.exec(s);
  if (!m) return { base: s, params: {} };
  const base = s.slice(0, m.index);
  const params = {};
  const re = new RegExp(`_(${IPROYAL_KEYS.join('|')})-(.*?)(?=_(?:${IPROYAL_KEYS.join('|')})-|$)`, 'g');
  for (const x of s.slice(m.index).matchAll(re)) params[x[1]] = x[2];
  return { base, params };
}

// 地名统一成小写、去空格(IPRoyal 文档示例均为此格式,如 newyork)
const slug = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, '');

function buildIproyalPassword(base, o = {}) {
  let s = base;
  const country = slug(o.country);
  if (country) s += `_country-${country}`;
  if (country === 'us' && slug(o.state)) s += `_state-${slug(o.state)}`;
  if (country && slug(o.city)) s += `_city-${slug(o.city)}`;
  if (o.session) s += `_session-${o.session}_lifetime-${o.lifetime || '24h'}`;
  return s;
}

// IPRoyal 要求 session 为 8 位字母数字
function newSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(8), (b) => chars[b % chars.length]).join('');
}

// 出口 IP 的国家 → 浏览器语言
const LOCALES = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE', IN: 'en-IN', SG: 'en-SG', PH: 'en-PH', ZA: 'en-ZA', NG: 'en-NG', MY: 'ms-MY',
  DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', FR: 'fr-FR', BE: 'fr-BE', ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CO: 'es-CO', CL: 'es-CL', PE: 'es-PE',
  IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR', NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', PL: 'pl-PL', CZ: 'cs-CZ', RO: 'ro-RO',
  HU: 'hu-HU', GR: 'el-GR', TR: 'tr-TR', RU: 'ru-RU', UA: 'uk-UA', IL: 'he-IL', AE: 'ar-AE', SA: 'ar-SA', EG: 'ar-EG',
  JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', HK: 'zh-HK', TW: 'zh-TW', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID',
};
const localeFor = (cc) => LOCALES[String(cc || '').toUpperCase()] || 'en-US';

// Chrome 的 --accept-lang 和 intl.accept_languages 都用不带 q 值的列表,q 值由 Chrome 自己加
function acceptLanguage(locale) {
  const lang = locale.split('-')[0];
  const list = [locale, lang];
  if (lang !== 'en') list.push('en-US', 'en');
  return list.join(',');
}

// 前置代理:"127.0.0.1:7890"(默认 HTTP)或 "socks5://127.0.0.1:7891"
function parseVia(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const p = parseProxyLine(t);
  return p ? { protocol: p.protocol, host: p.host, port: p.port, username: p.username, password: p.password } : null;
}
const formatVia = (v) => (v ? `${v.protocol === 'socks5' ? 'socks5://' : ''}${v.host}:${v.port}` : '');

module.exports = { parseVia, formatVia,  isIproyal, parseProxyLine, splitIproyalPassword, buildIproyalPassword, newSessionId, localeFor, acceptLanguage, slug };
