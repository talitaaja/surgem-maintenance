@echo off
setlocal
cd /d "%~dp0"
title SurGem Maintenance

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo Node.js belum terpasang di komputer ini.
    echo Browser akan membuka halaman pemasangan Node.js.
    echo Setelah Node.js selesai dipasang, klik kembali file ini.
    echo.
    start "" "https://nodejs.org/en/download"
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:31726/admin.html' -TimeoutSec 2; if ($r.Headers['X-SurGem-Server'] -eq 'SurGem-Admin-v4') { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
    start "" "http://127.0.0.1:31726/admin.html"
    exit /b 0
)

set PORT=31726
set SURGEM_AUTO_OPEN=1
node server.js

echo.
echo SurGem berhenti. Tekan tombol apa saja untuk menutup.
pause >nul
