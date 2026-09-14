@echo off
chcp 65001 >nul
net session >nul 2>nul
if not %errorlevel%==0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall add rule name="北大团支书培训班学分系统" dir=in action=allow protocol=TCP localport=8787 profile=private
echo.
echo 已允许同一局域网内的设备访问 8787 端口。
pause
