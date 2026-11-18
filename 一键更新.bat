@echo off
rem One-click update: download the latest code from GitHub. Your data (launcher\data, profiles folder) is kept.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update.ps1"
echo.
pause
