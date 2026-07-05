@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ─── 检查 Node.js ───
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

rem ─── 首次启动自动安装依赖 ───
if not exist node_modules (
  echo [初始化] 首次启动，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络或 npm 配置
    pause
    exit /b 1
  )
  echo [初始化] 依赖安装完成
  echo.
)

echo ============================================
echo   Agent Bridge 启动中...
echo   扫码页:    http://localhost:18789/pair
echo   按 Ctrl+C 停止服务
echo ============================================
echo.

rem ─── 延迟 3 秒后自动打开浏览器到 /pair 页面 ───
start /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:18789/pair'"

rem ─── 启动服务器 ───
rem 必须用 npx tsx 直接启动，不能用 npm start / npm run dev
rem 原因：npm 会用 cmd /c 包一层，重定向子进程 stdout，导致 spawn CC 子进程时
rem       CC 继承无效的 fd，写 session 文件时报 EBADF: bad file descriptor
npx tsx src/index.ts
