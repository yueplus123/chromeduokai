# 一键更新:从 GitHub 下载最新代码覆盖到本文件夹,你的数据原地不动
#   不会动:launcher\data\(分身列表、卡库)、浏览器分身数据\(各分身的 Chrome 数据)、node_modules\
#   更新前会把旧代码和配置文件备份到 _更新备份\ 文件夹(只保留最近 5 次)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'yueplus123/chromeduokai'
$Branch = 'main'
$Root = Split-Path -Parent $PSScriptRoot
$Keep = @('launcher\data', '浏览器分身数据', 'node_modules', '_更新备份', '.git')

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Say ''; Say "✗ $msg" 'Red'; exit 1 }

Say ''
Say '=== Chrome分身启动器 · 一键更新 ===' 'Cyan'
Say "程序目录:$Root"
Say ''

# 1. 启动器必须先关掉(分身浏览器可以继续开着)
while ($true) {
  $running = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $running) { break }
  Say '分身启动器还开着,请先关掉它(分身浏览器不用关)。' 'Yellow'
  $a = Read-Host '关好后按回车继续;输入 y 回车由我来关闭'
  if ($a -match '^[yY]') { $running | Stop-Process -Force; Start-Sleep -Seconds 1 }
}

# 用 Git 下载的项目:直接 git pull
if ((Test-Path (Join-Path $Root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Say '检测到 Git 仓库,用 git pull 更新…'
  Push-Location $Root
  try { git pull --ff-only origin $Branch; if ($LASTEXITCODE -ne 0) { Fail 'git pull 失败。如果你改过代码,请先处理冲突。' } } finally { Pop-Location }
  $updated = $true
}

if (-not $updated) {
  # 2. 下载最新代码。先走系统代理,不通再试 Clash 默认端口
  $tmp = Join-Path $env:TEMP ('chromeduokai-update-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'latest.zip'
  $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
  Say '正在从 GitHub 下载最新版本…'
  $ok = $false
  foreach ($proxy in @($null, 'http://127.0.0.1:7890', 'http://127.0.0.1:7897', 'http://127.0.0.1:10809')) {
    try {
      if ($proxy) { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 60 -Proxy $proxy }
      else { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 60 }
      if ((Get-Item $zip).Length -gt 10000) { $ok = $true; if ($proxy) { Say "  (通过代理 $proxy 下载)" }; break }
    } catch { }
  }
  if (-not $ok) { Fail '下载失败。GitHub 在国内经常连不上,请打开 Clash 等代理软件后再双击更新。' }

  # 3. 解压并检查内容
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
  $src = Get-ChildItem (Join-Path $tmp 'x') -Directory | Select-Object -First 1
  if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'launcher\src\main.js')) -or -not (Test-Path (Join-Path $src.FullName '一键启动.bat'))) { Fail '下载的文件不完整(或中文文件名解压出错),已停止更新,原文件没有改动。' }
  $src = $src.FullName

  # 4. 备份旧代码和配置文件
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bkRoot = Join-Path $Root '_更新备份'
  $bk = Join-Path $bkRoot $stamp
  New-Item -ItemType Directory -Path $bk -Force | Out-Null
  $dataFile = Join-Path $Root 'launcher\data\profiles.json'
  if (Test-Path $dataFile) { Copy-Item $dataFile (Join-Path $bk 'profiles.json') }
  $xd = $Keep | ForEach-Object { Join-Path $Root $_ }
  robocopy $Root (Join-Path $bk 'code') /E /XD $xd /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail '备份旧代码失败,已停止更新,原文件没有改动。' }
  Get-ChildItem $bkRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Say "已备份旧版本到:_更新备份\$stamp" 'DarkGray'

  # 5. 覆盖代码文件,跳过数据目录
  $oldPkg = if (Test-Path (Join-Path $Root 'package.json')) { (Get-FileHash (Join-Path $Root 'package.json')).Hash } else { '' }
  $xdSrc = $Keep | ForEach-Object { Join-Path $src $_ }
  robocopy $src $Root /E /XD $xdSrc /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "复制新文件失败。旧版本在 _更新备份\$stamp\code 里,可以手动复制回来。" }
  $newPkg = (Get-FileHash (Join-Path $Root 'package.json')).Hash
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 6. 依赖有变化才重新安装
$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (($oldPkg -and $newPkg -and $oldPkg -ne $newPkg) -or -not (Test-Path $electron)) {
  Say '依赖有更新,正在安装(需要几分钟)…'
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail '没有找到 npm,请先安装 Node.js:https://nodejs.org/' }
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  Push-Location $Root
  try { npm install; if ($LASTEXITCODE -ne 0) { Fail '依赖安装失败,请检查网络后重新双击「一键更新」。' } } finally { Pop-Location }
}

Say ''
Say '✓ 更新完成!你的分身列表、卡库和浏览器数据都没有改动。' 'Green'
$a = Read-Host '现在启动分身启动器吗?(Y/n)'
if ($a -notmatch '^[nN]') { Start-Process -FilePath (Join-Path $Root '一键启动.bat') -WorkingDirectory $Root }
