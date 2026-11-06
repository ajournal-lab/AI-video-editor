@echo off
rem Joins this PC to the AJOURNALLAB Studio render pool. Close the window to leave.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\join-pool.ps1" %*
pause
