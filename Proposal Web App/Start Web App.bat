@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed or not on PATH.
    echo Download it from https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

if not exist data\TNSE_Projects.xlsx (
    echo Initializing workbook...
    node src\init.js
)

echo Starting web server...
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:4180"
node src\web-server.js
