import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { getConfig } from "./state.js";
import type { Config, InstalledAgentInfo } from "../types/index.js";

export interface AgentDefinition {
    key: string;
    name: string;
    aliases: string[];
    custom?: boolean;
    getCmd?: () => string;
    getArgs: (prompt: string, session?: any, workDir?: string) => string[];
}

export interface RunningTaskInfo {
    agentKey: string;
    agentName: string;
    projectName?: string;
    workDir: string;
    prompt: string;
    startTime: number;
}

export { resolveActiveClaudeSession } from "./session-resolver.js";


function checkClaudeSessionExists(sessionId?: string): boolean {
    if (!sessionId) return false;
    try {
        const homedir = os.homedir();
        const projectsDir = path.join(homedir, ".claude", "projects");
        if (!fs.existsSync(projectsDir)) return false;
        const entries = fs.readdirSync(projectsDir);
        for (const entry of entries) {
            const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate)) return true;
        }
    } catch {}
    return false;
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
    {
        key: "claude",
        name: "Claude Code",
        aliases: ["cc", "claude"],
        getCmd: () => (process.platform === "win32" ? "claude.exe" : "claude"),
        getArgs: (prompt, session) => {
            const args = ["-p", prompt];
            const hasSession = Boolean(session?.id && session.id !== "default");
            if (hasSession) {
                const sessionExists = checkClaudeSessionExists(session.id);
                if (sessionExists || (session?.turnCount || 0) > 0) {
                    args.push("--resume", session.id);
                } else {
                    args.push("--session-id", session.id);
                }
            } else {
                args.push("--continue");
            }
            args.push("--dangerously-skip-permissions");
            return args;
        },
    },
    {
        key: "opencode",
        name: "OpenCode",
        aliases: ["oc", "opencode"],
        getCmd: () => (process.platform === "win32" ? "opencode.cmd" : "opencode"),
        getArgs: (prompt) => ["run", prompt, "--auto"],
    },
    {
        key: "hermes",
        name: "Hermes",
        aliases: ["hermes"],
        getCmd: () => "hermes",
        getArgs: (prompt) => ["-z", prompt, "--yolo"],
    },
    {
        key: "codex",
        name: "Codex",
        aliases: [],
        getCmd: () => (process.platform === "win32" ? "codex.cmd" : "codex"),
        getArgs: (prompt) => ["exec", prompt, "--dangerously-bypass-confirmation-prompts"],
    },
    {
        key: "pi",
        name: "Pi",
        aliases: [],
        getCmd: () => (process.platform === "win32" ? "pi.cmd" : "pi"),
        getArgs: (prompt) => ["-p", prompt],
    },
    {
        key: "openclaw",
        name: "OpenClaw",
        aliases: [],
        getCmd: () => (process.platform === "win32" ? "openclaw.cmd" : "openclaw"),
        getArgs: (prompt) => ["run", prompt, "--auto"],
    },
];

/**
 * 获取所有支持的智能体（内置智能体 + config.json 自定义智能体，同 key 自定义优先覆盖）
 */
export function getAllSupportedAgents(): AgentDefinition[] {
    let customList: any[] = [];
    try {
        const config: any = getConfig();
        if (Array.isArray(config?.customAgents)) {
            customList = config.customAgents;
        }
    } catch {}

    const parsedCustom = (customList
        .map((c) => {
            const key = (c.key || "").trim().toLowerCase();
            if (!key) return null;
            const name = c.name || key;
            const aliases = Array.isArray(c.aliases) ? c.aliases.map((a: string) => a.toLowerCase()) : [key];
            const rawCmd = c.cmd || key;
            const argTemplate = Array.isArray(c.args) ? c.args : ["{prompt}"];

            return {
                key,
                name,
                aliases,
                custom: true,
                getCmd: () => {
                    if (process.platform === "win32" && !rawCmd.includes("/") && !rawCmd.includes("\\") && !rawCmd.endsWith(".exe") && !rawCmd.endsWith(".cmd") && !rawCmd.endsWith(".bat")) {
                        return `${rawCmd}.cmd`;
                    }
                    return rawCmd;
                },
                getArgs: (prompt: string, session?: any, workDir?: string) => {
                    return argTemplate.map((item: string) =>
                        String(item)
                            .replace(/\{prompt\}/g, prompt)
                            .replace(/\{workDir\}/g, workDir || "")
                            .replace(/\{sessionId\}/g, session?.id || "default")
                    );
                },
            };
        }) as (AgentDefinition | null)[])
        .filter((item): item is AgentDefinition => item !== null);

    const customKeys = new Set(parsedCustom.map((a) => a.key));
    const filteredBuiltins = BUILTIN_AGENTS.filter((a) => !customKeys.has(a.key));
    return [...filteredBuiltins, ...parsedCustom];
}

