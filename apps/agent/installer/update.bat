@echo off
setlocal

rem One-click updater: pulls the latest Agent installer + extension build
rem from this repo's GitHub Release ("latest" is a stable, permanent URL
rem that always points at whichever release was published most recently —
rem no need to look up a version number) and applies both. Uses curl.exe
rem and tar.exe, both built into Windows 10 (1803+) and Windows 11 — no
rem PowerShell execution-policy prompts, no extra installs.
rem
rem Re-run this any time a new version is released.

set REPO=dh0321/download_organizer
set BASE_URL=https://github.com/%REPO%/releases/latest/download
set EXT_DIR=%USERPROFILE%\Documents\DownloadOrganizer-Extension

echo Download Organizer updater
echo ===========================
echo.
echo IMPORTANT: Close Google Chrome completely before continuing. The
echo update needs to replace files Chrome may currently have open.
pause

echo.
echo Downloading latest Agent installer...
curl -L -f -o "%TEMP%\DownloadOrganizerSetup.exe" "%BASE_URL%/DownloadOrganizerSetup.exe"
if errorlevel 1 (
  echo.
  echo Failed to download the Agent installer. Check your internet connection
  echo and try again.
  pause
  exit /b 1
)

echo Installing Agent update (no prompts expected)...
"%TEMP%\DownloadOrganizerSetup.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART

echo.
echo Downloading latest extension files...
curl -L -f -o "%TEMP%\download-organizer-extension.zip" "%BASE_URL%/download-organizer-extension.zip"
if errorlevel 1 (
  echo.
  echo Failed to download the extension update. Check your internet connection
  echo and try again.
  pause
  exit /b 1
)

if not exist "%EXT_DIR%" mkdir "%EXT_DIR%"
echo Updating extension files at:
echo   %EXT_DIR%
tar -xf "%TEMP%\download-organizer-extension.zip" -C "%EXT_DIR%"

echo.
echo Done. Two things left:
echo   1. Open Chrome and start it back up.
echo   2. Go to chrome://extensions and click the reload icon on
echo      "Download Organizer" to pick up the new version.
echo.
pause
