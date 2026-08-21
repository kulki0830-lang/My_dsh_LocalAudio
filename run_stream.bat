@echo off
chcp 65001 >nul
rem LocalAudio_CLI launcher: ensure audio.cpp API server (8081) is running, then run the assistant
pushd "%~dp0"

rem Locate the shared engine: prefer local bin, fall back to the parent bin (D:\.Apps\audiocpp\bin)
set "ENG="
if exist "bin\audiocpp_server.exe" set "ENG=bin\audiocpp_server.exe"
if not defined ENG if exist "..\bin\audiocpp_server.exe" set "ENG=..\bin\audiocpp_server.exe"
if not defined ENG (
  echo ERROR: audiocpp_server.exe not found. Expected in bin\ or ..\bin\
  pause
  exit /b 1
)
set "CFG=server.json"
if not exist "%CFG%" if exist "..\server.json" set "CFG=..\server.json"

rem 1) Check / start audio.cpp API server on port 8081
curl -s -m 2 http://127.0.0.1:8081/health >nul 2>nul
if errorlevel 1 (
  echo Starting audio.cpp API server on port 8081...
  start "audio.cpp API" "%ENG%" --config "%CFG%" --port 8081
  ping -n 6 127.0.0.1 >nul
)
curl -s -m 3 http://127.0.0.1:8081/health
echo.

if not exist ".assistant-venv\Scripts\python.exe" (
  echo Dependencies not installed. Run setup_assistant.bat first.
  pause
  exit /b 1
)

".assistant-venv\Scripts\python.exe" voice_stream.py %*
pause
