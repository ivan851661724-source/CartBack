@echo off
chcp 65001 >nul
title CartBack Backend :4173
cd /d "%~dp0backend"
REM 本地一键启动：默认免登录模式（与 scripts/start_local_dev.sh 默认一致；Docker 部署仍默认安全模式 0）。
REM 三条启动入口的环境变量默认值以仓库根 .env.example 为唯一出处（走查 P0-1）。
if "%CARTBACK_OPEN_LOCAL%"=="" set CARTBACK_OPEN_LOCAL=1
echo [CartBack] backend starting on http://localhost:4173 ... (CARTBACK_OPEN_LOCAL=%CARTBACK_OPEN_LOCAL%)
node server.js
pause
