import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveActiveClaudeSession } from "./session-resolver.js";
import type { Config, Instance, ActiveFocus, PendingQuestion, SourceType } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findPackageRoot(startDir: string): string {
    let cur = startDir;
    while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, "package.json"))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    return path.resolve(startDir, "..");
}

export const ROOT_DIR = findPackageRoot(__dirname);
export const CONFIG_EXAMPLE_PATH = path.join(ROOT_DIR, "config.example.json");

/**
 * 决定数据持久化目录:
 * 1. 显式环境变量 CHAT_AGENT_HUB_HOME 优先级最高
 * 2. 如果在项目源码目录开发调试 (ROOT_DIR 不在 node_modules 中且存在 config.json)，使用本地源码目录保持向下兼容
 * 3. 否则 (作为全局 npm 包安装时)，存放在用户主目录 ~/.chat-agent-hub
 */
function resolveDataDir(): string {
    if (process.env.CHAT_AGENT_HUB_HOME) {
        return path.resolve(process.env.CHAT_AGENT_HUB_HOME);
    }
    const isInsideNodeModules = ROOT_DIR.includes("node_modules");
    const hasLocalConfig = fs.existsSync(path.join(ROOT_DIR, "config.json"));
    if (!isInsideNodeModules && hasLocalConfig) {
        return ROOT_DIR;
    }
    return path.join(os.homedir(), ".chat-agent-hub");
}

export const DATA_DIR = resolveDataDir();
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const AUTH_PATH = path.join(DATA_DIR, "auth.json");
export const SYNC_PATH = path.join(DATA_DIR, "sync.buf");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const INSTANCES_PATH = path.join(DATA_DIR, "instances.json");
export const ACTIVE_FOCUS_PATH = path.join(DATA_DIR, "active-focus.json");
export const PENDING_QUESTIONS_PATH = path.join(DATA_DIR, "pending-questions.json");
export const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
export const PID_PATH = path.join(DATA_DIR, "bridge.pid");
export const LAST_FEISHU_USER_PATH = path.join(DATA_DIR, "last-feishu-user.json");
export const LAST_DINGTALK_USER_PATH = path.join(DATA_DIR, "last-dingtalk-user.json");

// 确保基础目录存在
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}
if (!fs.existsSync(WORKSPACE_DIR)) {
    try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch {}
}
if (!fs.existsSync(LOGS_DIR)) {
    try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
}

/**
 * 读取当前配置 (每次动态读取或更新)
 */
export function getConfig(): Config {
    let conf: Config = {
        machineName: "",
        defaultAgent: "auto",
        sessionIdleMinutes: 15,
        logRetentionDays: 14,
        workDir: WORKSPACE_DIR,
        notifyChannels: ["all"],
        projects: [{ name: "默认工作区", path: WORKSPACE_DIR }],
        channels: {
            wechat: { enabled: false },
            feishu: { enabled: false, appId: "", appSecret: "" },
            dingtalk: { enabled: false, clientId: "", clientSecret: "" },
        },
    };

    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE_PATH)) {
        try { fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH); } catch {}
    }

    if (fs.existsSync(CONFIG_PATH)) {
        try {
            conf = { ...conf, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
        } catch {}
    }

    if (conf.workDir) {
        conf.workDir = path.resolve(DATA_DIR, conf.workDir);
    } else {
        conf.workDir = WORKSPACE_DIR;
    }

    if (Array.isArray(conf.projects)) {
        conf.projects = conf.projects.map((p) => ({
            ...p,
            path: path.resolve(DATA_DIR, p.path),
        }));
    } else {
        conf.projects = [{ name: "默认工作区", path: conf.workDir }];
    }

    return conf;
}

export function saveConfig(conf: Config): boolean {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2), "utf-8");
        return true;
    } catch (e: any) {
        console.error("[-] 保存配置失败:", e?.message);
        return false;
    }
}

/**
 * 任务与实例管理
 */
export function getInstances(): Instance[] {
    if (fs.existsSync(INSTANCES_PATH)) {
        try {
            const list = JSON.parse(fs.readFileSync(INSTANCES_PATH, "utf-8"));
            if (Array.isArray(list)) return list;
        } catch {}
    }
    return [];
}

export function saveInstances(instances: Instance[]): boolean {
    try {
        fs.writeFileSync(INSTANCES_PATH, JSON.stringify(instances, null, 2), "utf-8");
        return true;
    } catch (e: any) {
        console.error("[-] 保存实例失败:", e?.message);
        return false;
    }
}

