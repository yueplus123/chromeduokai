@echo off
rem 一键启动 Chrome分身启动器：双击即可。首次运行会自动安装依赖。
setlocal
cd /d "%~dp0"
set "EXE=%~dp0node_modules\electron\dist\electron.exe"

if exist "%EXE%" goto run

echo 首次运行，正在安装依赖，需要几分钟，请稍候……
where npm >nul 2>nul
if errorlevel 1 goto nonode
rem 国内网络下载 Electron 走镜像，速度快很多
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call npm install
if errorlevel 1 goto fail
if not exist "%EXE%" goto fail
echo 安装完成。

:run
start "" "%EXE%" "%~dp0launcher"
exit /b 0

:nonode
echo.
echo 没有找到 npm，请先安装 Node.js：https://nodejs.org/
echo 安装好后重新双击本脚本即可。
pause
exit /b 1

:fail
echo.
echo 依赖安装失败，请检查网络后重新双击本脚本。
pause
exit /b 1
