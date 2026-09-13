import { spawn, execSync } from "node:child_process";
import { getConfig } from "./state.mjs";

export const BUILTIN_AGENTS = [
    {
        key: "claude",
        name: "Claude Code",
        aliases: ["cc", "claude"],
        getCmd: () => "claude",
        getArgs: (prompt, session) => {
            const isResume = (session?.turnCount || 0) > 0;
            const sessionFlag = isResume ? "--resume" : "--session-id";
            return ["-p", prompt, sessionFlag, session?.id || "default", "--dangerously-skip-permissions"];
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
export function getAllSupportedAgents() {
    let customList = [];
    try {
        const config = getConfig();
        if (Array.isArray(config?.customAgents)) {
            customList = config.customAgents;
        }
    } catch {}

    const parsedCustom = customList
        .map((c) => {
            const key = (c.key || "").trim().toLowerCase();
            if (!key) return null;
            const name = c.name || key;
            const aliases = Array.isArray(c.aliases) ? c.aliases.map((a) => a.toLowerCase()) : [key];
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
                getArgs: (prompt, session, workDir) => {
                    return argTemplate.map((item) =>
                        String(item)
                            .replace(/\{prompt\}/g, prompt)
                            .replace(/\{workDir\}/g, workDir || "")
                            .replace(/\{sessionId\}/g, session?.id || "default")
                    );
                },
            };
        })
        .filter(Boolean);

    const customKeys = new Set(parsedCustom.map((a) => a.key));
    const filteredBuiltins = BUILTIN_AGENTS.filter((a) => !customKeys.has(a.key));
    return [...filteredBuiltins, ...parsedCustom];
}

let currentRunningProcess = null;
let currentRunningTask = null;
let isTaskCancelled = false;
let recentTaskLogs = [];

export function getRunningTask() {
    return currentRunningTask;
}

export function getRecentTaskLogs() {
    return recentTaskLogs.slice(-30).join("");
}

export function appendTaskLog(chunk) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    recentTaskLogs.push(text);
    if (recentTaskLogs.length > 200) {
        recentTaskLogs = recentTaskLogs.slice(-100);
    }
}

/**
 * 检查命令是否在当前系统 PATH 中可用
 */
export function checkCmdAvailable(cmd) {
    try {
        const tool = process.platform === "win32" ? "where" : "which";
        execSync(`${tool} ${cmd}`, { stdio: "ignore", timeout: 1500 });
        return true;
    } catch {
        return false;
    }
}

/**
 * 探测本机已安装的智能体（支持内置 + 自定义）
 */
export function detectInstalledAgents() {
    const all = getAllSupportedAgents();
    return all.map((agent) => {
        let isInstalled = false;
        try {
            const cmd = agent.getCmd ? agent.getCmd() : agent.key;
            isInstalled = checkCmdAvailable(cmd) || checkCmdAvailable(agent.key);
        } catch {
            isInstalled = false;
        }
        return {
            key: agent.key,
            name: agent.name,
            aliases: agent.aliases || [agent.key],
            installed: isInstalled,
            custom: !!agent.custom,
        };
    });
}

/**
 * 解析当前配置应使用的默认智能体
 */
export function resolveDefaultAgent(cfg) {
    const detected = detectInstalledAgents();
    const targetKey = (cfg?.defaultAgent || "auto").trim().toLowerCase();

    if (targetKey !== "auto") {
        const matched = detected.find((a) => a.key === targetKey || a.aliases.includes(targetKey));
        if (matched) return matched;
    }

    const firstInstalled = detected.find((a) => a.installed);
    if (firstInstalled) return firstInstalled;

    return detected[0] || { key: "claude", name: "Claude Code", installed: false, aliases: ["cc", "claude"] };
}

/**
 * 终止当前正在运行的任务进程树
 */
export function stopCurrentTask() {
    if (!currentRunningProcess || !currentRunningTask) {
        return { success: false, message: "当前没有正在执行的任务。" };
    }

    const targetInfo = `[${currentRunningTask.projectName}] ${currentRunningTask.agentName}`;
    isTaskCancelled = true;

    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(currentRunningProcess.pid), "/f", "/t"]);
        } else {
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
export function executeByAgent(agentKey, prompt, workDir, session = {}) {
    return new Promise((resolve) => {
        const allAgents = getAllSupportedAgents();
        const agent = allAgents.find((a) => a.key === agentKey) || allAgents[0];
        const cmd = agent.getCmd ? agent.getCmd() : agent.key;
        const args = agent.getArgs(prompt, session, workDir);

        console.log(`[*] [${agent.name} 开始执行] 目录: ${workDir}`);
        console.log(`[*] 执行命令: ${cmd} ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`);

        recentTaskLogs = [];
        isTaskCancelled = false;

        const proc = spawn(cmd, args, {
            cwd: workDir,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });

        currentRunningProcess = proc;
        currentRunningTask = {
            agentKey: agent.key,
            agentName: agent.name,
            workDir,
            prompt,
            startTime: Date.now(),
        };

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk) => {
            const str = chunk.toString("utf-8");
            stdout += str;
            appendTaskLog(str);
        });

        proc.stderr.on("data", (chunk) => {
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
