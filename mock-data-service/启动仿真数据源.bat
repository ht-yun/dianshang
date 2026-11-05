@echo off
chcp 65001 >nul 2>&1
title 商品仿真数据生成子系统
cd /d "%~dp0"

echo.
echo  ============================================
echo    商品仿真数据生成子系统  v1.0.0
echo  ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [错误] 未检测到 Node.js
  echo  请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo  本服务零第三方依赖，无需 npm install。
echo.
echo  访问地址：http://127.0.0.1:4100
echo  接口示例：http://127.0.0.1:4100/api/products?count=10
echo  停止服务：在此窗口按 Ctrl+C
echo.

start "" http://127.0.0.1:4100
node --no-warnings src/server.js

echo.
echo  服务已停止。
pause
