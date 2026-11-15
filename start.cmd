@echo off
cd /d "%~dp0server"
if not exist node_modules call npm install --no-fund --no-audit
node server.js
pause
