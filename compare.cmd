@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 goto done
"%~dp0.venv\Scripts\python.exe" "%~dp0compare.py"
:done
pause
