@echo off
REM Opens BIVA desktop without installing (for testing).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages the first time...
  call npm install || goto :fail
)
call npm start
goto :eof
:fail
echo.
echo npm install failed. Make sure Node.js 20 or newer is installed: https://nodejs.org
pause
