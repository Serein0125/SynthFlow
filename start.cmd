@echo off
chcp 65001 >nul
title SynthFlow - 预生成式 AI 编程工作台
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没有检测到 Node.js。
  echo       请先安装 Node.js 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     SynthFlow · 预生成式 AI 编程工作台
echo   ============================================================
echo     地址：http://127.0.0.1:7788/
echo     生成物：%~dp0workspace
echo     本机数据：%~dp0.synthflow
echo.
echo     浏览器稍后会自动打开；关闭本窗口即停止服务。
echo     想清空生成物：node scripts\clean.mjs --all
echo.
echo   ------------------------------------------------------------
echo.

node src/server.js --port 7788 --open

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
