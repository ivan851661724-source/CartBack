@echo off
chcp 65001 >nul
title CartBack Backend :4173
cd /d "%~dp0backend"
echo [CartBack] backend starting on http://localhost:4173 ...
node server.js
pause
