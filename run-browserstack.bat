@echo off
setlocal EnableDelayedExpansion
title ParentPay BrowserStack Stress

cd /d "C:\BlueRunner Solutions Latest\Auto Extra\POSStressTest" || (
    echo ERROR: Project directory not found.
    goto :end
)

rem ---- Credentials: presence check only, values are never printed ----
if not defined BROWSERSTACK_USERNAME goto :nocreds
if not defined BROWSERSTACK_ACCESS_KEY goto :nocreds
goto :menu

:nocreds
echo.
echo ERROR: BrowserStack credentials are missing.
echo The Windows User-level variables BROWSERSTACK_USERNAME and
echo BROWSERSTACK_ACCESS_KEY must both be set. Set them once, then open a new window.
goto :end

:menu
echo.
echo ========================================
echo       ParentPay BrowserStack Stress
echo ========================================
echo.
echo Run type:
echo   1. Cycles
echo   2. Duration - minutes
echo.
set "CHOICE="
set /p "CHOICE=Choose [1/2]: "
if "!CHOICE!"=="1" goto :cycles
if "!CHOICE!"=="2" goto :duration
echo ERROR: Please enter 1 or 2.
goto :menu

:cycles
set "VAL="
set /p "VAL=Enter number of cycles: "
echo "!VAL!"| findstr /r /c:"^\"[1-9][0-9]*\" *$" >nul
if errorlevel 1 (
    echo ERROR: Cycles must be a positive whole number.
    goto :menu
)
set "RUN_MODE=cycles"
set "MAX_CYCLES=!VAL!"
set "RUN_MODE_TEXT=Cycles"
set "RUN_LIMIT_LINE=Cycles: !VAL!"
goto :apk

:duration
set "VAL="
set /p "VAL=Enter duration in minutes: "
echo "!VAL!"| findstr /r /c:"^\"[1-9][0-9]*\" *$" >nul
if errorlevel 1 (
    echo ERROR: Duration must be a positive whole number.
    goto :menu
)
set "RUN_MODE=duration"
set "DURATION_MINS=!VAL!"
set "RUN_MODE_TEXT=Duration"
set "RUN_LIMIT_LINE=Duration: !VAL! min"
goto :apk

:apk
echo.
set "APKCHOICE="
set /p "APKCHOICE=Use default BrowserStack APK? [Y/N]: "
if /i "!APKCHOICE!"=="Y" goto :apkdefault
if /i "!APKCHOICE!"=="N" goto :apkoverride
echo ERROR: Please enter Y or N.
goto :apk

:apkdefault
rem Clear any inherited override so browserstack.json appId is really used.
set "BROWSERSTACK_APP_ID="
set "APK_TEXT=Default"
for /f "delims=" %%A in ('node -e "console.log(require('./config/browserstack.json').appId)" 2^>nul') do set "APP_ID_TEXT=%%A"
if not defined APP_ID_TEXT set "APP_ID_TEXT=(from config/browserstack.json)"
goto :summary

:apkoverride
set "NEWAPP="
set /p "NEWAPP=Enter BrowserStack App ID (bs://...): "
echo "!NEWAPP!"| findstr /r /c:"^\"bs://[A-Za-z0-9_-][A-Za-z0-9_-]*\" *$" >nul
if errorlevel 1 (
    echo ERROR: App ID must look like bs://abc123 with no spaces.
    goto :apk
)
set "BROWSERSTACK_APP_ID=!NEWAPP!"
set "APK_TEXT=Overridden"
set "APP_ID_TEXT=!NEWAPP!"
goto :summary

:summary
set "MASKED_USER=!BROWSERSTACK_USERNAME:~0,2!***"
echo.
echo ========================================
echo           RUN CONFIGURATION
echo ========================================
echo.
echo Environment: BrowserStack
echo Username: !MASKED_USER!
echo Run Mode: !RUN_MODE_TEXT!
echo !RUN_LIMIT_LINE!
echo APK: !APK_TEXT!
echo App ID: !APP_ID_TEXT!
echo ========================================
echo.
echo Ready to start BrowserStack stress test.
echo.
:confirm
set "GO="
set /p "GO=Press Y to start or N to cancel: "
if /i "!GO!"=="Y" goto :run
if /i "!GO!"=="N" (
    echo Cancelled. Nothing was run.
    goto :end
)
echo ERROR: Please enter Y or N.
goto :confirm

:run
echo.
call npm run stress:browserstack
set "RC=!ERRORLEVEL!"

set "LATEST_LOG="
if exist "logs" (
    for /f "delims=" %%D in ('dir /b /ad /o-n "logs" 2^>nul') do (
        if not defined LATEST_LOG set "LATEST_LOG=%%D"
    )
)

echo.
echo ========================================
echo BrowserStack run finished.
if "!RC!"=="0" (
    echo Status: PASS
) else (
    echo Status: FAIL
)
echo Exit code: !RC!
echo ========================================
if defined LATEST_LOG (
    echo Logs:
    echo %CD%\logs\!LATEST_LOG!
) else (
    echo Logs: not found under %CD%\logs
)

:end
echo.
pause
if defined RC exit /b !RC!
exit /b 0
