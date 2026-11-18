@echo off
rem Update your OLD launcher folder with the code in THIS (newly downloaded) folder. Data in the old folder is kept.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\upgrade-old.ps1"
echo.
pause
