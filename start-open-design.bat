@echo off
title Open Design Server
echo Starting Open Design with fixed ports...
cd /d "S:\Open Design"

:: Start the server in a separate window (minimized)
start /min "Open Design Server" cmd /c "pnpm tools-dev run web --daemon-port 7457 --web-port 5175"

:: Wait 10 seconds for the server to spin up
timeout /t 10 /nobreak > nul

:: Open the browser
start http://127.0.0.1:5175/
