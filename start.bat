@echo off
rem Starts ReelSmith's three processes in their own windows, then opens the app.
cd /d "%~dp0"
if not exist "worker\.venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
start "ReelSmith web" cmd /k npm run dev
start "ReelSmith agent runner" cmd /k npm run agent
start "ReelSmith worker" cmd /k worker\.venv\Scripts\python.exe worker\main.py
timeout /t 8 /nobreak >nul
start "" http://localhost:3000
