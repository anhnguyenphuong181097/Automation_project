@echo off
echo ========================================
echo Generating Test Files
echo ========================================
echo.

cd /d C:\BATCH-OCBC-PW1

echo Running file-generator.js...
node scripts/file-generator.js

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to generate files!
    pause
    exit /b 1
)

echo.
echo ========================================
echo Files generated successfully!
echo ========================================
echo.
pause