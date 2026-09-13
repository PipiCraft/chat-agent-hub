import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

export const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
export const CONFIG_EXAMPLE_PATH = path.join(ROOT_DIR, "config.example.json");
export const AUTH_PATH = path.join(ROOT_DIR, "auth.json");
export const SYNC_PATH = path.join(ROOT_DIR, "sync.buf");
export const LOGS_DIR = path.join(ROOT_DIR, "logs");
export const INSTANCES_PATH = path.join(ROOT_DIR, "instances.json");
export const ACTIVE_FOCUS_PATH = path.join(ROOT_DIR, "active-focus.json");
export const PENDING_QUESTIONS_PATH = path.join(ROOT_DIR, "pending-questions.json");
export const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");
export const PID_PATH = path.join(ROOT_DIR, "bridge.pid");

// 确保基础目录存在
if (!fs.existsSync(WORKSPACE_DIR)) {
    try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch {}
}
if (!fs.existsSync(LOGS_DIR)) {
    try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
}

/**
 * 读取当前配置 (每次动态读取或更新)
 */
export function getConfig() {
    let conf = {
        machineName: "",
        defaultAgent: "auto",
        sessionIdleMinutes: 15,
        logRetentionDays: 14,
        workDir: WORKSPACE_DIR,
        notifyChannels: ["all"],
        projects: [{ name: "默认工作区", path: WORKSPACE_DIR }],
        channels: {
            wechat: { enabled: true },
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
        conf.workDir = path.resolve(ROOT_DIR, conf.workDir);
    } else {
        conf.workDir = WORKSPACE_DIR;
    }

    if (Array.isArray(conf.projects)) {
        conf.projects = conf.projects.map((p) => ({
            ...p,
            path: path.resolve(ROOT_DIR, p.path),
        }));
    } else {
        conf.projects = [{ name: "默认工作区", path: conf.workDir }];
    }

    return conf;
}

export function saveConfig(conf) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2), "utf-8");
        return true;
    } catch (e) {
        console.error("[-] 保存配置失败:", e.message);
        return false;
    }
}

/**
 * 任务与实例管理
 */
export function getInstances() {
    if (fs.existsSync(INSTANCES_PATH)) {
        try {
            const list = JSON.parse(fs.readFileSync(INSTANCES_PATH, "utf-8"));
            if (Array.isArray(list)) return list;
        } catch {}
    }
    return [];
}

export function saveInstances(instances) {
    try {
        fs.writeFileSync(INSTANCES_PATH, JSON.stringify(instances, null, 2), "utf-8");
        return true;
    } catch (e) {
        console.error("[-] 保存实例失败:", e.message);
        return false;
    }
}

export function getActiveInstance(autoCreate = true) {
    const instances = getInstances();
    if (instances.length === 0) {
        if (!autoCreate) return null;
        const conf = getConfig();
        const defAgentKey = conf.defaultAgent === "auto" ? "claude" : conf.defaultAgent;
        const defAgentName = conf.defaultAgent === "auto" ? "Claude Code" : conf.defaultAgent;
        const defInst = {
            id: "default-task",
            num: 1,
            agentKey: defAgentKey,
            agentName: defAgentName,
            projectName: "默认工作区",
            workDir: conf.workDir,
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

    // 优先读取标记为 active 的任务，或 active-focus.json 记录的任务
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

export function saveActiveFocus(inst) {
    if (!inst) {
        try {
            if (fs.existsSync(ACTIVE_FOCUS_PATH)) fs.unlinkSync(ACTIVE_FOCUS_PATH);
        } catch {}
        return;
    }
    try {
        const focus = {
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

export function setActiveInstance(inst) {
    const instances = getInstances();
    let found = false;
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
        } else {
            i.active = false;
        }
    }
    if (!found) {
        inst.active = true;
        inst.lastActiveAt = Date.now();
        instances.push(inst);
    }
    saveInstances(instances);
    saveActiveFocus(inst);
    return inst;
}

/**
 * 统一注册或更新实例（MCP、CLI、Bridge 通用）
 */
export function registerOrUpdateInstance(agentKey, agentName, workDir, customProjectName, source = "desktop") {
    const instances = getInstances();
    const resolvedDir = path.resolve(workDir || process.cwd());
    const projName = customProjectName || path.basename(resolvedDir) || "项目";
    const instanceId = `${agentKey}-${resolvedDir}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

    let inst = instances.find(
        (i) => i.id === instanceId || (i.agentKey === agentKey && path.resolve(i.workDir) === resolvedDir)
    );

    if (!inst) {
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
            sessionId: crypto.randomUUID(),
            turnCount: 0,
            active: true,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        };
        instances.push(inst);
    } else {
        inst.agentName = agentName;
        inst.projectName = projName;
        inst.source = source;
        inst.sourceLabel = source === "desktop" ? "[本地]" : "[远程]";
        inst.lastActiveAt = Date.now();
    }

    setActiveInstance(inst);
    return inst;
}

/**
 * 人机审批决策题库管理
 */
export function getPendingQuestions() {
    if (fs.existsSync(PENDING_QUESTIONS_PATH)) {
        try {
            const list = JSON.parse(fs.readFileSync(PENDING_QUESTIONS_PATH, "utf-8"));
            if (Array.isArray(list)) {
                return list.filter((q) => Date.now() - q.createdAt < (q.timeoutMs || 300000));
            }
        } catch {}
    }
    return [];
}

export function savePendingQuestions(questions) {
    try {
        fs.writeFileSync(PENDING_QUESTIONS_PATH, JSON.stringify(questions, null, 2), "utf-8");
        return true;
    } catch (e) {
        console.error("[-] 保存待确认问题失败:", e.message);
        return false;
    }
}

export function allocateReqId() {
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
export function appendHistoryLog(user, prompt, output, workDir, turnCount = 1) {
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
    } catch (err) {
        console.error("[-] 写入日志失败:", err.message);
    }
}

/**
 * 自动清理过期历史日志 (默认保留 14 天)
 */
export function cleanOldLogs(retentionDays = 14) {
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
    } catch (err) {
        console.error("[-] 清理历史日志失败:", err.message);
    }
}

