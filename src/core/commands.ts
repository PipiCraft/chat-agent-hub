import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
    getConfig,
    saveConfig,
    getInstances,
    saveInstances,
    getActiveInstance,
    setActiveInstance,
    saveActiveFocus,
    getPendingQuestions,
    savePendingQuestions,
    appendHistoryLog,
} from "./state.js";
import {
    detectInstalledAgents,
    resolveDefaultAgent,
    getRunningTask,
    getRecentTaskLogs,
    stopCurrentTask,
    executeByAgent,
} from "./runner.js";
import { getGitSummary, getGitFullDiff } from "./git.js";
import {
    normalizeChannelName,
    getChannelDisplayName,
    getChannelNotifyStatus,
} from "../channels/common.js";
import type { ReplyTarget } from "../types/index.js";

export interface HandleCommandParams {
    channel: string;
    userId: string;
    text: string;
    replyContext?: any;
    contextToken?: string;
    sendReply: (target: ReplyTarget, text: string) => Promise<any>;
    sendFeishuTaskList?: (target: any, options?: any) => Promise<any>;
    sendFeishuAgentList?: (target: any, options?: any) => Promise<any>;
}

export const HELP_MENU = `指令列表
━━━━━━━━━━━━━━
[核心指令]
• 状态 / 运行状态 : 查看服务运行健康度与内存占用
• 列表            : 查看所有活动任务与当前焦点
• 切换 <编号>     : 切换当前任务焦点 (如: 切换 2)
• 新任务 [名称]   : 创建独立新任务 (继承当前环境)
• cd <路径>       : 切换当前任务的工作目录
• 助手 [编号]     : 查看或切换当前智能体 (如: 助手 2)
• 默认助手 <编号> : 设置全局默认智能体
• 关闭 <编号>     : 关闭指定任务 (如: 关闭 2)
• 停止             : 中止当前正在执行的任务
• 改动             : 查看当前项目的 Git 改动
• 日志             : 查看当前/最近任务控制台输出
• 推送 [渠道]     : 查看或配置本地推送目标 (全部/微信/飞书/钉钉)
• 通道            : 查看通道状态与添加飞书/钉钉指引
• 保活 [分钟]     : 查看或设置任务空闲释放窗口 (如: 保活 30)
• 菜单             : 查看本说明

[审批回复]
回复选项编号 (如 1) 或「同意 101」/「拒绝 101」

直接发送文字将自动交由当前任务执行。`;

