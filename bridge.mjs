import fs from "node:fs";
import os from "node:os";

import {
    AUTH_PATH,
    SYNC_PATH,
    LOGS_DIR,
    PID_PATH,
    getConfig,
    saveConfig,
    getInstances,
    saveInstances,
    getActiveInstance,
    setActiveInstance,
    saveActiveFocus,
    getPendingQuestions,
    savePendingQuestions,
    cleanOldLogs,
} from "./core/state.mjs";
import {
    detectInstalledAgents,
    resolveDefaultAgent,
    getRunningTask,
} from "./core/runner.mjs";
import { handleCommand } from "./core/commands.mjs";
import { shouldNotifyChannel } from "./channels/common.mjs";

import { startWechatChannel, sendWechatReply } from "./channels/wechat.mjs";
import {
    initFeishuChannel,
    sendFeishuReply,
    sendFeishuApprovalCard,
    sendFeishuTaskListCard,
    sendFeishuAgentListCard,
    sendFeishuOnlineNotice,
} from "./channels/feishu.mjs";
import {
    initDingtalkChannel,
    sendDingtalkReply,
    sendDingtalkApprovalCard,
} from "./channels/dingtalk.mjs";

// PID 管理与进程安全退出
try {
    fs.writeFileSync(PID_PATH, String(process.pid), "utf-8");
} catch {}

function cleanupPid() {
    try {
        if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
    } catch {}
}
process.on("exit", cleanupPid);
process.on("SIGINT", () => { cleanupPid(); process.exit(0); });
process.on("SIGTERM", () => { cleanupPid(); process.exit(0); });

let currentWechatAuth = null;

/**
 * 统一多通道消息回复路由
 */
async function sendChannelReply(replyTarget, text) {
    if (!replyTarget) return;
    const { channel, userId, replyContext, contextToken, workDir } = replyTarget;

    if (channel === "feishu") {
        // 优先使用 replyContext 中的 openId（干净字符串），回退到 userId
        const feishuTarget = replyContext?.openId || userId;
        await sendFeishuReply(feishuTarget, text);
        return;
    }

    if (channel === "dingtalk") {
        await sendDingtalkReply(replyContext || userId, text);
        return;
    }

    // 默认微信通道
    if (currentWechatAuth) {
        await sendWechatReply(currentWechatAuth, userId, text, contextToken, workDir);
    }
}

/**
 * 轮询未推送的审批问题并自动推送到飞书/钉钉卡片
 */
function checkPendingQuestionsForCards() {
    const config = getConfig();
    const questions = getPendingQuestions();
    let updated = false;

    for (const q of questions) {
        if (!q.answered) {
            // 飞书审批卡片
            if (shouldNotifyChannel(config, "feishu") && !q.feishuPushed) {
                q.feishuPushed = true;
                updated = true;
                sendFeishuApprovalCard(null, {
                    reqId: q.reqId,
                    question: q.question,
                    options: q.options,
                    projectName: q.projectName,
                    agentName: q.agentName,
                    timeoutSeconds: Math.round((q.timeoutMs || 300000) / 1000),
                });
            }

            // 钉钉审批卡片
            if (shouldNotifyChannel(config, "dingtalk") && !q.dingtalkPushed) {
                q.dingtalkPushed = true;
                updated = true;
                sendDingtalkApprovalCard(null, {
                    reqId: q.reqId,
                    question: q.question,
                    options: q.options,
                    projectName: q.projectName,
                    agentName: q.agentName,
                    timeoutSeconds: Math.round((q.timeoutMs || 300000) / 1000),
                });
            }
        }
    }

    if (updated) {
        savePendingQuestions(questions);
    }
}

/**
 * 飞书卡片一键审批回调
 */
async function handleFeishuApproval({ reqId, decision, userId }) {
    const questions = getPendingQuestions();
    const targetQ = questions.find((q) => q.reqId === reqId && !q.answered);
    if (targetQ) {
        targetQ.answered = true;
        targetQ.answer = decision;
        savePendingQuestions(questions);
        console.log(`[+] 飞书审批确认: #${reqId} -> ${decision}`);
        await sendFeishuReply(userId, `已提交决策 [#${reqId}]: 「${decision}」，智能体已恢复继续执行。`);
        return { success: true, alreadyAnswered: false };
    }
    return { success: true, alreadyAnswered: true };
}

