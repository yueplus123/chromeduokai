@echo off
rem Double-click: auto-configure IPRoyal residential proxy chain in Clash Verge
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node "%~dp0launcher\tools\find-chain.js"
echo.
pause
