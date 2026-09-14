@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=C:\Users\Matebook GT14\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist node_modules (
  echo 缺少必要组件。请先在此文件夹运行 pnpm install。
  pause
  exit /b 1
)
echo.
echo 正在启动北大团支书培训班学分系统...
echo 请勿关闭此窗口。
echo.
"%NODE_EXE%" server.mjs
pause
