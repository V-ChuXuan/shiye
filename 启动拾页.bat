@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 LTS，然后重新打开。
  pause
  exit /b 1
)
if not exist "node_modules\fastify" (
  call npm install --no-fund --no-audit
  if errorlevel 1 goto failed
)
if not exist "dist\server\index.js" (
  call npm run build
  if errorlevel 1 goto failed
)
if not exist "dist\client\index.html" (
  call npm run build
  if errorlevel 1 goto failed
)
echo 正在启动拾页。关闭此窗口会停止本次运行。
call npm start -- --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo 启动失败，请查看上方提示。
pause
exit /b 1
