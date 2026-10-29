@echo off
rem PrimebotX sim stack launcher for Windows.
rem   double-click it, or run it from cmd:  scripts\run_sim_stack.cmd
rem It first tries to hand over to run_sim_stack.sh through Git Bash (that path keeps
rem the Ctrl+C cleanup), and if no Git Bash is installed it starts the bridge and the
rem backend itself with python + the built exe.
rem Env vars are honored: PORT, SIM_PORT, SIM_MODE=viewer, PYTHON, PRIMEBOT_BIN.
rem delayed expansion is on so that !cmdcmdline! is substituted after parsing: the value
rem may contain ^&^& (when the script is chained on one cmd line) and must not be re-parsed
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
if not defined PORT set "PORT=8080"
if not defined SIM_PORT set "SIM_PORT=8090"
if not defined SIM_MODE set "SIM_MODE=headless"

rem Launched by double-click? cmd /c ""...\run_sim_stack.cmd" " -> keep the window open.
set "PAUSE_ON_EXIT="
echo "!cmdcmdline!" | "%SystemRoot%\System32\find.exe" /i "%~nx0" >nul && set "PAUSE_ON_EXIT=1"

rem ---------- 1. prefer Git Bash ----------
set "BASH="
call :try_bash "%ProgramFiles%\Git\bin\bash.exe"
call :try_bash "%ProgramFiles%\Git\usr\bin\bash.exe"
call :try_bash "%ProgramFiles(x86)%\Git\bin\bash.exe"
call :try_bash "%LocalAppData%\Programs\Git\bin\bash.exe"
call :try_bash "%USERPROFILE%\scoop\apps\git\current\bin\bash.exe"
if defined BASH goto :via_bash

rem ---------- 2. native fallback: python + exe ----------
echo [sim] Git Bash not found, starting the two processes natively.

set "PY="
if defined PYTHON set "PY=%PYTHON%"
if defined PY goto :have_py
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :have_py
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
:have_py
if not defined PY goto :no_python

%PY% -c "import mujoco" >nul 2>&1
if errorlevel 1 goto :no_mujoco

set "BIN="
if defined PRIMEBOT_BIN if exist "%PRIMEBOT_BIN%" set "BIN=%PRIMEBOT_BIN%"
if defined BIN goto :have_bin
if exist "%ROOT%\backend-build\primebot_backend.exe" set "BIN=%ROOT%\backend-build\primebot_backend.exe"
if defined BIN goto :have_bin
for /d %%D in ("%ROOT%\backend-build*") do if not defined BIN if exist "%%~fD\primebot_backend.exe" set "BIN=%%~fD\primebot_backend.exe"
:have_bin
if not defined BIN goto :no_backend

set "MODE_FLAG=--headless"
if /i "%SIM_MODE%"=="viewer" set "MODE_FLAG="

echo [sim] bridge :%SIM_PORT% (%SIM_MODE%), log in the minimized window
start "PrimebotX sim bridge" /min %PY% "%ROOT%\sim\mujoco_bridge.py" --port %SIM_PORT% %MODE_FLAG%

echo [sim] waiting for the bridge to come up...
set "READY="
for /l %%i in (1,1,30) do if not defined READY call :probe
if not defined READY goto :bridge_timeout

echo [sim] backend :%PORT%
echo [sim] open http://127.0.0.1:%PORT%/ui/PrrimebotX.html and press Connect in the Advance dialog
echo.
"%BIN%" --port %PORT% --web-root "%ROOT%\frontend" --sim-url "http://127.0.0.1:%SIM_PORT%"
rem backend stopped: take the bridge window down with it
"%SystemRoot%\System32\taskkill.exe" /FI "WINDOWTITLE eq PrimebotX sim bridge*" /T /F >nul 2>&1
echo [sim] backend stopped, bridge closed.
goto :done

rem ---------- helpers ----------
:via_bash
echo [sim] using Git Bash: %BASH%
"%BASH%" "%ROOT%\scripts\run_sim_stack.sh" %*
goto :done

:try_bash
if defined BASH exit /b 0
if not exist "%~1" exit /b 0
rem C:\Windows\System32\bash.exe is the WSL stub, not Git Bash: skip it
echo %~1 | "%SystemRoot%\System32\find.exe" /i "\System32\bash.exe" >nul || set "BASH=%~1"
exit /b 0

:probe
%PY% -c "import urllib.request as u;u.urlopen('http://127.0.0.1:%SIM_PORT%/health',timeout=1)" >nul 2>&1
if not errorlevel 1 set "READY=1"
if not defined READY "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
exit /b 0

rem ---------- errors ----------
:no_python
echo [sim] no usable python on PATH. Install Python 3 and retry.
goto :fail

:no_mujoco
echo [sim] python is there but mujoco is not. Run:
echo         %PY% -m pip install -r "%ROOT%\sim\requirements.txt"
goto :fail

:no_backend
echo [sim] primebot_backend.exe not found. Build it once with:
echo         bash scripts/fetch_deps.sh ^&^& bash scripts/build_backend.sh
goto :fail

:bridge_timeout
echo [sim] bridge did not answer /health within 30s. Check the minimized window.
"%SystemRoot%\System32\taskkill.exe" /FI "WINDOWTITLE eq PrimebotX sim bridge*" /T /F >nul 2>&1
goto :fail

:fail
echo.
if defined PAUSE_ON_EXIT pause
endlocal & exit /b 1

:done
set "RC=%ERRORLEVEL%"
if defined PAUSE_ON_EXIT pause
endlocal & exit /b %RC%