/**
 * 飞书交互卡片按钮动作响应
 */
async function handleFeishuCardAction({ action, payload, userId }) {
    const instances = getInstances();
    const activeInst = getActiveInstance();
    const detected = detectInstalledAgents();
    const config = getConfig();

    if (action === "switch_instance") {
        const num = parseInt(payload.num, 10);
        const target = instances.find((i) => i.num === num);
        if (target) {
            setActiveInstance(target);
            return { success: true, message: `已切换到 [${target.num}] ${target.projectName} (${target.agentName})` };
        }
        return { success: false, message: `未找到编号为 [${num}] 的任务` };
    }

    if (action === "close_instance") {
        const num = parseInt(payload.num, 10);
        const target = instances.find((i) => i.num === num);
        if (target) {
            const closedName = `[${target.num}] ${target.projectName}`;
            const wasActive = activeInst && activeInst.id === target.id;
            let remain = instances.filter((i) => i.id !== target.id);
            remain.forEach((inst, idx) => { inst.num = idx + 1; });
            saveInstances(remain);
            if (remain.length === 0) {
                saveActiveFocus(null);
                return { success: true, message: `已关闭 ${closedName}，当前已无活动任务。` };
            }
            if (wasActive) setActiveInstance(remain[0]);
            return { success: true, message: `已关闭 ${closedName}` };
        }
        return { success: false, message: "未找到对应任务" };
    }

    if (action === "switch_agent") {
        const key = payload.key;
        const targetAgent = detected.find((a) => a.key === key);
        if (targetAgent) {
            activeInst.agentKey = targetAgent.key;
            activeInst.agentName = targetAgent.name;
            setActiveInstance(activeInst);
            return { success: true, message: `当前任务助手已切为: ${targetAgent.name}` };
        }
        return { success: false, message: `未知智能体: ${key}` };
    }

    if (action === "set_default_agent") {
        const key = payload.key;
        const targetAgent = detected.find((a) => a.key === key);
        if (targetAgent) {
            config.defaultAgent = targetAgent.key;
            saveConfig(config);
            activeInst.agentKey = targetAgent.key;
            activeInst.agentName = targetAgent.name;
            setActiveInstance(activeInst);
            return { success: true, message: `全局默认助手已设为: ${targetAgent.name}` };
        }
        return { success: false, message: `未知智能体: ${key}` };
    }

    if (action === "quick_cmd") {
        if (payload.cmd) {
            await handleCommand({
                channel: "feishu",
                userId,
                text: payload.cmd,
                sendReply: sendChannelReply,
                sendFeishuTaskList: sendFeishuTaskListCard,
                sendFeishuAgentList: sendFeishuAgentListCard,
            });
            return { success: true, message: `已执行: ${payload.cmd}` };
        }
    }

    return { success: true, message: payload.message || "提示" };
}

/**
 * 定时看门狗：检测并自动关闭空闲超时的会话任务
 */
function checkIdleTasks() {
    const config = getConfig();
    const idleMinutes = config.sessionIdleMinutes ?? 15;
    if (!idleMinutes || idleMinutes <= 0) return;

    const idleMs = idleMinutes * 60 * 1000;
    const instances = getInstances();
    if (instances.length === 0) return;

    const running = getRunningTask();
    const now = Date.now();
    const activeInst = getActiveInstance(false);

    let hasChanges = false;
    const remaining = [];

    for (const inst of instances) {
        const isRunning = running && running.workDir === inst.workDir;
        const lastActive = inst.lastActiveAt || inst.createdAt || now;
        const isExpired = (now - lastActive) > idleMs;

        if (isExpired && !isRunning) {
            console.log(`[*] 任务 [${inst.num}] ${inst.projectName} 空闲已达 ${idleMinutes} 分钟，已自动关闭释放。`);
            hasChanges = true;
        } else {
            remaining.push(inst);
        }
    }

    if (hasChanges) {
        remaining.forEach((inst, idx) => { inst.num = idx + 1; });
        saveInstances(remaining);
        if (remaining.length > 0) {
            if (!remaining.some((i) => i.id === activeInst?.id)) {
                setActiveInstance(remaining[0]);
            }
        } else {
            saveActiveFocus(null);
            console.log("[*] 所有活动任务均已闲置关闭，当前处于空闲待命状态。");
        }
    }
}

