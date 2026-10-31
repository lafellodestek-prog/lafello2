@echo off
title Lafello
cd /d "%~dp0"
if not exist node_modules call npm install
node paylas.js
pause
