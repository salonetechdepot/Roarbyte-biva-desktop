@echo off
setlocal
REM Pushes this folder to GitHub and releases v1.0.0 (GitHub then builds BIVA-Setup.exe).
cd /d "%~dp0"
set "REPO=https://github.com/salonetechdepot/Roarbyte-biva-desktop.git"
set "TAG=v1.0.0"

where git >nul 2>nul || (echo Git is not installed. Get it from https://git-scm.com/download/win & goto :fail)

REM 1. Put the build script where GitHub Actions looks for it.
if exist "ci\release.yml" (
  if not exist ".github\workflows" mkdir ".github\workflows"
  move /Y "ci\release.yml" ".github\workflows\release.yml" >nul
  rmdir "ci" 2>nul
)

REM 2. Local repository + first commit.
if not exist ".git" git init || goto :fail
git config user.name >nul 2>nul || git config user.name "BIVA"
git config user.email >nul 2>nul || git config user.email "lansanasawie7@gmail.com"
git add -A || goto :fail
git commit -m "BIVA desktop app %TAG%" >nul 2>nul
git branch -M main

REM 3. Connect to GitHub (keeps our files if the repo already has a README).
git remote remove origin >nul 2>nul
git remote add origin %REPO% || goto :fail
git pull origin main --allow-unrelated-histories --no-edit -X ours >nul 2>nul
git push -u origin main || goto :fail

REM 4. Tag the release - GitHub Actions builds and publishes BIVA-Setup.exe.
git rev-parse %TAG% >nul 2>nul || git tag %TAG%
git push origin %TAG% || goto :fail

echo.
echo Pushed. GitHub is now building BIVA-Setup.exe (5-8 minutes).
echo Opening the Actions page so you can watch it...
start "" "https://github.com/salonetechdepot/Roarbyte-biva-desktop/actions"
pause
exit /b 0

:fail
echo.
echo Something went wrong - read the message above.
pause
exit /b 1
