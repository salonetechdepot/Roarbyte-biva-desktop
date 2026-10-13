@echo off
REM Builds the Windows installer: dist\BIVA-Setup-<version>.exe
cd /d "%~dp0"
echo Installing packages...
call npm install || goto :fail
echo.
echo Building the BIVA installer (this takes a few minutes the first time)...
call npm run dist || goto :fail
echo.
echo Done. Your installer is in: %~dp0dist
start "" "%~dp0dist"
pause
goto :eof
:fail
echo.
echo The build failed. Scroll up to see the error.
pause
