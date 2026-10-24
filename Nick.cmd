@echo off
rem Nick.cmd - starts the replay and opens it in the browser; if it runs already, only opens the browser.
rem The first start makes the .venv of this folder and installs requirements.txt (numpy, pandas) into it.
rem Put a desktop shortcut to this file (icon: right-click the shortcut, Properties, Change Icon).
cd /d "%~dp0"
title nickwick replay
if not exist ".venv\Scripts\python.exe" goto makevenv
:check
".venv\Scripts\python.exe" -c "import numpy, pandas" >nul 2>nul || goto install
:run
".venv\Scripts\python.exe" server\launch.py %*
if errorlevel 1 pause
goto :eof

:makevenv
echo Erster Start: lege .venv in diesem Ordner an ...
set "BASE=python"
where py >nul 2>nul && set "BASE=py -3"
%BASE% -m venv .venv
if errorlevel 1 goto nopython
if not exist ".venv\Scripts\python.exe" goto nopython
:install
echo Installiere numpy und pandas in .venv (einmalig, braucht Internet) ...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto nopip
goto run

:nopython
echo.
echo Python wurde nicht gefunden. Python 3.11 oder neuer von python.org installieren
echo (beim Installieren "Add python.exe to PATH" anhaken) und Nick.cmd noch einmal starten.
pause
goto :eof

:nopip
echo.
echo Die Pakete liessen sich nicht installieren (Internet?). Nick.cmd noch einmal starten, oder von Hand:
echo   .venv\Scripts\python -m pip install -r requirements.txt
pause
