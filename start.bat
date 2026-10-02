@echo off
title SimEx - Trading Simulator
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required: https://nodejs.org
  pause
  exit /b 1
)
start "" "http://localhost:8765"
node server.js
pause
