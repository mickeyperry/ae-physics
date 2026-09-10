@echo off
title Physics - Uninstaller
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.mickyp.physics"

echo This will remove the Physics extension from:
echo   %DEST%
echo.
choice /C YN /M "Continue?"
if %ERRORLEVEL% NEQ 1 exit /b 0

if exist "%DEST%" rmdir /S /Q "%DEST%"
echo Removed. Restart After Effects to finish.
pause
