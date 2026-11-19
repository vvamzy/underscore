@echo off
:: Underscore launcher for Windows
:: Double-click to run setup or start the app without touching PowerShell directly.

cd /d "%~dp0"

:menu
cls
echo.
echo   Underscore - Vocal Extractor
echo   ============================
echo.
echo   1) First-time setup  (run once, installs Python packages)
echo   2) Start the app     (everyday use - opens http://localhost:8000)
echo   3) Exit
echo.
set /p choice="Choose an option [1-3]: "

if "%choice%"=="1" goto setup
if "%choice%"=="2" goto start
if "%choice%"=="3" goto exit

echo.
echo   Invalid choice, try again.
pause
goto menu

:setup
echo.
echo   Running setup.ps1 ...
echo.
powershell -ExecutionPolicy Bypass -File setup.ps1
if %ERRORLEVEL% neq 0 (
    echo.
    echo   Setup failed. See the error above.
    pause
    goto exit
)
echo.
echo   Setup complete! You can now choose option 2 to start the app.
pause
goto menu

:start
echo.
echo   Starting Underscore on http://localhost:8000 ...
echo.
powershell -ExecutionPolicy Bypass -File start.ps1
if %ERRORLEVEL% neq 0 (
    echo.
    echo   The app stopped. See the error above.
    pause
)
goto exit

:exit