export function getActiveInstance(autoCreate: false): Instance | null;
export function getActiveInstance(autoCreate?: true): Instance;
export function getActiveInstance(autoCreate?: boolean): Instance | null;
export function getActiveInstance(autoCreate: boolean = true): Instance | null {
    const instances = getInstances();
    if (instances.length === 0) {
        if (!autoCreate) return null;
        const conf = getConfig();
        const defAgentKey = conf.defaultAgent === "auto" ? "claude" : conf.defaultAgent;
        const defAgentName = conf.defaultAgent === "auto" ? "Claude Code" : conf.defaultAgent;
        const defInst: Instance = {
            id: "default-task",
            num: 1,
            agentKey: defAgentKey,
            agentName: defAgentName,
            projectName: "默认工作区",
            workDir: conf.workDir,
            source: "bridge",
            sourceLabel: "[本地]",
            sessionId: crypto.randomUUID(),
            turnCount: 0,
            active: true,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        };
        saveInstances([defInst]);
        saveActiveFocus(defInst);
        return defInst;
    }

    let active = instances.find((i) => i.active);
    if (!active && fs.existsSync(ACTIVE_FOCUS_PATH)) {
        try {
            const focusData = JSON.parse(fs.readFileSync(ACTIVE_FOCUS_PATH, "utf-8"));
            active = instances.find((i) => i.id === focusData.instanceId || i.num === focusData.num);
        } catch {}
    }

    if (!active) {
        active = instances[0];
        active.active = true;
        saveInstances(instances);
    }
    saveActiveFocus(active);
    return active;
}

export function saveActiveFocus(inst: Instance | null): void {
    if (!inst) {
        try {
            if (fs.existsSync(ACTIVE_FOCUS_PATH)) fs.unlinkSync(ACTIVE_FOCUS_PATH);
        } catch {}
        return;
    }
    try {
        const focus: ActiveFocus = {
            instanceId: inst.id,
            num: inst.num,
            agentKey: inst.agentKey,
            agentName: inst.agentName,
            projectName: inst.projectName,
            workDir: inst.workDir,
            source: inst.source || "bridge",
            updatedAt: Date.now(),
        };
        fs.writeFileSync(ACTIVE_FOCUS_PATH, JSON.stringify(focus, null, 2), "utf-8");
    } catch {}
}

export function setActiveInstance(inst: Partial<Instance> & { id?: string; num?: number }): Instance {
    const instances = getInstances();
    let found = false;
    let targetInst: Instance | null = null;

    for (const i of instances) {
        if (i.id === inst.id || i.num === inst.num) {
            i.active = true;
            i.agentKey = inst.agentKey || i.agentKey;
            i.agentName = inst.agentName || i.agentName;
            i.projectName = inst.projectName || i.projectName;
            i.workDir = inst.workDir || i.workDir;
            i.turnCount = inst.turnCount ?? i.turnCount;
            i.lastActiveAt = Date.now();
            found = true;
            targetInst = i;
        } else {
            i.active = false;
        }
    }

    if (!found || !targetInst) {
        const newInst: Instance = {
            id: inst.id || `task-${Date.now()}`,
            num: inst.num || (instances.length > 0 ? Math.max(...instances.map((i) => i.num || 0)) + 1 : 1),
            agentKey: inst.agentKey || "claude",
            agentName: inst.agentName || "Claude Code",
            projectName: inst.projectName || "工作区",
            workDir: inst.workDir || WORKSPACE_DIR,
            source: inst.source || "bridge",
            sourceLabel: inst.sourceLabel || "[本地]",
            sessionId: inst.sessionId || crypto.randomUUID(),
            turnCount: inst.turnCount || 0,
            active: true,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        };
        instances.push(newInst);
        targetInst = newInst;
    }

    saveInstances(instances);
    saveActiveFocus(targetInst);
    return targetInst;
}

/**
 * 仅更新指定任务实例的元数据（不改变用户的全局活动焦点），避免抢焦点竞态
 */
export function updateInstance(idOrNum: string | number, updates: Partial<Instance>): Instance | null {
    const instances = getInstances();
    const inst = instances.find((i) => i.id === idOrNum || i.num === idOrNum);
    if (!inst) return null;

    Object.assign(inst, updates);
    saveInstances(instances);

    // 若该实例恰好是当前活动焦点，则同步更新焦点元数据
    if (inst.active) {
        saveActiveFocus(inst);
    }
    return inst;
}

