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

rem === Start server (MUST use npx tsx, NOT npm start / npm run dev) ===
rem Reason: npm wraps with cmd /c and redirects stdout, causing CC child
rem         process to inherit invalid fd, triggering EBADF on session write.
npx tsx src/index.ts
