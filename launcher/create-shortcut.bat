@echo off
rem Double-click to create the desktop shortcut. Extra args are passed through, e.g.  create-shortcut.bat -Dir "D:\some\folder"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1" %*
echo.
pause
