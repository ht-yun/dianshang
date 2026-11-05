@echo off
chcp 65001 >nul 2>&1
title 停止全部系统
cd /d "%~dp0"

echo.
echo  ==================================================
echo    停止「仿真数据源 :4100」与「主系统 :3000」
echo  ==================================================
echo.

set KILLED=0

for %%P in (3000 4100) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P" ^| findstr "LISTENING"') do (
    echo  正在停止端口 %%P 的进程 PID=%%a ...
    taskkill /F /PID %%a >nul 2>&1
    set /a KILLED+=1
  )
)

if "%KILLED%"=="0" (
  echo  [提示] 未发现运行中的服务，端口 3000 / 4100 都是空闲的。
) else (
  echo.
  echo  [完成] 共停止 %KILLED% 个进程。
)

echo.
pause
