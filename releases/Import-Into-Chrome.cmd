@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0..\scripts\import-release.ps1"
endlocal
