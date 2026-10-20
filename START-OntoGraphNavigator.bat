@echo off
setlocal enabledelayedexpansion
title OntoGraphNavigator

REM Immer im Ordner dieser Datei arbeiten (egal von wo aus doppelgeklickt wird)
cd /d "%~dp0"

echo.
echo   ============================================
echo   ==           OntoGraphNavigator           ==
echo   ============================================
echo.

REM ---------------------------------------------------------------------------
REM  1) Ist Node.js installiert?
REM ---------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo   [!] Node.js wurde auf diesem Computer nicht gefunden.
    echo.
    echo       Bitte einmalig Node.js installieren ^(die "LTS"-Version^):
    echo         https://nodejs.org/de/download
    echo.
    echo       Nach der Installation diese Datei einfach erneut
    echo       per Doppelklick starten.
    echo.
    pause
    exit /b 1
)

REM ---------------------------------------------------------------------------
REM  2) Beim allerersten Start: benoetigte Komponenten installieren
REM ---------------------------------------------------------------------------
if not exist "node_modules" (
    echo   [i] Erster Start erkannt - benoetigte Komponenten werden installiert.
    echo       Das dauert einmalig ein paar Minuten. Bitte warten...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [x] Die Installation ist leider fehlgeschlagen.
        echo       Bitte Internetverbindung pruefen und Datei erneut starten.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo   [ok] Installation abgeschlossen.
    echo.
)

REM ---------------------------------------------------------------------------
REM  3) Navigator starten - der Browser oeffnet sich automatisch
REM ---------------------------------------------------------------------------
echo   [i] Der OntoGraphNavigator startet und oeffnet sich gleich im Browser.
echo       Adresse (meist):  http://localhost:3002
echo.
echo   ------------------------------------------------------------
echo    Dieses Fenster bitte GEOEFFNET lassen, solange die App
echo    genutzt wird. Zum Beenden einfach dieses Fenster schliessen.
echo   ------------------------------------------------------------
echo.

call npm run dev -- --open

REM Falls der Server unerwartet endet, Fenster offen halten:
echo.
echo   [i] Der OntoGraphNavigator wurde beendet.
pause