export function registerOrUpdateInstance(
    agentKey: string,
    agentName: string,
    workDir?: string,
    customProjectName?: string,
    source: SourceType = "desktop"
): Instance {
    const instances = getInstances();
    const resolvedDir = path.resolve(workDir || process.cwd());
    const projName = customProjectName || path.basename(resolvedDir) || "项目";
    const instanceId = `${agentKey}-${resolvedDir}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

    let inst = instances.find(
        (i) => i.id === instanceId || (i.agentKey === agentKey && path.resolve(i.workDir) === resolvedDir)
    );

    const activeClaudeSession = agentKey === "claude" ? resolveActiveClaudeSession(resolvedDir) : null;

    if (!inst) {
        // 检查是否存在未被实际执行过的默认占位任务 (default-task 且 turnCount === 0)
        const defaultPlaceholderIdx = instances.findIndex(
            (i) => (i.id === "default-task" || i.projectName === "默认工作区") && (i.turnCount === 0)
        );

        const initialSessionId = activeClaudeSession || crypto.randomUUID();

        if (defaultPlaceholderIdx !== -1 && instances.length === 1) {
            // 单独占位时直接顶替为项目 1
            inst = {
                id: instanceId,
                num: 1,
                agentKey,
                agentName,
                projectName: projName,
                workDir: resolvedDir,
                source,
                sourceLabel: source === "desktop" ? "[本地]" : "[远程]",
                sessionId: initialSessionId,
                turnCount: 0,
                active: true,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
            };
            instances[0] = inst;
        } else {
            if (defaultPlaceholderIdx !== -1) {
                instances.splice(defaultPlaceholderIdx, 1);
            }
            const nextNum = instances.length > 0 ? Math.max(...instances.map((i) => i.num || 0)) + 1 : 1;
            inst = {
                id: instanceId,
                num: nextNum,
                agentKey,
                agentName,
                projectName: projName,
                workDir: resolvedDir,
                source,
                sourceLabel: source === "desktop" ? "[本地]" : "[远程]",
                sessionId: initialSessionId,
                turnCount: 0,
                active: true,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
            };
            instances.push(inst);
        }
    } else {
        inst.agentName = agentName;
        inst.projectName = projName;
        inst.source = source;
        inst.sourceLabel = source === "desktop" ? "[本地]" : "[远程]";
        if (activeClaudeSession) {
            inst.sessionId = activeClaudeSession;
        }
        inst.lastActiveAt = Date.now();
    }

    setActiveInstance(inst);
    return inst;
}

/**
 * 人机审批决策题库管理
 */
export function getPendingQuestions(): PendingQuestion[] {
    if (fs.existsSync(PENDING_QUESTIONS_PATH)) {
        try {
            const list = JSON.parse(fs.readFileSync(PENDING_QUESTIONS_PATH, "utf-8"));
            if (Array.isArray(list)) {
                return list.filter((q: PendingQuestion) => Date.now() - q.createdAt < (q.timeoutMs || 300000));
            }
        } catch {}
    }
    return [];
}

export function savePendingQuestions(questions: PendingQuestion[]): boolean {
    try {
        fs.writeFileSync(PENDING_QUESTIONS_PATH, JSON.stringify(questions, null, 2), "utf-8");
        return true;
    } catch (e: any) {
        console.error("[-] 保存待确认问题失败:", e?.message);
        return false;
    }
}

export function allocateReqId(): number {
    const questions = getPendingQuestions();
    const used = new Set(questions.map((q) => q.reqId));
    let reqId = 101;
    while (used.has(reqId)) {
        reqId = reqId >= 999 ? 101 : reqId + 1;
    }
    return reqId;
}

/**
 * 历史执行记录持久化
 */
export function appendHistoryLog(user: string, prompt: string, output: string, workDir: string, turnCount: number = 1): void {
    try {
        if (!fs.existsSync(LOGS_DIR)) {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
        }
        const now = new Date();
        const dateStr = now.toLocaleDateString("zh-CN").replace(/\//g, "-");
        const timeStr = now.toLocaleTimeString("zh-CN");
        const logFile = path.join(LOGS_DIR, `${dateStr}.md`);

        const entry = [
            `### [${timeStr}] 指令交互 (轮次: ${turnCount})`,
            `- **用户**: \`${user}\``,
            `- **工作目录**: \`${workDir}\``,
            `- **输入内容**:`,
            "```text",
            prompt,
            "```",
            `- **输出结果**:`,
            "```text",
            output,
            "```",
            "---",
            "",
        ].join("\n");

        fs.appendFileSync(logFile, entry + "\n", "utf-8");
    } catch (err: any) {
        console.error("[-] 写入日志失败:", err?.message);
    }
}

/**
 * 自动清理过期历史日志 (默认保留 14 天)
 */
export function cleanOldLogs(retentionDays: number = 14): void {
    try {
        if (!fs.existsSync(LOGS_DIR)) return;
        const now = Date.now();
        const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(LOGS_DIR);

        for (const file of files) {
            if (!file.endsWith(".md") && !file.endsWith(".log")) continue;
            const fullPath = path.join(LOGS_DIR, file);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(fullPath);
                    console.log(`[*] [日志维护] 已自动清理超期历史日志: ${file}`);
                }
            } catch {}
        }
    } catch (err: any) {
        console.error("[-] 清理历史日志失败:", err?.message);
    }
}
