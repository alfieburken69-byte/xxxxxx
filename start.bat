@echo off
title Rolimon's Presence Tracker
cd /d "%~dp0"
node src\index.js
echo.
echo Tracker stopped. Press any key to close.
pause >nul
