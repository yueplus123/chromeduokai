const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../src/chrome');

// parseUserDataDir
assert.strictEqual(c.parseUserDataDir('"C:\\chrome.exe" --user-data-dir="D:\\my profiles\\a" --x'), 'D:\\my profiles\\a');
assert.strictEqual(c.parseUserDataDir('chrome.exe --user-data-dir=D:\\p\\b --x'), 'D:\\p\\b');
assert.strictEqual(c.parseUserDataDir('chrome.exe --foo'), null);

// normDir 忽略大小写和末尾斜杠
assert.strictEqual(c.normDir('D:\\P\\A\\'), c.normDir('d:\\p\\a'));

// buildArgs:普通窗口 + 插件,且不再包含代理
const a = c.buildArgs({ dir: 'D:\\p\\a\\', extensions: ['D:\\ext\\one', 'D:\\ext\\two'], extraArgs: '--lang=en-US  --foo', home: 'https://x.com', proxy: 'http://1.2.3.4:80' });
assert.deepStrictEqual(a, ['--user-data-dir=D:\\p\\a', '--no-first-run', '--no-default-browser-check',
  '--disable-features=DisableLoadExtensionCommandLineSwitch', '--load-extension=D:\\ext\\one,D:\\ext\\two',
  '--lang=en-US', '--foo', 'https://x.com']);
assert.ok(!a.some((x) => x.startsWith('--proxy-server')));
assert.ok(!a.includes('--incognito'));

// 无痕模式
assert.ok(c.buildArgs({ dir: 'D:\\p', mode: 'incognito' }).includes('--incognito'));
assert.ok(!c.buildArgs({ dir: 'D:\\p', mode: 'normal' }).includes('--incognito'));
assert.ok(!c.buildArgs({ dir: 'D:\\p' }).some((x) => x.startsWith('--load-extension')));

// parseStoreId
const ID = 'abcdefghijklmnopabcdefghijklmnop';
assert.strictEqual(c.parseStoreId(`https://chromewebstore.google.com/detail/some-name/${ID}?hl=zh`), ID);
assert.strictEqual(c.parseStoreId(ID), ID);
assert.strictEqual(c.parseStoreId('not an id'), null);

// 卡信息
const card = require('../src/card');
const n = card.normalizeCard({ holder: ' A B ', number: '4111 1111-1111 1111', exp: '12/28', cvv: '12a3' });
assert.deepStrictEqual(n, { holder: 'A B', number: '4111111111111111', exp: '12/28', cvv: '123' });
assert.strictEqual(card.validateCard(n), '');
assert.ok(card.validateCard({ ...n, number: '123' }));
assert.ok(card.validateCard({ ...n, cvv: '12' }));
assert.ok(card.validateCard({ ...n, exp: '13/28' }));
assert.strictEqual(card.validateCard({ ...n, exp: '', cvv: '' }), '');
assert.ok(card.isEmptyCard(card.normalizeCard({})));
assert.strictEqual(card.last4(n.number), '1111');

// scanProfileDirs
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
fs.mkdirSync(path.join(root, 'one', 'Default'), { recursive: true });
fs.mkdirSync(path.join(root, 'two'));
fs.writeFileSync(path.join(root, 'two', 'Local State'), '{}');
fs.mkdirSync(path.join(root, 'plain'));
assert.deepStrictEqual(c.scanProfileDirs(root).map((d) => path.basename(d)).sort(), ['one', 'two']);
fs.rmSync(root, { recursive: true });

// listRunning 能正常返回(不要求有结果)
c.listRunning().then((m) => { assert.ok(m instanceof Map); console.log('all tests passed'); });
