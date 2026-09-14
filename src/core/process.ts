import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROOT_DIR, DATA_DIR, PID_PATH, LOGS_DIR, AUTH_PATH, getConfig } from "./state.js";

/**
 * 通道就绪状态结果
 */
export interface ChannelReadiness {
    hasAnyEnabled: boolean;
    readyForDaemon: boolean;
    reason?: string;
}

/**
 * 检查当前通道配置就绪状态
 */
export function checkChannelsReadiness(): ChannelReadiness {
    const config = getConfig();
    const wechatOn = Boolean(config.channels?.wechat?.enabled);
    const wechatAuthed = fs.existsSync(AUTH_PATH);
    const feishuOn = Boolean(config.channels?.feishu?.enabled && config.channels?.feishu?.appId && config.channels?.feishu?.appSecret);
    const dingtalkOn = Boolean(config.channels?.dingtalk?.enabled && config.channels?.dingtalk?.clientId && config.channels?.dingtalk?.clientSecret);

    if (!wechatOn && !feishuOn && !dingtalkOn) {
        return {
            hasAnyEnabled: false,
            readyForDaemon: false,
            reason: "当前尚未启用任何消息通道 (微信/飞书/钉钉均处于未配置或未启用状态)",
        };
    }

    const hasDaemonReady = feishuOn || dingtalkOn || (wechatOn && wechatAuthed);
    if (!hasDaemonReady) {
        return {
            hasAnyEnabled: true,
            readyForDaemon: false,
            reason: "微信通道尚未扫码登录，后台静默模式无法在终端展示二维码。请先使用前台启动 (cah start) 完成扫码登录",
        };
    }

    return { hasAnyEnabled: true, readyForDaemon: true };
}

/**
 * 确保终端标准输入流处于非 Raw 且已安全暂停的干净状态
 * 避免子进程交互或特定平台终端在返回交互菜单时出现异常
 */
export function ensureTerminalClean(): void {
    if (process.stdin.isTTY) {
        try {
            if (typeof process.stdin.setRawMode === "function" && (process.stdin as any).isRaw) {
                process.stdin.setRawMode(false);
            }
            process.stdin.resume();
        } catch {}
    }
}

/**
 * 检查当前是否有正在运行的 Agent Hub 实例
 * @returns 运行中的 PID 或 null
 */
export function getRunningPid(): number | null {
    try {
        if (fs.existsSync(PID_PATH)) {
            const p = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
            if (p && !isNaN(p)) {
                try {
                    process.kill(p, 0);
                    return p;
                } catch (e: any) {
                    if (e?.code === "EPERM") return p;
                    try { fs.unlinkSync(PID_PATH); } catch {}
                }
            }
        }
    } catch {}
    return null;
}

/**
 * 停止运行中的服务
 * @param pid 目标 PID
 * @returns 是否成功触发停止
 */
export function stopDaemon(pid?: number): boolean {
    const targetPid = pid || getRunningPid();
    if (!targetPid) return false;

    try {
        if (process.platform === "win32") {
            spawnSync("taskkill", ["/F", "/PID", String(targetPid), "/T"], {
                windowsHide: true,
                stdio: "ignore",
            });
        } else {
            try {
                process.kill(targetPid, "SIGTERM");
            } catch {
                spawnSync("kill", ["-9", String(targetPid)], { stdio: "ignore" });
            }
        }
    } catch {}

    if (fs.existsSync(PID_PATH)) {
        try { fs.unlinkSync(PID_PATH); } catch {}
    }
    return true;
}

/**
 * 在系统后台静默启动服务 (跨平台守护进程，无黑窗口常驻)
 */
export function startDaemon(): { success: boolean; pid?: number; logPath?: string; alreadyRunning?: boolean; error?: string } {
    const existing = getRunningPid();
    if (existing) {
        return { success: false, pid: existing, alreadyRunning: true };
    }

    const readiness = checkChannelsReadiness();
    if (!readiness.readyForDaemon) {
        return { success: false, error: readiness.reason };
    }

    if (!fs.existsSync(LOGS_DIR)) {
        try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
    }

    const logPath = path.join(LOGS_DIR, "hub.log");
    const logFd = fs.openSync(logPath, "a");

    const distBridge = path.join(ROOT_DIR, "dist", "bridge.js");
    const srcBridge = path.join(ROOT_DIR, "src", "bridge.ts");

    let execCmd = process.execPath;
    let execArgs: string[] = [];

    if (fs.existsSync(distBridge)) {
        execArgs = [distBridge];
    } else {
        const tsxBin = path.join(ROOT_DIR, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
        if (fs.existsSync(tsxBin)) {
            execCmd = tsxBin;
            execArgs = [srcBridge];
        } else {
            execArgs = [srcBridge];
        }
    }

    const child = spawn(execCmd, execArgs, {
        cwd: DATA_DIR,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
    });

    child.unref();
    try { fs.closeSync(logFd); } catch {}

    if (child.pid) {
        fs.writeFileSync(PID_PATH, String(child.pid), "utf-8");
        return { success: true, pid: child.pid, logPath };
    }

    return { success: false, error: "启动后台守护进程失败" };
}

/**
 * 重启后台服务
 */
export function restartDaemon(): { success: boolean; pid?: number; logPath?: string; alreadyRunning?: boolean; error?: string } {
    const runningPid = getRunningPid();
    if (runningPid) {
        stopDaemon(runningPid);
    }
    return startDaemon();
}
