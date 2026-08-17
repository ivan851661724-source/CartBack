@echo off
rem CartBack one-click deploy entry for Windows.
rem Double-click me (a UAC prompt will appear - click Yes).
rem The real logic lives in quickstart.ps1 next to this file.
chcp 65001 >nul
title CartBack One-Click Deploy

echo ============================================================
echo  CartBack One-Click Deploy (Windows)
echo  If a UAC prompt appears, please click "Yes".
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0quickstart.ps1"

echo.
pause
