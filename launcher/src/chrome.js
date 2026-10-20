const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);

function findChrome() {
  return CANDIDATES.find((p) => fs.existsSync(p)) || '';
}

// 用于比较两个目录是否相同
function normDir(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

// 从命令行里取出 --user-data-dir 的值
function parseUserDataDir(cmd) {
  const m = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(cmd || '');
  return m ? (m[1] ?? m[2]) : null;
}

const PS_SCRIPT =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "$r=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
  "Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } | " +
  "Select-Object ProcessId,CommandLine);" +
  "if($r.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $r -Compress}";

// 返回 Map<normDir, pid>:正在运行、且指定了 --user-data-dir 的 Chrome 主进程
function listRunning() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
        const map = new Map();
        if (err) return resolve(map);
        try {
          const rows = JSON.parse(stdout.trim() || '[]');
          for (const r of Array.isArray(rows) ? rows : [rows]) {
            const dir = parseUserDataDir(r.CommandLine);
            if (dir) map.set(normDir(dir), r.ProcessId);
          }
        } catch { /* 解析失败当作没有在运行 */ }
        resolve(map);
      });
  });
}

function buildArgs(p) {
  const args = ['--user-data-dir=' + p.dir.replace(/[\\/]+$/, ''), '--no-first-run', '--no-default-browser-check'];
  if (p.mode === 'incognito') args.push('--incognito');
  const exts = (p.extensions || []).filter(Boolean);
  if (exts.length) {
    // 新版 Chrome 默认禁用 --load-extension,需要用这个 feature 开关重新启用
    args.push('--disable-features=DisableLoadExtensionCommandLineSwitch', '--load-extension=' + exts.join(','));
  }
  if (p.extraArgs) args.push(...p.extraArgs.split(/\s+/).filter(Boolean));
  if (p.home) args.push(p.home);
  return args;
}

function launch(chromePath, p) {
  const child = spawn(chromePath, buildArgs(p), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// 默认优雅关闭(相当于点窗口的关闭按钮);force 时强杀整个进程树
function closeProcess(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), ...(force ? ['/F', '/T'] : [])];
    execFile('taskkill', args, { windowsHide: true }, (err) => resolve(!err));
  });
}

// 把一个文件夹下"看起来像 Chrome 用户数据目录"的子文件夹找出来
function scanProfileDirs(parent) {
  let entries = [];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(parent, e.name))
    .filter((d) => fs.existsSync(path.join(d, 'Local State')) || fs.existsSync(path.join(d, 'Default')));
}

// 从商店链接或纯 ID 里取出 32 位插件 ID(字母 a–p)
function parseStoreId(input) {
  const m = /[a-p]{32}/.exec(String(input || '').trim());
  return m ? m[0] : null;
}

const isExtensionDir = (dir) => fs.existsSync(path.join(dir, 'manifest.json'));

module.exports = { parseStoreId, isExtensionDir, findChrome, normDir, parseUserDataDir, listRunning, buildArgs, launch, closeProcess, scanProfileDirs };
