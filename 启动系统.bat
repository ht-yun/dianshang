@echo off
chcp 65001 >nul 2>&1
title 电商智能库存补货系统
cd /d "%~dp0"

echo.
echo  ============================================
echo    电商智能库存补货系统  v1.0.0
echo  ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [错误] 未检测到 Node.js
  echo  请先安装 Node.js 22.5 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  [1/2] 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
) else (
  echo  [1/2] 依赖已就绪
)

echo  [2/2] 正在启动服务，浏览器将自动打开...
echo.
echo  访问地址：http://localhost:3000
echo  停止服务：在此窗口按 Ctrl+C
echo.

start "" http://localhost:3000
node --no-warnings server/index.js

echo.
echo  服务已停止。
pause
