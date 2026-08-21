@echo off
rem One-time setup: create venv and install sounddevice / numpy / requests
pushd "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo ERROR: python not found in PATH. Install Python 3.10+ first.
  pause
  exit /b 1
)

if not exist ".assistant-venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv .assistant-venv
  if errorlevel 1 (
    echo ERROR: venv creation failed.
    pause
    exit /b 1
  )
)

rem Ensure pip exists inside the venv (retry ensurepip if missing)
".assistant-venv\Scripts\python.exe" -m pip --version >nul 2>nul
if errorlevel 1 (
  echo Bootstrapping pip into the venv...
  ".assistant-venv\Scripts\python.exe" -m ensurepip --upgrade --default-pip
  if errorlevel 1 (
    echo ERROR: pip bootstrap failed inside the venv.
    pause
    exit /b 1
  )
)

echo Installing dependencies...
".assistant-venv\Scripts\python.exe" -m pip install --disable-pip-version-check sounddevice numpy requests
if errorlevel 1 (
  echo.
  echo ERROR: dependency install failed. If it is a network issue, retry later.
  pause
  exit /b 1
)

echo.
echo Done. Now edit assistant_config.json to add your DeepSeek API key,
echo then run run_assistant.bat
pause
