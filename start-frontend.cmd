@echo off
chcp 65001 >nul
title CartBack Frontend :3100
cd /d "%~dp0frontend"
set BACKEND_URL=http://localhost:4173
echo [CartBack] frontend starting on http://localhost:3100 (API -^> %BACKEND_URL%) ...
call npx next dev -p 3100
pause
