@echo off
rem Double-click to set this PC/VPS up as a Rumbleverse community server - fully automatic:
rem it finds your game files, measures the best region, detects your IP and registers the server;
rem it only asks for your Discord name. It asks for administrator rights once.
rem Options can still be added after the name to override, e.g.:
rem   Setup-RVServer.bat -Region eu-central-1 -Modes solo
rem   Setup-RVServer.bat -Edition Private        (friends only - asks for your setup code)
rem A "kit" folder next to this file (manifest.json + zip) is installed from there instead of
rem being downloaded (test packages).
set "KIT="
if exist "%~dp0kit\manifest.json" set KIT=-KitDir "%~dp0kit"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-RVServer.ps1" -Auto %KIT% %*
