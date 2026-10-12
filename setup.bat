@echo off
rem ReelSmith setup: checks/installs everything and ends with a pass/fail checklist.
rem Options are passed through, e.g.  setup.bat -DataDir D:\ReelSmith  or  setup.bat -CheckOnly
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
