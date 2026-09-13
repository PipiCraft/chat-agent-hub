@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Chat Agent Hub

REM 检查 Node.js 环境
where node >nul 2>&1
if errorlevel 1 goto node_missing

:main_entry
REM 检查当前是否在运行
set HUB_PID=
set IS_RUNNING=0

if not exist "%~dp0bridge.pid" goto check_process_fallback

set /p CHECK_PID=<"%~dp0bridge.pid"
if not defined CHECK_PID goto check_process_fallback

tasklist /FI "PID eq %CHECK_PID%" 2>nul | findstr /i "%CHECK_PID%" >nul
if errorlevel 1 goto pid_stale

set HUB_PID=%CHECK_PID%
set IS_RUNNING=1
goto route_args

:pid_stale
del /f /q "%~dp0bridge.pid" >nul 2>&1

:check_process_fallback
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*bridge.mjs*' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($p) { $p }"`) do (
    set HUB_PID=%%i
    set IS_RUNNING=1
    echo %%i>"%~dp0bridge.pid"
)

:route_args
REM 命令行参数分发
if /i "%~1"=="start" goto cmd_start
if /i "%~1"=="stop" goto cmd_stop
if /i "%~1"=="restart" goto cmd_restart
if /i "%~1"=="status" goto cmd_status
if /i "%~1"=="config" goto cmd_config
if /i "%~1"=="setup" goto cmd_config

REM 交互模式 (双击运行)
if "%IS_RUNNING%"=="1" goto menu_running
goto menu_stopped

:menu_running
cls
echo ========================================================
echo   Chat Agent Hub 服务管理
echo ========================================================
echo 状态: 正在后台运行 (PID: %HUB_PID%)
echo.
echo [操作选项]
echo   直接按 [回车键]  : 停止服务
echo   输入 r 然后回车  : 重启服务
echo   输入 l 然后回车  : 查看最近运行日志
echo   输入 c 然后回车  : 通道配置向导 (添加/修改飞书、钉钉)
echo   输入 q 然后回车  : 退出此窗口 (服务保持后台运行)
echo ========================================================
set ACTION=
set /p ACTION="请选择操作 [直接回车=停止服务]: "
if "%ACTION%"=="" goto do_stop
if /i "%ACTION:~0,1%"=="r" goto do_restart
if /i "%ACTION:~0,1%"=="l" goto do_logs
if /i "%ACTION:~0,1%"=="c" goto do_config
if /i "%ACTION:~0,1%"=="q" exit /b 0
goto do_stop

:menu_stopped
cls
echo ========================================================
echo   Chat Agent Hub 服务管理
echo ========================================================
echo 状态: 未运行
echo.
echo [启动选项]
echo   直接按 [回车键]  : 控制台模式 (保留终端窗口，实时查看日志/扫码)
echo   输入 2 然后回车  : 后台静默模式 (启动后窗口立即自动关闭，无黑窗口)
echo   输入 c 然后回车  : 通道配置向导 (添加/修改飞书、钉钉)
echo   输入 q 然后回车  : 退出
echo ========================================================
set CHOICE=
set /p CHOICE="请选择启动方式 [直接回车=1]: "
if "%CHOICE%"=="" goto do_start_console
if "%CHOICE:~0,1%"=="2" goto do_start_silent
if /i "%CHOICE:~0,1%"=="c" goto do_config
if /i "%CHOICE:~0,1%"=="q" exit /b 0
goto do_start_console

:cmd_start
if "%IS_RUNNING%"=="1" goto cmd_start_already
if /i "%~2"=="-s" goto do_start_silent
if /i "%~2"=="--silent" goto do_start_silent
goto do_start_console

:cmd_start_already
echo [提示] Chat Agent Hub 已经在运行中 (PID: %HUB_PID%)
exit /b 0

:cmd_stop
if "%IS_RUNNING%"=="0" goto cmd_stop_not_running
goto do_stop

:cmd_stop_not_running
echo [提示] Chat Agent Hub 当前未运行
exit /b 0

:cmd_restart
if "%IS_RUNNING%"=="0" goto cmd_restart_launch
echo [*] 正在停止正在运行的服务 [PID: %HUB_PID%]...
taskkill /F /PID %HUB_PID% /T >nul 2>&1
if exist "%~dp0bridge.pid" del /f /q "%~dp0bridge.pid" >nul 2>&1
ping 127.0.0.1 -n 2 >nul 2>&1

:cmd_restart_launch
if /i "%~2"=="-s" goto do_start_silent
if /i "%~2"=="--silent" goto do_start_silent
goto do_start_console

:cmd_status
if "%IS_RUNNING%"=="1" goto cmd_status_running
echo [状态] Chat Agent Hub 当前未运行
exit /b 0

:cmd_status_running
echo [状态] Chat Agent Hub 正在运行 (PID: %HUB_PID%)
exit /b 0

:do_start_console
title Chat Agent Hub [控制台模式]
cls
echo ========================================================
echo   Chat Agent Hub (控制台模式)
echo   * 实时输出通道连接与执行日志
echo   * 按 Ctrl+C 可随时终止服务
echo ========================================================
echo.
node bridge.mjs
pause
exit /b 0

:do_start_silent
echo.
echo [*] 正在启动后台静默进程...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = '%~dp0'.TrimEnd('\'); Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('node.exe \"' + $dir + '\bridge.mjs\"'); CurrentDirectory=$dir}" >nul 2>&1
ping 127.0.0.1 -n 2 >nul 2>&1
echo [+] Chat Agent Hub 已在后台启动 (无黑窗口常驻)
echo [i] 如需关闭服务，再次双击本脚本按回车即可。
ping 127.0.0.1 -n 3 >nul 2>&1
exit /b 0

:do_stop
echo.
echo [*] 正在停止服务 [PID: %HUB_PID%]...
taskkill /F /PID %HUB_PID% /T >nul 2>&1
if exist "%~dp0bridge.pid" del /f /q "%~dp0bridge.pid" >nul 2>&1
echo [+] 服务已成功停止
if "%~1"=="" ping 127.0.0.1 -n 3 >nul 2>&1
exit /b 0

:do_restart
echo.
echo [*] 正在停止旧服务 [PID: %HUB_PID%]...
taskkill /F /PID %HUB_PID% /T >nul 2>&1
if exist "%~dp0bridge.pid" del /f /q "%~dp0bridge.pid" >nul 2>&1
ping 127.0.0.1 -n 2 >nul 2>&1
goto do_start_console

:do_logs
cls
echo ================= 最近 30 行运行日志 =================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$logDir = Join-Path '%~dp0' 'logs'; if (Test-Path $logDir) { $latest = Get-ChildItem -Path $logDir -Filter '*.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($latest) { Write-Host ('[日志文件: ' + $latest.Name + ']'); Write-Host ''; Get-Content $latest.FullName -Tail 30 } else { Write-Host '暂无日志记录' } } else { Write-Host '暂无日志记录' }"
echo =======================================================
echo.
pause
goto main_entry

:cmd_config
:do_config
cls
node core/wizard.mjs
goto main_entry

:node_missing
echo [错误] 未检测到 Node.js 环境，请先安装 Node.js (>= 18.0.0)。
echo 下载地址: https://nodejs.org/
pause
exit /b 1
