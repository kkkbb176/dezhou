@echo off
setlocal

rem ============================================================
rem  Stop the Alpha server.
rem
rem  Kills ONLY the process listening on the given port, so the
rem  GTOpen solver (3737) and other node processes are untouched.
rem
rem  Pure ASCII on purpose - see the note in start-alpha.cmd.
rem  Port: 5173 by default, override with ALPHA_PORT.
rem ============================================================

if "%ALPHA_PORT%"=="" set ALPHA_PORT=5173

echo.
echo   Looking for a listener on 127.0.0.1:%ALPHA_PORT% ...

set ALPHA_PID=
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort %ALPHA_PORT% -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"`) do set ALPHA_PID=%%P

if "%ALPHA_PID%"=="" (
  echo   Nothing is listening on port %ALPHA_PORT% - the server is not running.
  echo.
  pause
  exit /b 0
)

echo   Found PID=%ALPHA_PID% - stopping it...
taskkill /PID %ALPHA_PID% /F >nul 2>&1
if %errorlevel% equ 0 (
  echo   Done. Port %ALPHA_PORT% is now free.
) else (
  echo   Failed to stop it. It is probably owned by another user or needs admin rights.
)
echo.
pause
exit /b 0
