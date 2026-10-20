param(
    # 快捷方式放到哪个文件夹,默认是桌面
    [string]$Dir = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'

# 全部路径按脚本自身位置推算:launcher\scripts\ -> launcher\ -> 项目根目录
$launcher = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $launcher

$exe = @(
    (Join-Path $root 'node_modules\electron\dist\electron.exe'),
    (Join-Path $launcher 'node_modules\electron\dist\electron.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $exe) {
    Write-Host '没有找到 electron.exe,请先在项目根目录运行一次:  npm install' -ForegroundColor Red
    Write-Host ('已查找: ' + (Join-Path $root 'node_modules\electron\dist'))
    exit 1
}
if (-not (Test-Path (Join-Path $launcher 'src\main.js'))) {
    Write-Host ('没有找到启动器代码: ' + $launcher) -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }

$lnk = Join-Path $Dir 'Chrome分身启动器.lnk'
$existed = Test-Path $lnk

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $exe
$s.Arguments = '"' + $launcher + '"'
$s.WorkingDirectory = $launcher
$s.IconLocation = "$exe,0"
$s.Description = 'Chrome分身启动器'
$s.Save()

# 读回来核对,确认写进去的和预期一致
$c = $ws.CreateShortcut($lnk)
if ($c.TargetPath -ne $exe -or $c.Arguments -ne ('"' + $launcher + '"')) {
    Write-Host '快捷方式写入后核对不一致,请检查路径。' -ForegroundColor Red
    exit 1
}

Write-Host ($(if ($existed) { '已更新: ' } else { '已创建: ' }) + $lnk) -ForegroundColor Green
Write-Host ('目标:   ' + $c.TargetPath)
Write-Host ('参数:   ' + $c.Arguments)
