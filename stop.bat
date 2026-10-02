@echo off
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:8765/api/quit | Out-Null; Write-Host 'SimEx stopped.' } catch { Write-Host 'SimEx is not running.' }"
timeout /t 2 >nul
