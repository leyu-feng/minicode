@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "HAS_REPO_ROOT="
for %%A in (%*) do (
  if /I "%%~A"=="-repo_root" set "HAS_REPO_ROOT=1"
)
if defined HAS_REPO_ROOT (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%..\minicode.ps1" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%..\minicode.ps1" -repo_root "%cd%" %*
)
exit /b %ERRORLEVEL%
