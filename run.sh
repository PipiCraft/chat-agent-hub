#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# 检查 Node.js 环境
if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 未检测到 Node.js 环境，请先安装 Node.js (>= 18.0.0)。"
    exit 1
fi

get_pid() {
    if [ -f "bridge.pid" ]; then
        local p
        p=$(cat bridge.pid 2>/dev/null)
        if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
            echo "$p"
            return
        fi
        rm -f bridge.pid 2>/dev/null
    fi
    local found
    found=$(pgrep -f "node bridge.mjs" | head -n 1)
    if [ -n "$found" ]; then
        echo "$found" > bridge.pid
        echo "$found"
        return
    fi
}

PID=$(get_pid)

start_console() {
    echo "========================================================"
    echo "  Chat Agent Hub (前台控制台模式)"
    echo "  * 实时输出连接与执行日志"
    echo "  * 按 Ctrl+C 可随时终止服务"
    echo "========================================================"
    node bridge.mjs
}

start_daemon() {
    echo "[*] 正在后台启动 Chat Agent Hub..."
    mkdir -p logs
    nohup node bridge.mjs >> logs/hub.log 2>&1 &
    local new_pid=$!
    echo "$new_pid" > bridge.pid
    sleep 1
    if kill -0 "$new_pid" 2>/dev/null; then
        echo "[+] 服务已在后台成功启动 (PID: $new_pid)"
        echo "[i] 日志输出已重定向至 logs/hub.log"
        echo "[i] 如需关闭服务，执行 ./run.sh stop 或再次运行 ./run.sh 按回车"
    else
        echo "[错误] 启动失败，请检查 logs/hub.log"
    fi
}

stop_service() {
    local target_pid=$1
    if [ -z "$target_pid" ]; then
        target_pid=$(get_pid)
    fi
    if [ -n "$target_pid" ]; then
        echo "[*] 正在停止服务 (PID: $target_pid)..."
        kill "$target_pid" 2>/dev/null
        sleep 1
        kill -9 "$target_pid" 2>/dev/null
        rm -f bridge.pid 2>/dev/null
        echo "[+] 服务已成功停止"
    else
        pkill -f "node bridge.mjs" 2>/dev/null
        rm -f bridge.pid 2>/dev/null
        echo "[+] 服务已停止"
    fi
}

show_logs() {
    local latest
    latest=$(ls -t logs/*.md 2>/dev/null | head -n 1)
    if [ -n "$latest" ]; then
        echo "================ 最近 30 行运行日志 ($latest) ================"
        tail -n 30 "$latest"
        echo "=============================================================="
    elif [ -f "logs/hub.log" ]; then
        echo "================ 最近 30 行后台日志 (logs/hub.log) ================"
        tail -n 30 logs/hub.log
        echo "==================================================================="
    else
        echo "[提示] 暂无日志文件"
    fi
}

# 命令行参数路由
case "$1" in
    start)
        if [ -n "$PID" ]; then
            echo "[提示] Chat Agent Hub 已经在运行中 (PID: $PID)"
            exit 0
        fi
        if [ "$2" = "-d" ] || [ "$2" = "--daemon" ] || [ "$2" = "-s" ]; then
            start_daemon
        else
            start_console
        fi
        ;;
    stop)
        if [ -z "$PID" ]; then
            echo "[提示] Chat Agent Hub 当前未运行"
            exit 0
        fi
        stop_service "$PID"
        ;;
    restart)
        if [ -n "$PID" ]; then
            stop_service "$PID"
            sleep 1
        fi
        if [ "$2" = "-d" ] || [ "$2" = "--daemon" ] || [ "$2" = "-s" ]; then
            start_daemon
        else
            start_console
        fi
        ;;
    status)
        if [ -n "$PID" ]; then
            echo "[状态] Chat Agent Hub 正在运行 (PID: $PID)"
        else
            echo "[状态] Chat Agent Hub 当前未运行"
        fi
        ;;
    logs)
        show_logs
        ;;
    config|setup)
        node core/wizard.mjs
        ;;
    *)
        # 交互模式
        if [ -n "$PID" ]; then
            echo "========================================================"
            echo "  Chat Agent Hub 服务管理"
            echo "========================================================"
            echo "状态: 正在运行 (PID: $PID)"
            echo ""
            echo "[操作选项]"
            echo "  直接按 [回车键]  : 停止服务"
            echo "  输入 r 然后回车  : 重启服务"
            echo "  输入 l 然后回车  : 查看最近运行日志"
            echo "  输入 c 然后回车  : 通道配置向导 (添加/修改飞书、钉钉)"
            echo "  输入 q 然后回车  : 退出 (服务保持后台运行)"
            echo "========================================================"
            read -r -p "请选择操作 [直接回车=停止服务]: " action
            case "$action" in
                r|R)
                    stop_service "$PID"
                    sleep 1
                    start_daemon
                    ;;
                l|L)
                    show_logs
                    ;;
                c|C)
                    node core/wizard.mjs
                    ;;
                q|Q)
                    exit 0
                    ;;
                *)
                    stop_service "$PID"
                    ;;
            esac
        else
            echo "========================================================"
            echo "  Chat Agent Hub 服务管理"
            echo "========================================================"
            echo "状态: 未运行"
            echo ""
            echo "[启动选项]"
            echo "  直接按 [回车键]  : 后台守护模式 (常驻后台，不占终端) [默认]"
            echo "  输入 1 然后回车  : 前台控制台模式 (实时输出日志/扫码)"
            echo "  输入 c 然后回车  : 通道配置向导 (添加/修改飞书、钉钉)"
            echo "  输入 q 然后回车  : 退出"
            echo "========================================================"
            read -r -p "请选择启动方式 [直接回车=后台守护]: " choice
            case "$choice" in
                1)
                    start_console
                    ;;
                c|C)
                    node core/wizard.mjs
                    ;;
                q|Q)
                    exit 0
                    ;;
                *)
                    start_daemon
                    ;;
            esac
        fi
        ;;
esac
