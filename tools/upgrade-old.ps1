# 更新旧版本:把「这个新下载的文件夹」里的代码,更新到你电脑上原来在用的启动器文件夹
#   · 自动查找旧文件夹(桌面、下载、文档、各磁盘),让你确认
#   · 只替换程序文件,不动旧文件夹里的:launcher\data\(分身列表、卡库)、浏览器分身数据\、node_modules\
#   · 更新前把旧代码和配置备份到旧文件夹的 _更新备份\;更新后核对数据文件没有任何变化
$ErrorActionPreference = 'Stop'
$New = Split-Path -Parent $PSScriptRoot
$Keep = @('launcher\data', '浏览器分身数据', 'node_modules', '_更新备份', '.git')

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Say ''; Say "✗ $msg" 'Red'; exit 1 }
function IsLauncher($dir) { (Test-Path (Join-Path $dir 'launcher\src\main.js')) -and (Test-Path (Join-Path $dir 'launcher\data\profiles.json')) }
function Info($dir) {
  $f = Join-Path $dir 'launcher\data\profiles.json'
  $n = '?'
  try { $n = @((Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).profiles).Count } catch { }
  [pscustomobject]@{ Path = $dir; Profiles = $n; Time = (Get-Item $f).LastWriteTime }
}

Say ''
Say '=== Chrome分身启动器 · 更新旧版本 ===' 'Cyan'
Say "新版本所在文件夹:$New"
if (-not (Test-Path (Join-Path $New 'launcher\src\main.js'))) { Fail '这个脚本要放在新下载的启动器文件夹里运行。' }
Say ''
Say '正在查找你电脑上的旧版本(可能要十几秒)…'

# 1. 查找旧文件夹:逐层往下找(最多 3 层),跳过系统和体积大的文件夹,找得快
$skipNames = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData', 'node_modules', '_更新备份',
  '$Recycle.Bin', 'System Volume Information', 'Recovery', 'PerfLogs', 'MSOCache', 'Intel', 'AMD', 'NVIDIA',
  '浏览器分身数据', 'launcher', 'Default', 'Microsoft', 'Steam', 'steamapps', 'WindowsApps')
