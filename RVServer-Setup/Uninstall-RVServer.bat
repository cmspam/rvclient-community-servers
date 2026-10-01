@echo off
rem Removes the Rumbleverse server that Setup-RVServer.bat installed on this PC.
rem It asks first whether to KEEP the server installed (stopped, files kept) or remove everything.
rem Either way your own game install is checked and left normal.
rem Options:  -Mode Keep   -Mode All   -InstallDir D:\RVServer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-RVServer.ps1" %*