let currentRunningProcess: ChildProcess | null = null;
let currentRunningTask: RunningTaskInfo | null = null;
let isTaskCancelled = false;
let recentTaskLogs: string[] = [];

export function getRunningTask(): RunningTaskInfo | null {
    return currentRunningTask;
}

export function getRecentTaskLogs(): string {
    return recentTaskLogs.slice(-30).join("");
}

export function appendTaskLog(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    recentTaskLogs.push(text);
    if (recentTaskLogs.length > 200) {
        recentTaskLogs = recentTaskLogs.slice(-100);
    }
}

/**
 * 检查命令是否在当前系统 PATH 中可用 (纯 Node.js 内存与文件系统检索，零子进程与黑窗口)
 */
export function checkCmdAvailable(cmd: string): boolean {
    if (!cmd || typeof cmd !== "string") return false;
    const trimmed = cmd.trim();
    if (!trimmed) return false;

    // 若直接包含路径分隔符，直接检查具体文件
    if (trimmed.includes("/") || trimmed.includes("\\")) {
        try {
            return fs.existsSync(path.resolve(trimmed));
        } catch {
            return false;
        }
    }

    const pathEnv = process.env.PATH || process.env.Path || "";
    const pathDirs = pathEnv
        .split(path.delimiter)
        .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);

    if (process.platform === "win32") {
        const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS")
            .split(";")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
        const hasExt = path.extname(trimmed).length > 0;

        for (const dir of pathDirs) {
            try {
                if (hasExt) {
                    const candidate = path.join(dir, trimmed);
                    if (fs.existsSync(candidate)) {
                        return true;
                    }
                } else {
                    for (const ext of pathext) {
                        const candidate = path.join(dir, trimmed + ext);
                        if (fs.existsSync(candidate)) {
                            return true;
                        }
                    }
                }
            } catch {}
        }
    } else {
        for (const dir of pathDirs) {
            try {
                const fullPath = path.join(dir, trimmed);
                if (fs.existsSync(fullPath)) {
                    fs.accessSync(fullPath, fs.constants.X_OK);
                    return true;
                }
            } catch {}
        }
    }

    return false;
}

function hasHubMcp(mcpServers: any): boolean {
    if (!mcpServers || typeof mcpServers !== "object") return false;
    return Object.entries(mcpServers).some(([key, srv]: [string, any]) => {
        const k = key.toLowerCase();
        if (k.includes("chat-agent-hub") || k === "cah") return true;
        if (!srv || typeof srv !== "object") return false;
        const cmd = String(srv.command || "").toLowerCase();
        const args: string[] = Array.isArray(srv.args) ? srv.args.map((a: any) => String(a).toLowerCase()) : [];
        if (cmd.includes("cah") || cmd.includes("chat-agent-hub")) return true;
        if (args.some((a: string) => a.includes("chat-agent-hub") || a.includes("mcp-server") || a === "cah")) return true;
        return false;
    });
}

/**
 * 探测指定智能体是否已在系统中接入 Chat Agent Hub MCP 服务
 */
