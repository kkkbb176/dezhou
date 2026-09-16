@echo off
setlocal

rem ============================================================
rem  Alpha launcher (double-click to run)
rem
rem  1. already running  -> just open the browser
rem  2. not running      -> start it in its OWN window
rem  3. wait until it really answers, then open the browser
rem
rem  NOTE: this file is deliberately pure ASCII. cmd.exe reads .cmd
rem  files using the OEM codepage (GBK on this machine), so UTF-8
rem  Chinese text here gets mangled into broken commands.
rem
rem  Port: 5173 by default, override with ALPHA_PORT.
rem ============================================================

cd /d "%~dp0.."

if "%ALPHA_PORT%"=="" set ALPHA_PORT=5173
set ALPHA_URL=http://127.0.0.1:%ALPHA_PORT%

echo.
echo   Alpha internal tool
echo   ===================
echo   Dir : %CD%
echo   URL : %ALPHA_URL%
echo.

rem ---- 1. already listening? ----
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%ALPHA_URL%/' -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1" >nul 2>&1
if %errorlevel% equ 0 (
  echo   [1/3] Already running - opening browser.
  goto :open
)

rem ---- 2. start in its own window ----
echo   [1/3] Not running - starting server...
start "Alpha Server (close this window to stop)" cmd /k "node.exe --experimental-strip-types ""src\app\webServer.ts"""

rem ---- 3. poll until ready (max ~30s) ----
echo   [2/3] Waiting for the server to answer...
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%ALPHA_URL%/' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1" >nul 2>&1
if %errorlevel% equ 0 goto :ready
if %tries% geq 15 goto :timeout
timeout /t 2 /nobreak >nul
goto :wait

:ready
echo   [3/3] Server is ready (after %tries% checks).
echo.

:open
start "" "%ALPHA_URL%"
echo   Opened %ALPHA_URL%
echo.
echo   Home page = the table.  GTO range page = %ALPHA_URL%/gto
echo   To stop: close the window titled "Alpha Server".
echo.
pause
exit /b 0

:timeout
echo.
echo   [X] Timed out: no answer within 30 seconds.
echo.
echo   Look at the window titled "Alpha Server" for the error.
echo   The two usual causes:
echo     1. port %ALPHA_PORT% is taken by something else
echo     2. Node is older than 24 (this project needs --experimental-strip-types)
echo.
echo   To use another port:
echo     set ALPHA_PORT=8080
echo     then run this file again
echo.
pause
exit /b 1