$places = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('MyDocuments'), $env:USERPROFILE, (Split-Path -Parent $New))
$places += Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -and (Test-Path $_.Root) } | ForEach-Object { $_.Root }
$found = @{}
$seen = @{}
foreach ($p in ($places | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {
  $level = @((Get-Item $p).FullName)
  for ($depth = 0; $depth -le 3 -and $level.Count -gt 0; $depth++) {
    $next = @()
    foreach ($dir in $level) {
      $key = $dir.TrimEnd('\').ToLower()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      if ($key -ne $New.TrimEnd('\').ToLower() -and (IsLauncher $dir)) { $found[$key] = Info $dir.TrimEnd('\'); continue }
      if ($depth -lt 3) {
        $next += @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
          Where-Object { $skipNames -notcontains $_.Name -and $_.Name -notmatch '^[.$]' } | ForEach-Object { $_.FullName })
      }
    }
    $level = $next
  }
}
$list = @($found.Values | Sort-Object Time -Descending)

# 2. 让用户确认
$Old = $null
if ($list.Count -gt 0) {
  Say ''
  Say "找到 $($list.Count) 个旧版本(按最近使用排序):" 'Cyan'
  for ($i = 0; $i -lt $list.Count; $i++) {
    $x = $list[$i]
    Say ("  [{0}] {1}" -f ($i + 1), $x.Path) 'White'
    Say ("      {0} 个分身 · 最后使用 {1:yyyy-MM-dd HH:mm}" -f $x.Profiles, $x.Time)
  }
  Say ''
  $a = Read-Host '输入要更新的编号后回车(直接回车 = 1;输入 0 = 手动输入路径)'
  if ($a -eq '') { $a = '1' }
  if ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $list.Count) { $Old = $list[[int]$a - 1].Path }
}
if (-not $Old) {
  Say ''
  if ($list.Count -eq 0) { Say '没有自动找到旧版本。' 'Yellow' }
  $a = Read-Host '请把旧启动器文件夹拖进这个窗口(或粘贴它的路径),然后回车'
  $Old = $a.Trim().Trim('"').TrimEnd('\')
  if (-not $Old -or -not (IsLauncher $Old)) { Fail "这个文件夹不是启动器(里面没有 launcher\data\profiles.json):$Old" }
}
$Old = $Old.TrimEnd('\')
if ($Old -ieq $New.TrimEnd('\')) { Fail '选中的就是新版本自己,请选旧文件夹。' }
$info = Info $Old
Say ''
Say "将更新:$Old" 'White'
Say ("  里面有 {0} 个分身,数据不会被改动。" -f $info.Profiles)
$a = Read-Host '确认开始更新吗?(Y/n)'
if ($a -match '^[nN]') { Say '已取消,什么都没有改动。'; exit 0 }

# 3. 旧启动器必须先关掉(分身浏览器可以继续开着)
while ($true) {
  $running = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Old, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $running) { break }
  Say '旧的分身启动器还开着,请先关掉它(分身浏览器不用关)。' 'Yellow'
  $a = Read-Host '关好后按回车继续;输入 y 回车由我来关闭'
  if ($a -match '^[yY]') { $running | Stop-Process -Force; Start-Sleep -Seconds 1 }
}

# 4. 备份旧代码和配置文件
$dataFile = Join-Path $Old 'launcher\data\profiles.json'
$dataHash = (Get-FileHash $dataFile).Hash
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bkRoot = Join-Path $Old '_更新备份'
$bk = Join-Path $bkRoot $stamp
New-Item -ItemType Directory -Path $bk -Force | Out-Null
Copy-Item $dataFile (Join-Path $bk 'profiles.json')
$xdOld = $Keep | ForEach-Object { Join-Path $Old $_ }
robocopy $Old (Join-Path $bk 'code') /E /XD $xdOld /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail '备份旧版本失败,已停止更新,原文件没有改动。' }
Get-ChildItem $bkRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Say "✓ 已备份到:$bk" 'DarkGray'

# 5. 复制新代码到旧文件夹,跳过数据目录
$oldPkg = if (Test-Path (Join-Path $Old 'package.json')) { (Get-FileHash (Join-Path $Old 'package.json')).Hash } else { '' }
$xdNew = $Keep | ForEach-Object { Join-Path $New $_ }
robocopy $New $Old /E /XD $xdNew /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "复制新文件失败。旧版本在 $bk\code 里,可以手动复制回来。" }
$newPkg = (Get-FileHash (Join-Path $Old 'package.json')).Hash

# 6. 核对数据文件没有被动过
if ((Get-FileHash $dataFile).Hash -ne $dataHash) {
  Copy-Item (Join-Path $bk 'profiles.json') $dataFile -Force
  Fail '检测到数据文件有变化,已从备份恢复。请把这个窗口截图发给开发者。'
}
Say '✓ 程序文件已更新,分身列表和卡库核对无误' 'Green'

# 7. 依赖有变化才重新安装
$electron = Join-Path $Old 'node_modules\electron\dist\electron.exe'
if ($oldPkg -ne $newPkg -or -not (Test-Path $electron)) {
  Say '依赖有更新,正在安装(需要几分钟)…'
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail '没有找到 npm,请先安装 Node.js:https://nodejs.org/' }
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  Push-Location $Old
  try { npm install; if ($LASTEXITCODE -ne 0) { Fail '依赖安装失败,请检查网络后在旧文件夹里双击「一键启动」重试。' } } finally { Pop-Location }
}

Say ''
Say '✓ 更新完成!' 'Green'
Say "以后请继续用这个文件夹里的「一键启动」:$Old" 'White'
Say "现在这个新下载的文件夹($New)已经用不到了,可以删掉。"
Say '以后再更新,直接在旧文件夹里双击「一键更新」即可。'
$a = Read-Host '现在启动分身启动器吗?(Y/n)'
if ($a -notmatch '^[nN]') { Start-Process -FilePath (Join-Path $Old '一键启动.bat') -WorkingDirectory $Old }
