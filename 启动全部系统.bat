@echo off
chcp 65001 >nul 2>&1
title 双系统联动启动 - 仿真数据源 + 智能补货
cd /d "%~dp0"

echo.
echo  ==================================================
echo    电商智能库存补货系统 · 双系统联动启动
echo  ==================================================
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
  echo  [1/3] 首次运行，正在安装主系统依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
) else (
  echo  [1/3] 主系统依赖已就绪
)

echo  [2/3] 启动仿真数据源（独立窗口，端口 4100）...
start "仿真数据源 - :4100" cmd /k call "%~dp0mock-data-service\启动仿真数据源.bat"

echo        等待数据源就绪...
timeout /t 3 /nobreak >nul

echo  [3/3] 启动智能补货主系统（端口 3000）...
echo.
echo  ──────────────────────────────────────────────────
echo   数据源控制台：http://127.0.0.1:4100
echo   主系统界面：  http://localhost:3000
echo.
echo   进入主系统后打开左侧「数据源接入」，
echo   点「立即同步」或开启「定时同步」即可完成联动。
echo  ──────────────────────────────────────────────────
echo.

start "" http://localhost:3000
node --no-warnings server/index.js

echo.
echo  主系统已停止（仿真数据源窗口仍在运行，可单独关闭）。
pause