export function checkAgentMcpStatus(agentKey: string, workDir: string = process.cwd()): {
    configured: boolean;
    details: string;
    hint?: string;
} {
    const key = agentKey.toLowerCase();
    const homedir = os.homedir();

    // 1. Claude Code
    if (key.includes("claude")) {
        const claudeJson = path.join(homedir, ".claude.json");
        if (fs.existsSync(claudeJson)) {
            try {
                const data = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
                if (data.mcpServers && hasHubMcp(data.mcpServers)) {
                    return { configured: true, details: "MCP已连 (全局配置)" };
                }
                if (data.projects && typeof data.projects === "object") {
                    for (const projPath of Object.keys(data.projects)) {
                        const pConf = data.projects[projPath];
                        if (pConf?.mcpServers && hasHubMcp(pConf.mcpServers)) {
                            return { configured: true, details: "MCP已连 (项目配置)" };
                        }
                    }
                }
            } catch {}
        }

        // 当前工作目录 .mcp.json 检测
        const localMcp = path.join(workDir, ".mcp.json");
        if (fs.existsSync(localMcp)) {
            try {
                const mcpData = JSON.parse(fs.readFileSync(localMcp, "utf-8"));
                if (mcpData.mcpServers && hasHubMcp(mcpData.mcpServers)) {
                    return { configured: true, details: "MCP已连 (.mcp.json)" };
                }
            } catch {}
        }

        // 检查 Claude Desktop 配置文件
        const claudeDesktopPaths = [
            process.env.APPDATA ? path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json") : null,
            path.join(homedir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
            path.join(homedir, ".config", "Claude", "claude_desktop_config.json"),
        ].filter(Boolean) as string[];

        for (const cdp of claudeDesktopPaths) {
            if (fs.existsSync(cdp)) {
                try {
                    const cdpData = JSON.parse(fs.readFileSync(cdp, "utf-8"));
                    if (cdpData.mcpServers && hasHubMcp(cdpData.mcpServers)) {
                        return { configured: true, details: "MCP已连 (Desktop)" };
                    }
                } catch {}
            }
        }

        return {
            configured: false,
            details: "MCP未配置",
            hint: "运行: claude mcp add -s user chat-agent-hub cah mcp",
        };
    }

    // 2. Cursor
    if (key.includes("cursor")) {
        const cursorMcp = path.join(homedir, ".cursor", "mcp.json");
        if (fs.existsSync(cursorMcp)) {
            try {
                const data = JSON.parse(fs.readFileSync(cursorMcp, "utf-8"));
                if (data.mcpServers && hasHubMcp(data.mcpServers)) {
                    return { configured: true, details: "MCP已连 (Cursor)" };
                }
            } catch {}
        }
    }

    // 3. 通用工作目录 .mcp.json 检测
    const genericMcp = path.join(workDir, ".mcp.json");
    if (fs.existsSync(genericMcp)) {
        try {
            const data = JSON.parse(fs.readFileSync(genericMcp, "utf-8"));
            if (data.mcpServers && hasHubMcp(data.mcpServers)) {
                return { configured: true, details: "MCP已连 (.mcp.json)" };
            }
        } catch {}
    }

    return {
        configured: false,
        details: "MCP未配置",
        hint: "添加 MCP: command=cah, args=[\"mcp\"]",
    };
}

/**
 * 探测本机已安装的智能体（支持内置 + 自定义），并附带 MCP 配置健康状态
 */
export function detectInstalledAgents(workDir: string = process.cwd()): InstalledAgentInfo[] {
    const all = getAllSupportedAgents();
    return all.map((agent) => {
        let isInstalled = false;
        try {
            const cmd = agent.getCmd ? agent.getCmd() : agent.key;
            isInstalled = checkCmdAvailable(cmd) || checkCmdAvailable(agent.key);
        } catch {
            isInstalled = false;
        }
        const mcpStatus = checkAgentMcpStatus(agent.key, workDir);
        return {
            key: agent.key,
            name: agent.name,
            aliases: agent.aliases || [agent.key],
            installed: isInstalled,
            custom: !!agent.custom,
            mcpConfigured: mcpStatus.configured,
            mcpDetails: mcpStatus.details,
            mcpHint: mcpStatus.hint,
        };
    });
}

/**
 * 解析当前配置应使用的默认智能体
 */
export function resolveDefaultAgent(cfg?: Config, preDetected?: InstalledAgentInfo[]): InstalledAgentInfo {
    const detected = preDetected || detectInstalledAgents();
    const targetKey = (cfg?.defaultAgent || "auto").trim().toLowerCase();

    if (targetKey !== "auto") {
        const matched = detected.find((a) => a.key === targetKey || (a as any).aliases?.includes(targetKey));
        if (matched) return matched;
    }

    const firstInstalled = detected.find((a) => a.installed);
    if (firstInstalled) return firstInstalled;

    return detected[0] || { key: "claude", name: "Claude Code", installed: false };
}

/**
 * 统一解析智能体 Key（大小写不敏感，支持名称、别名与自定义智能体）
 */
export function resolveAgentKey(nameOrKey?: string): string {
    if (!nameOrKey) return "claude";
    const clean = nameOrKey.trim().toLowerCase();
    const all = getAllSupportedAgents();

    const matched = all.find(
        (a) => a.key === clean || a.name.toLowerCase() === clean || (a.aliases && a.aliases.map((al) => al.toLowerCase()).includes(clean))
    );
    if (matched) return matched.key;

    if (clean.includes("opencode")) return "opencode";
    if (clean.includes("hermes")) return "hermes";
    if (clean.includes("codex")) return "codex";
    if (clean.includes("openclaw")) return "openclaw";
    if (clean.includes("pi")) return "pi";

    return "claude";
}

/**
 * 同步预占并锁定当前任务执行位（消除异步网络 I/O 竞态时间窗口）
 */
export function acquireTaskLock(info: RunningTaskInfo): boolean {
    if (currentRunningTask) {
        return false;
    }
    currentRunningTask = info;
    isTaskCancelled = false;
    return true;
}

/**
 * 释放任务执行锁（若未真正启动子进程前发生异常时回退）
 */
export function releaseTaskLock(): void {
    if (currentRunningTask && !currentRunningProcess) {
        currentRunningTask = null;
    }
}

/**
 * 终止当前正在运行的任务进程树
 */
export function stopCurrentTask(): { success: boolean; message: string } {
    if (!currentRunningProcess || !currentRunningTask) {
        return { success: false, message: "当前没有正在执行的任务。" };
    }

    const targetInfo = `[${currentRunningTask.projectName || "任务"}] ${currentRunningTask.agentName}`;
    isTaskCancelled = true;

    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(currentRunningProcess.pid), "/f", "/t"], {
                windowsHide: true,
                stdio: "ignore",
            });
        } else if (currentRunningProcess.pid) {
            process.kill(-currentRunningProcess.pid, "SIGKILL");
        }
    } catch (e) {
        try { currentRunningProcess.kill("SIGKILL"); } catch {}
    }

    currentRunningProcess = null;
    return { success: true, message: `已成功强制终止任务: ${targetInfo}` };
}

