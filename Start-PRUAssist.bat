@echo off
title PRUAssist Launcher
echo ============================================
echo    Starting PRUAssist...
echo ============================================
echo.
echo  One-time setup first (see SETUP.md):
echo    - Node.js installed
echo    - ngrok installed + your authtoken set:  ngrok config add-authtoken YOUR_TOKEN
echo    - pruassist-ui\.env.local in place
echo.

REM Optional: your OWN reserved ngrok domain (leave blank to get a random URL each run).
REM   Example:  set "NGROK_DOMAIN=your-name.ngrok-free.app"
set "NGROK_DOMAIN="

REM Portable copies of Node/ngrok often live under %LOCALAPPDATA%\Programs — add those to
REM PATH so they're found. (Harmless if you installed them normally: missing folders are skipped.)
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Programs\ngrok;%PATH%"

REM Run from the web-app folder (this .bat sits one level above it)
cd /d "%~dp0pruassist-ui"

REM First run only: install dependencies if they're missing
if not exist "node_modules\" (
  echo First run - installing dependencies, this can take a few minutes...
  call npm install
  echo.
)

REM 1) Start the Next.js dev server (uses whatever Node/npm is on your PATH)
start "PRUAssist - Dev Server" cmd /k "npm run dev"

REM 2) Wait for it to boot, then start the public HTTPS tunnel (uses ngrok on your PATH)
timeout /t 8 /nobreak >nul
if defined NGROK_DOMAIN (
  start "PRUAssist - Tunnel (ngrok)" cmd /k "ngrok http --url=https://%NGROK_DOMAIN% 3000"
) else (
  start "PRUAssist - Tunnel (ngrok)" cmd /k "ngrok http 3000"
)

REM 3) Open the public URL automatically (read from ngrok's local API when it's random)
if defined NGROK_DOMAIN (
  timeout /t 5 /nobreak >nul
  start "" "https://%NGROK_DOMAIN%/login"
) else (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 7; try { $u=((Invoke-RestMethod http://localhost:4040/api/tunnels).tunnels | Where-Object { $_.public_url -like 'https*' } | Select-Object -First 1).public_url } catch { $u=$null }; if ($u) { Start-Process ($u + '/login') } else { Start-Process 'http://localhost:4040' }"
)

echo.
echo  PRUAssist is starting in two windows:
echo    - "Dev Server"  (the app)
echo    - "Tunnel"      (the public link for phones / other devices)
echo.
echo  Your browser opens the public https link automatically.
echo  To STOP PRUAssist, close those two windows. You can close THIS window now.
echo.
timeout /t 14 /nobreak >nul