function formatUptime(sec: number): string {
    const s = Math.floor(sec);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0 || days > 0) parts.push(`${hours}小时`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}分`);
    if (parts.length === 0) parts.push(`${seconds}秒`);
    return parts.join(" ");
}

/**
 * 统一指令处理器：处理来自微信、飞书、钉钉的消息
 */
export async function handleCommand({
    channel,
    userId,
    text,
    replyContext,
    contextToken,
    sendReply,
    sendFeishuTaskList,
    sendFeishuAgentList,
}: HandleCommandParams): Promise<void> {
    const config = getConfig();
    const currentInst = getActiveInstance(false);
    const replyTarget: ReplyTarget = {
        channel,
        userId,
        replyContext,
        contextToken,
        workDir: currentInst?.workDir || config.workDir,
    };
    const rawText = (text || "").trim();
    if (!rawText) return;

    const machineLabel = (config.machineName && config.machineName.trim()) ? config.machineName.trim() : os.hostname();

    // 0. 优先检查人机决策审批 (ask_agent 请求答复)
    const pendingQuestions = getPendingQuestions().filter((q) => !q.answered);
    if (pendingQuestions.length > 0) {
        let matchedQ = null;
        let userDecision = null;

        // 0.1 回复纯选项编号 (如 "1", "2") 或 "#101 1"
        const optNumMatch = rawText.match(/^(?:#?(\d{3})\s+)?([1-9]\d*)$/);
        if (optNumMatch) {
            const targetReqId = optNumMatch[1] ? parseInt(optNumMatch[1], 10) : null;
            const choiceIndex = parseInt(optNumMatch[2], 10) - 1;
            const candidateQ = targetReqId
                ? pendingQuestions.find((q) => q.reqId === targetReqId)
                : (pendingQuestions.length === 1 ? pendingQuestions[0] : null);

            if (candidateQ && Array.isArray(candidateQ.options) && candidateQ.options[choiceIndex]) {
                matchedQ = candidateQ;
                userDecision = candidateQ.options[choiceIndex];
            }
        }

        // 0.2 回复同意 / 允许 (如 "同意", "同意 101")
        if (!matchedQ) {
            const approveMatch = rawText.match(/^(?:同意|允许|通过|approve|yes|ok)(?:\s*#?(\d{3}))?$/i);
            if (approveMatch) {
                const targetReqId = approveMatch[1] ? parseInt(approveMatch[1], 10) : null;
                matchedQ = targetReqId
                    ? pendingQuestions.find((q) => q.reqId === targetReqId)
                    : (pendingQuestions.length === 1 ? pendingQuestions[0] : null);
                if (matchedQ) {
                    userDecision = (Array.isArray(matchedQ.options) && matchedQ.options.length > 0)
                        ? matchedQ.options[0]
                        : "同意执行";
                }
            }
        }

        // 0.3 回复拒绝 / 终止 (如 "拒绝", "拒绝 101")
        if (!matchedQ) {
            const rejectMatch = rawText.match(/^(?:拒绝|终止|取消|reject|no)(?:\s*#?(\d{3}))?$/i);
            if (rejectMatch) {
                const targetReqId = rejectMatch[1] ? parseInt(rejectMatch[1], 10) : null;
                matchedQ = targetReqId
                    ? pendingQuestions.find((q) => q.reqId === targetReqId)
                    : (pendingQuestions.length === 1 ? pendingQuestions[0] : null);
                if (matchedQ) {
                    userDecision = "用户已拒绝该操作";
                }
            }
        }

        // 0.4 自定义说明答复 (如 "#101 选用方案B")
        if (!matchedQ) {
            const customMatch = rawText.match(/^#(\d{3})\s+(.+)$/s);
            if (customMatch) {
                const targetReqId = parseInt(customMatch[1], 10);
                matchedQ = pendingQuestions.find((q) => q.reqId === targetReqId);
                if (matchedQ) {
                    userDecision = customMatch[2].trim();
                }
            }
        }

        if (matchedQ && userDecision) {
            matchedQ.answered = true;
            matchedQ.answer = userDecision;
            savePendingQuestions(pendingQuestions);

            const confirmReply = `已确认 [#${matchedQ.reqId}]: 「${userDecision}」，已转交 ${matchedQ.agentName} 继续执行。`;
            appendHistoryLog(userId, rawText, confirmReply, config.workDir, 1);
            await sendReply(replyTarget, confirmReply);
            return;
        }
    }

    // 1. 帮助菜单
    if (["菜单", "？", "?", "help", "帮助"].includes(rawText.toLowerCase())) {
        appendHistoryLog(userId, rawText, HELP_MENU, config.workDir, 1);
        await sendReply(replyTarget, HELP_MENU);
        return;
    }

    // 2. 系统健康度与状态查询 (状态 / 系统状态 / 运行状态 / status)
    if (["状态", "系统状态", "运行状态", "status", "info", "健康度"].includes(rawText.toLowerCase())) {
        const instances = getInstances();
        const activeInst = getActiveInstance(false);
        const running = getRunningTask();
        const defAgent = resolveDefaultAgent(config);
        const uptimeStr = formatUptime(process.uptime());
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

        const channelsList = [];
        if (config.channels?.wechat?.enabled !== false) channelsList.push("微信");
        if (config.channels?.feishu?.enabled) channelsList.push("飞书");
        if (config.channels?.dingtalk?.enabled) channelsList.push("钉钉");

        let reply = `[Agent Hub 系统状态] · ${machineLabel}\n━━━━━━━━━━━━━━\n`;
        reply += `运行时间: ${uptimeStr} (PID: ${process.pid})\n`;
        reply += `内存占用: ${memMB} MB\n`;
        reply += `默认助手: ${defAgent.name}\n`;
        reply += `保活窗口: ${config.sessionIdleMinutes ?? 15} 分钟\n`;
        reply += `启用通道: ${channelsList.join(" / ") || "无"}\n`;

        if (instances.length > 0) {
            reply += `\n[活动任务: ${instances.length} 个]\n`;
            instances.forEach((i) => {
                const isCurrent = activeInst && i.id === activeInst.id;
                const statusTag = isCurrent ? " [当前焦点]" : "";
                reply += `[${i.num}] ${i.projectName} (${i.agentName})${statusTag}\n`;
            });
            reply += `\n回复「列表」可查看任务详情与切换。\n`;
        } else {
            reply += `\n[活动任务: 0 个]\n当前处于空闲待命状态，直接发送需求即可启动执行。\n`;
        }

        if (running) {
            const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
            reply += `━━━━━━━━━━━━━━\n当前执行中 (${elapsed}s): [${running.projectName}] ${running.agentName}\n回复「停止」可取消执行。\n`;
        }

        appendHistoryLog(userId, rawText, reply, activeInst?.workDir || config.workDir, activeInst?.turnCount || 0);
        await sendReply(replyTarget, reply);
        return;
    }

    // 2.1 任务列表查询 (列表 / 查看列表 / list)
    if (["列表", "查看列表", "任务列表", "项目列表", "list", "当前任务"].includes(rawText.toLowerCase())) {
        const instances = getInstances();
        const activeInst = getActiveInstance(false);
        const running = getRunningTask();

        if (channel === "feishu" && sendFeishuTaskList) {
            await sendFeishuTaskList(userId, { instances, activeInst, machineLabel });
            return;
        }

        let reply = `[任务列表] · ${machineLabel}\n━━━━━━━━━━━━━━\n`;
        if (instances.length === 0) {
            reply += "当前暂无活动任务，处于空闲待命状态。\n\n直接发送需求即可自动启动执行。";
            appendHistoryLog(userId, rawText, reply, config.workDir, 0);
            await sendReply(replyTarget, reply);
            return;
        }

        instances.forEach((i) => {
            const isCurrent = activeInst && i.id === activeInst.id;
            const statusTag = isCurrent ? " [当前焦点]" : "";
            reply += `[${i.num}] ${i.projectName} (${i.agentName})${statusTag}\n路径: ${i.workDir} · 轮次: ${i.turnCount || 0}\n\n`;
        });

        if (running) {
            const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
            reply += `━━━━━━━━━━━━━━\n当前执行中 (${elapsed}s): [${running.projectName}] ${running.agentName}\n回复「停止」可取消执行。\n`;
        } else {
            reply += `切换任务: 回复「切换 <编号>」\n关闭任务: 回复「关闭 <编号>」\n新建任务: 回复「新任务 [名称]」`;
        }

        appendHistoryLog(userId, rawText, reply, activeInst?.workDir || config.workDir, activeInst?.turnCount || 0);
        await sendReply(replyTarget, reply);
        return;
    }

    // 2.2 通道状态与新增指引 (通道 / 添加飞书 / 添加钉钉 / 配置飞书 / channels)
    const channelCmdMatch = rawText.match(/^(?:通道|渠道|channels?|通道状态|添加飞书|配置飞书|飞书配置|添加钉钉|配置钉钉|钉钉配置)$/i);
    if (channelCmdMatch) {
        const lower = rawText.toLowerCase();
        if (lower.includes("飞书")) {
            const reply = `【添加飞书通道指引】\n━━━━━━━━━━━━━━\n1. 访问飞书开放平台 (open.feishu.cn) 创建自建应用并添加「机器人」能力\n2. 开通权限: 在「权限管理」开通 im:message (收发消息)\n3. 事件订阅: 在「事件与回调」选择长连接 (WebSocket)，添加事件 im.message.receive_v1\n4. 快捷接入:\n   电脑终端运行: cah config (选 1 输入 App ID 与 Secret 自动重启生效)\n   或直接在 config.json 的 channels.feishu 填入。`;
            appendHistoryLog(userId, rawText, reply, config.workDir, 0);
            await sendReply(replyTarget, reply);
            return;
        }

        if (lower.includes("钉钉")) {
            const reply = `【添加钉钉通道指引】\n━━━━━━━━━━━━━━\n1. 访问钉钉开发者后台 (open-dev.dingtalk.com) 创建应用并添加「机器人」能力\n2. 模式选择: 消息接收模式设为 Stream 模式并保存发布\n3. 快捷接入:\n   电脑终端运行: cah config (选 2 输入 Client ID 与 Secret 自动重启生效)\n   或直接在 config.json 的 channels.dingtalk 填入。`;
            appendHistoryLog(userId, rawText, reply, config.workDir, 0);
            await sendReply(replyTarget, reply);
            return;
        }

        // 通用通道状态
        const wechatOn = config.channels?.wechat?.enabled !== false;
        const feishuOn = Boolean(config.channels?.feishu?.enabled);
        const dingtalkOn = Boolean(config.channels?.dingtalk?.enabled);

        let reply = `[消息通道状态] · ${machineLabel}\n━━━━━━━━━━━━━━\n`;
        reply += `• 微信: [${wechatOn ? "已启用" : "未启用"}]\n`;
        reply += `• 飞书: [${feishuOn ? "已启用" : "未启用"}]\n`;
        reply += `• 钉钉: [${dingtalkOn ? "已启用" : "未启用"}]\n\n`;
        reply += `[如何添加新通道]\n• 电脑终端推荐: cah config (向导交互配置并自动重启)\n• 或手机回复「添加飞书」/「添加钉钉」查看具体操作步骤。`;

        appendHistoryLog(userId, rawText, reply, config.workDir, 0);
        await sendReply(replyTarget, reply);
        return;
    }

    // 2.3 会话保活窗口配置 (保活 <分钟> / sessionIdleMinutes)
    const idleMatch = rawText.match(/^(?:保活|超时保活|会话保活|保活时间)(?:\s+(\d+))?$/i);
    if (idleMatch) {
        if (idleMatch[1]) {
            const minutes = parseInt(idleMatch[1], 10);
            if (minutes > 0 && minutes <= 1440) {
                config.sessionIdleMinutes = minutes;
                saveConfig(config);
                const reply = `[+] 会话保活窗口已更新为 ${minutes} 分钟，已自动保存至 config.json。`;
                appendHistoryLog(userId, rawText, reply, config.workDir, 0);
                await sendReply(replyTarget, reply);
                return;
            }
        }
        const curMins = config.sessionIdleMinutes ?? 15;
        const reply = `当前会话保活窗口为 ${curMins} 分钟。\n\n如需修改，可回复:「保活 30」(单位: 分钟)`;
        appendHistoryLog(userId, rawText, reply, config.workDir, 0);
        await sendReply(replyTarget, reply);
        return;
    }

    // 3. 切换当前焦点任务 (切换 <编号/名称>)
    const switchMatch = rawText.match(/^(?:切换|切到|switch|to)\s*(.+)$/i);
    if (switchMatch) {
        const target = switchMatch[1].trim();
        const instances = getInstances();
        let targetInst = null;
        const num = parseInt(target, 10);
        if (!isNaN(num)) {
            targetInst = instances.find((i) => i.num === num);
        } else {
            targetInst = instances.find((i) => i.projectName.toLowerCase() === target.toLowerCase());
        }

        if (!targetInst) {
            const reply = `未找到任务 [${target}]，发送「列表」可查看当前可用任务。`;
            await sendReply(replyTarget, reply);
            return;
        }

        setActiveInstance(targetInst);
        const reply = `已切换至任务 [${targetInst.num}] ${targetInst.projectName} (${targetInst.agentName})\n工作目录: ${targetInst.workDir}`;
        appendHistoryLog(userId, rawText, reply, targetInst.workDir, targetInst.turnCount);
        await sendReply(replyTarget, reply);
        return;
    }

    // 4. 新建独立对话任务 (新任务 [名称] [助手] [目录])
    const newTaskMatch = rawText.match(/^(?:新任务|新建任务|新建项目|new)\s*(.*)$/i);
    if (newTaskMatch) {
        const argStr = newTaskMatch[1].trim();
        const activeInst = getActiveInstance();
        const detected = detectInstalledAgents();
        const instances = getInstances();

        let customName: string | null = null;
        let targetAgentKey = activeInst.agentKey;
        let targetAgentName = activeInst.agentName;
        let targetDir = activeInst.workDir;

        if (argStr) {
            const tokens = argStr.split(/\s+/);
            tokens.forEach((token: string) => {
                const clean = token.replace(/^["']|["']$/g, "").trim();
                const matchedAgent = detected.find(
                    (a) => a.key === clean.toLowerCase() || (a.aliases && a.aliases.includes(clean.toLowerCase()))
                );
                if (matchedAgent) {
                    targetAgentKey = matchedAgent.key;
                    targetAgentName = matchedAgent.name;
                    return;
                }
                if (fs.existsSync(clean) && fs.statSync(clean).isDirectory()) {
                    targetDir = path.resolve(clean);
                    return;
                }
                if (!customName) {
                    customName = clean;
                }
            });
        }

        const nextNum = instances.length > 0 ? Math.max(...instances.map((i) => i.num || 0)) + 1 : 1;
        const projName = customName || `任务-${nextNum}`;
        const instanceId = `task-${nextNum}-${Date.now()}`;

        const newInst = {
            id: instanceId,
            num: nextNum,
            agentKey: targetAgentKey,
            agentName: targetAgentName,
            projectName: projName,
            workDir: targetDir,
            source: "remote",
            sourceLabel: "[远程]",
            sessionId: crypto.randomUUID(),
            turnCount: 0,
            active: true,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        };

        instances.push(newInst);
        saveInstances(instances);
        setActiveInstance(newInst);

        const reply = `已创建新任务 [${newInst.num}] ${newInst.projectName}:\n• 智能体: ${newInst.agentName}\n• 工作目录: ${newInst.workDir}\n\n当前焦点已自动锁定，直接发送消息即可开始执行。`;
        appendHistoryLog(userId, rawText, reply, newInst.workDir, 0);
        await sendReply(replyTarget, reply);
        return;
    }

    // 5. 切换当前任务工作目录 (cd <路径> / 换目录 <路径>)
    const cdMatch = rawText.match(/^(?:cd|换目录|切目录)\s*(.+)$/i);
    if (cdMatch) {
        const rawPath = cdMatch[1].trim().replace(/^["']|["']$/g, "");
        const resolved = path.resolve(rawPath);

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            const reply = `路径不存在或不是目录: ${rawPath}`;
            await sendReply(replyTarget, reply);
            return;
        }

        const activeInst = getActiveInstance();
        activeInst.workDir = resolved;
        activeInst.projectName = path.basename(resolved) || activeInst.projectName;
        setActiveInstance(activeInst);

        const reply = `当前任务 [${activeInst.num}] 工作目录已切换为:\n${resolved}\n(项目名同步为: ${activeInst.projectName})`;
        appendHistoryLog(userId, rawText, reply, resolved, activeInst.turnCount);
        await sendReply(replyTarget, reply);
        return;
    }

    // 6. 智能体查看与切换 (助手 [编号/名称] / 智能体 [编号/名称])
    const agentMatch = rawText.match(/^(?:助手|智能体|agents?)\s*(.*)$/i);
    if (agentMatch) {
        const target = agentMatch[1].trim().toLowerCase();
        const detected = detectInstalledAgents();
        const available = detected.filter((a) => a.installed);
        const activeInst = getActiveInstance();
        const defAgent = resolveDefaultAgent(config);

        if (!target) {
            // 查看列表
            if (channel === "feishu" && sendFeishuAgentList) {
                await sendFeishuAgentList(userId, { detectedAgents: available, defAgent, activeInst, machineLabel });
                return;
            }

            let reply = `[本机 AI 智能体] · ${machineLabel}\n━━━━━━━━━━━━━━\n`;
            if (available.length === 0) {
                reply += `未检测到已就绪的 AI 智能体，请先在系统安装对应 CLI 工具。\n`;
            } else {
                available.forEach((a, idx) => {
                    const isDef = a.key === defAgent.key ? " (全局默认)" : "";
                    const isCur = a.key === activeInst.agentKey ? " [当前使用]" : "";
                    reply += `[${idx + 1}] ${a.name} (${a.key})${isDef}${isCur}\n`;
                });
            }
            reply += `\n切换智能体: 回复「助手 <编号/名称>」\n设置全局默认: 回复「默认助手 <编号/名称>」`;
            await sendReply(replyTarget, reply);
            return;
        }

        // 切换当前任务智能体
        let targetAgent = null;
        const num = parseInt(target, 10);
        if (!isNaN(num)) {
            targetAgent = available[num - 1];
        } else {
            targetAgent = available.find((a) => a.key === target || (a.aliases && a.aliases.includes(target)) || a.name.toLowerCase().includes(target))
                || detected.find((a) => a.key === target || (a.aliases && a.aliases.includes(target)) || a.name.toLowerCase().includes(target));
        }

        if (!targetAgent) {
            await sendReply(replyTarget, `未找到智能体 [${target}]，发送「助手」可查看当前可用智能体。`);
            return;
        }

        activeInst.agentKey = targetAgent.key;
        activeInst.agentName = targetAgent.name;
        setActiveInstance(activeInst);

        const warn = targetAgent.installed ? "" : "\n警告: 本机尚未检测到该命令，请确保已安装。";
        const reply = `当前任务 [${activeInst.num}] 已切换智能体为: ${targetAgent.name}${warn}`;
        appendHistoryLog(userId, rawText, reply, activeInst.workDir, activeInst.turnCount);
        await sendReply(replyTarget, reply);
        return;
    }

    // 7. 设置全局默认智能体 (默认助手 <编号/名称>)
    const defAgentMatch = rawText.match(/^(?:默认助手|默认智能体)\s*(.+)$/i);
    if (defAgentMatch) {
        const target = defAgentMatch[1].trim().toLowerCase();
        const detected = detectInstalledAgents();
        const available = detected.filter((a) => a.installed);
        let targetAgent = null;
        const num = parseInt(target, 10);
        if (!isNaN(num)) {
            targetAgent = available[num - 1];
        } else {
            targetAgent = available.find((a) => a.key === target || (a.aliases && a.aliases.includes(target)) || a.name.toLowerCase().includes(target))
                || detected.find((a) => a.key === target || (a.aliases && a.aliases.includes(target)) || a.name.toLowerCase().includes(target));
        }

        if (!targetAgent) {
            await sendReply(replyTarget, `未找到智能体 [${target}]，发送「助手」可查看当前可用智能体。`);
            return;
        }

        config.defaultAgent = targetAgent.key;
        saveConfig(config);

        const activeInst = getActiveInstance();
        activeInst.agentKey = targetAgent.key;
        activeInst.agentName = targetAgent.name;
        setActiveInstance(activeInst);

        const reply = `已将全局默认智能体设为: ${targetAgent.name} (${targetAgent.key})\n当前任务已同步绑定。`;
        await sendReply(replyTarget, reply);
        return;
    }

    // 8. 关闭任务 (关闭 <编号>)
    const closeMatch = rawText.match(/^(?:关闭|close|killtask)\s*(.+)$/i);
    if (closeMatch) {
        const target = closeMatch[1].trim();
        const instances = getInstances();
        const activeInst = getActiveInstance(false);
        const num = parseInt(target, 10);
        const idx = instances.findIndex((i) => i.num === num || i.projectName.toLowerCase() === target.toLowerCase());

        if (idx === -1) {
            await sendReply(replyTarget, `未找到编号为 [${target}] 的任务，发送「列表」可查看当前任务。`);
            return;
        }

        const removed = instances.splice(idx, 1)[0];
        instances.forEach((inst, i) => { inst.num = i + 1; });
        saveInstances(instances);

        let reply = `已关闭任务 [${removed.num}] ${removed.projectName}。`;
        if (instances.length === 0) {
            saveActiveFocus(null);
            reply += `\n当前已无活动任务，已进入空闲待命状态。`;
        } else if (activeInst && activeInst.id === removed.id) {
            const nextActive = instances[0];
            setActiveInstance(nextActive);
            reply += `\n焦点已自动切换至: [${nextActive.num}] ${nextActive.projectName}`;
        }

        appendHistoryLog(userId, rawText, reply, config.workDir, 1);
        await sendReply(replyTarget, reply);
        return;
    }

    // 9. 终止任务 (停止 / 取消)
    if (["停止", "取消", "终止", "stop", "kill"].includes(rawText.toLowerCase())) {
        const res = stopCurrentTask();
        await sendReply(replyTarget, res.message);
        return;
    }

    // 10. 查看 Git 改动 (改动 / diff)
    if (["改动", "diff", "git"].includes(rawText.toLowerCase())) {
        const activeInst = getActiveInstance();
        const diffText = await getGitFullDiff(activeInst.workDir);
        const reply = `[Git 改动: ${activeInst.projectName}]\n\n${diffText}`;
        appendHistoryLog(userId, rawText, reply, activeInst.workDir, activeInst.turnCount);
        await sendReply(replyTarget, reply);
        return;
    }

    // 11. 控制台日志 (日志 / logs)
    if (["日志", "log", "logs"].includes(rawText.toLowerCase())) {
        const logs = getRecentTaskLogs();
        const reply = logs ? `[最近控制台日志]\n━━━━━━━━━━━━━━\n${logs.slice(-1500)}` : "暂无控制台日志。";
        await sendReply(replyTarget, reply);
        return;
    }

    // 12. 本地任务推送渠道配置 (推送 [目标] / 推送通道 [目标])
    const notifyMatch = rawText.match(/^(?:推送|推送通道|推送设置|notify)\s*(.*)$/i);
    if (notifyMatch) {
        const rawArg = notifyMatch[1].trim();
        const statuses = getChannelNotifyStatus(config);

        if (!rawArg) {
            let currentTargetDesc = "全部已启用渠道 (默认)";
            if (Array.isArray(config.notifyChannels) && config.notifyChannels.length > 0) {
                if (!config.notifyChannels.map((c) => normalizeChannelName(c)).includes("all")) {
                    currentTargetDesc = config.notifyChannels.map((c) => normalizeChannelName(c)).filter((c): c is string => Boolean(c)).map(getChannelDisplayName).join("、");
                }
            } else if (typeof config.notifyChannels === "string" && normalizeChannelName(config.notifyChannels) !== "all") {
                currentTargetDesc = getChannelDisplayName(normalizeChannelName(config.notifyChannels) || 'all');
            }

            let reply = `[本地任务推送通道] · ${machineLabel}\n━━━━━━━━━━━━━━\n当前配置: ${currentTargetDesc}\n\n通道状态:\n`;
            statuses.forEach((s) => {
                const mark = s.enabled ? "√" : "-";
                const notifyMark = s.willNotify ? "√ 接收" : "- 忽略";
                reply += `• [${mark}] ${s.name}: ${s.enabled ? "已启用" : "未启用"} (本地推送: ${notifyMark})\n`;
            });
            reply += `\n修改指令: 推送 全部 / 微信 / 飞书 / 钉钉 (如: 推送 微信 飞书)`;
            await sendReply(replyTarget, reply);
            return;
        }

        const tokens = rawArg.split(/[,，\s]+/).filter(Boolean);
        let newChannels: string[] = [];
        let isAll = false;

        for (const token of tokens) {
            const normalized = normalizeChannelName(token);
            if (normalized === "all") {
                isAll = true;
                break;
            }
            if (normalized && ["wechat", "feishu", "dingtalk"].includes(normalized)) {
                if (!newChannels.includes(normalized)) {
                    newChannels.push(normalized);
                }
            }
        }

        if (isAll) {
            config.notifyChannels = ["all"];
            saveConfig(config);
            await sendReply(replyTarget, "已将本地任务推送通道重置为: 全部已启用渠道。");
            return;
        }

        if (newChannels.length === 0) {
            await sendReply(replyTarget, "未识别到有效渠道名称，可选: 全部、微信、飞书、钉钉。");
            return;
        }

        config.notifyChannels = newChannels;
        saveConfig(config);
        const displayNames = newChannels.map(getChannelDisplayName).join("、");
        await sendReply(replyTarget, `已成功设置本地任务推送通道: ${displayNames}`);
        return;
    }

    // 13. 默认指令：交由当前活跃智能体异步执行
    const activeInst = getActiveInstance();
    const running = getRunningTask();
    if (running) {
        const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
        await sendReply(replyTarget, `已有任务执行中 (${elapsed}s):\n[${running.projectName}] ${running.agentName}\n\n回复「停止」可取消执行。`);
        return;
    }

    // 立即回复任务开始通知
    await sendReply(
        replyTarget,
        `[${activeInst.num}:${activeInst.projectName}] 开始执行 (${activeInst.agentName}):\n${rawText}\n\n(回复「停止」可取消，回复「日志」可查看控制台)`
    );

    // 异步执行智能体任务
    (async () => {
        try {
            if (!fs.existsSync(activeInst.workDir)) {
                try {
                    fs.mkdirSync(activeInst.workDir, { recursive: true });
                } catch {
                    activeInst.workDir = config.workDir;
                }
            }
            const fakeSession = { id: activeInst.sessionId, turnCount: activeInst.turnCount };
            const output = await executeByAgent(activeInst.agentKey, rawText, activeInst.workDir, fakeSession);

            activeInst.turnCount += 1;
            setActiveInstance(activeInst);

            appendHistoryLog(userId, rawText, `[${activeInst.agentName} · ${activeInst.projectName}] ${output}`, activeInst.workDir, activeInst.turnCount);

            let gitSummaryText = "";
            try {
                const gitRes = await getGitSummary(activeInst.workDir);
                if (gitRes && gitRes.hasChanges) {
                    gitSummaryText = `\n\n━━━━━━━━━━━━━━\n${gitRes.summary}`;
                }
            } catch {}

            await sendReply(
                replyTarget,
                `[${activeInst.num}:${activeInst.projectName}]\n\n${output}${gitSummaryText}`
            );
        } catch (err) {
            await sendReply(replyTarget, `执行出错: ${(err as any)?.message}`);
        }
    })();
}