/**
 * 执行指定智能体任务
 */
export function executeByAgent(agentKey: string, prompt: string, workDir: string, session: any = {}): Promise<string> {
    return new Promise((resolve) => {
        const allAgents = getAllSupportedAgents();
        const agent = allAgents.find((a) => a.key === agentKey) || allAgents[0];
        const cmd = agent.getCmd ? agent.getCmd() : agent.key;
        const args = agent.getArgs(prompt, session, workDir);

        console.log(`[*] [${agent.name} 开始执行] 目录: ${workDir}`);
        console.log(`[*] 执行命令: ${cmd} ${args.map((a: string) => a.includes(" ") ? `"${a}"` : a).join(" ")}`);

        recentTaskLogs = [];
        isTaskCancelled = false;

        const isBatch = cmd.toLowerCase().endsWith(".cmd") || cmd.toLowerCase().endsWith(".bat");
        const proc = spawn(cmd, args, {
            cwd: workDir,
            shell: isBatch,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
            windowsHide: true,
        });

        // 立即关闭标准输入，避免 CLI 智能体等待 stdin 出现延迟
        try { proc.stdin?.end(); } catch {}

        currentRunningProcess = proc;
        if (!currentRunningTask) {
            currentRunningTask = {
                agentKey: agent.key,
                agentName: agent.name,
                workDir,
                prompt,
                startTime: Date.now(),
            };
        } else {
            currentRunningTask.agentKey = agent.key;
            currentRunningTask.agentName = agent.name;
            currentRunningTask.workDir = workDir;
            currentRunningTask.prompt = prompt;
        }

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (chunk) => {
            const str = chunk.toString("utf-8");
            stdout += str;
            appendTaskLog(str);
        });

        proc.stderr?.on("data", (chunk) => {
            const str = chunk.toString("utf-8");
            stderr += str;
            appendTaskLog(str);
        });

        proc.on("close", (code) => {
            console.log(`[*] [${agent.name} 执行结束] 退出码: ${code}`);
            currentRunningProcess = null;
            currentRunningTask = null;

            if (isTaskCancelled) {
                resolve("任务已被用户手动终止。");
                return;
            }

            // 特殊容错自愈：如果 Claude 遇到 Session 冲突，自动转为 --resume 重试
            if (agent.key === "claude" && stderr.includes("is already in use") && session?.id) {
                console.log(`[*] 检测到 Claude 会话 ID 已存在，自动转为 --resume 重新执行...`);
                try {
                    const fallbackArgs = ["-p", prompt, "--resume", session.id, "--dangerously-skip-permissions"];
                    const retryProc = spawn(cmd, fallbackArgs, {
                        cwd: workDir,
                        shell: isBatch,
                        stdio: ["pipe", "pipe", "pipe"],
                        env: process.env,
                        windowsHide: true,
                    });
                    try { retryProc.stdin?.end(); } catch {}
                    let retryOut = "";
                    let retryErr = "";
                    retryProc.stdout?.on("data", (chunk) => { retryOut += chunk.toString("utf-8"); appendTaskLog(chunk); });
                    retryProc.stderr?.on("data", (chunk) => { retryErr += chunk.toString("utf-8"); appendTaskLog(chunk); });
                    retryProc.on("close", (rCode) => {
                        console.log(`[*] [Claude Code 自愈执行结束] 退出码: ${rCode}`);
                        const finalOut = retryOut.trim() || retryErr.trim() || "执行完毕，控制台无输出。";
                        resolve(finalOut);
                    });
                    return;
                } catch {}
            }

            const raw = stdout.trim() || stderr.trim() || "执行完毕，控制台无输出。";
            resolve(raw);
        });

        proc.on("error", (err) => {
            currentRunningProcess = null;
            currentRunningTask = null;
            console.error(`[-] 唤起 ${agent.name} 失败:`, err.message);
            resolve(`执行失败: ${err.message}`);
        });
    });
}
