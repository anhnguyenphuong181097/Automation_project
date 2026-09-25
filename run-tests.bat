@echo off
echo ========================================
echo Terminal Batch Test Runner
echo ========================================
echo.

echo Step 1: Installing dependencies...
call npm install

echo.
echo Step 2: Generating test files...
call npm run generate

echo.
echo Step 3: Running tests...
call npm run test:all

echo.
echo Step 4: Generating report...
call npm run report

echo.
echo Tests completed!
pause