/**
 * 启动智能体调度服务
 */
async function startBridge() {
    const config = getConfig();
    const machineLabel = (config.machineName && config.machineName.trim()) ? config.machineName.trim() : os.hostname();

    console.log("=========================================");
    console.log("  Agent Hub 调度服务");
    console.log("=========================================");
    console.log(`[+] 本机设备标识: ${machineLabel}`);
    console.log(`[+] 当前工作目录: ${config.workDir}`);
    console.log(`[+] 历史归档目录: ${LOGS_DIR}`);
    cleanOldLogs(config.logRetentionDays ?? 14);

    // 自检探测本机 AI 智能体安装情况
    console.log("[*] 正在探测本机已安装的 AI 智能体...");
    const available = detectInstalledAgents().filter((a) => a.installed);
    if (available.length > 0) {
        available.forEach((a) => {
            console.log(`  [√] ${a.name.padEnd(12)}: 已就绪 (${a.key})`);
        });
    } else {
        console.log("  [-] 未检测到已就绪的 AI 智能体 (可在系统安装 claude / opencode / hermes / codex / pi / openclaw)");
    }
    const defAgent = resolveDefaultAgent(config);
    console.log(`[+] 默认智能体: ${defAgent.name} (配置模式: defaultAgent="${config.defaultAgent || "auto"}")`);
    console.log(`[+] 会话保活窗口: ${config.sessionIdleMinutes ?? 15} 分钟 (空闲超时自动关闭释放)`);

    // 启动空闲会话自动关闭看门狗 (每 30 秒轮询)
    setInterval(checkIdleTasks, 30000);

    let startedChannels = 0;

    const onIncomingMessage = async (msg) => {
        await handleCommand({
            ...msg,
            sendReply: sendChannelReply,
            sendFeishuTaskList: sendFeishuTaskListCard,
            sendFeishuAgentList: sendFeishuAgentListCard,
        });
    };

    // 1. 启动微信通道
    const wechatConf = config.channels?.wechat;
    if (!wechatConf || wechatConf.enabled !== false) {
        try {
            const wechatRes = await startWechatChannel({
                authPath: AUTH_PATH,
                syncPath: SYNC_PATH,
                onMessage: onIncomingMessage,
            });
            if (wechatRes) {
                currentWechatAuth = wechatRes.auth;
                startedChannels++;
            }
        } catch (err) {
            console.error("[-] 微信通道启动异常:", err.message);
        }
    }

    // 2. 启动飞书 WebSocket 通道
    const feishuConf = config.channels?.feishu;
    if (feishuConf && feishuConf.enabled) {
        try {
            const feishuRes = await initFeishuChannel({
                config: feishuConf,
                onMessage: onIncomingMessage,
                onApprovalAction: handleFeishuApproval,
                onCardAction: handleFeishuCardAction,
            });
            if (feishuRes) {
                startedChannels++;
                setInterval(checkPendingQuestionsForCards, 1000);
                try {
                    await sendFeishuOnlineNotice(null, {
                        machineLabel,
                        defAgent,
                        workDir: config.workDir,
                    });
                } catch {}
            }
        } catch (err) {
            console.error("[-] 飞书通道启动异常:", err.message);
        }
    }

    // 3. 启动钉钉 Stream 通道
    const dingtalkConf = config.channels?.dingtalk;
    if (dingtalkConf && dingtalkConf.enabled) {
        try {
            const dingtalkRes = await initDingtalkChannel({
                config: dingtalkConf,
                onMessage: onIncomingMessage,
            });
            if (dingtalkRes) {
                startedChannels++;
            }
        } catch (err) {
            console.error("[-] 钉钉通道启动异常:", err.message);
        }
    }

    if (startedChannels === 0) {
        console.warn("[!] 警告: 未启动任何消息通道。请检查 config.json 配置。");
    } else {
        console.log(`[+] 调度中枢启动就绪，已激活 ${startedChannels} 个消息通道。\n`);
    }
}

startBridge().catch((err) => {
    console.error("[-] 调度中枢致命异常:", err);
});
