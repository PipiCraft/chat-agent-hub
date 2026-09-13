import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { ROOT_DIR, DATA_DIR, PID_PATH, LOGS_DIR } from "./state.js";

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
            execSync(`taskkill /F /PID ${targetPid} /T >nul 2>&1`);
        } else {
            try {
                process.kill(targetPid, "SIGTERM");
            } catch {
                execSync(`kill -9 ${targetPid} 2>/dev/null`);
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
