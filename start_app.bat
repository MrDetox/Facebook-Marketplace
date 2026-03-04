@echo off
echo Starting Facebook Marketplace Auto-Lister...
echo.

:: Open the website in a new tab (after a short delay to let server start)
start http://localhost:3000

:: Start the node server
node server.js

pause
