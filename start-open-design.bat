@echo off
title Open Design Server
echo Starting Open Design with fixed ports...
cd /d "S:\Open Design"
pnpm tools-dev run web --daemon-port 7457 --web-port 5175
