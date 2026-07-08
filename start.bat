@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem === Check Node.js ===
where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found. Install from https://nodejs.org/
  pause
  exit /b 1
)

rem === Auto install deps on first run ===
if not exist node_modules (
  echo [Init] First run, installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [Error] npm install failed
    pause
    exit /b 1
  )
  echo [Init] Dependencies installed
  echo.
)

echo ============================================
echo   Agent Bridge starting...
echo   Pair page: http://localhost:18789/pair
echo   Press Ctrl+C to stop
echo ============================================
echo.

rem === Open browser to /pair after 3s ===
start /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:18789/pair'"

rem === Start server with auto-restart loop ===
rem Exit code 42 = restart requested from mobile
rem Any other exit = stop
:restart_loop
npx tsx src/index.ts
set EXIT_CODE=%errorlevel%
if %EXIT_CODE% equ 42 (
  echo.
  echo ============================================
  echo   Restarting... (exit code 42)
  echo ============================================
  echo.
  goto restart_loop
)

rem Non-restart exit - pause to show error
if %EXIT_CODE% neq 0 (
  echo.
  echo [Error] Server exited with code %EXIT_CODE%
  pause
)
