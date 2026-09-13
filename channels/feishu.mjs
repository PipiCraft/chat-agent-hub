import fs from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { ROOT_DIR } from "../core/state.mjs";

let larkClient = null;
let larkWsClient = null;
let lastKnownOpenId = null;

const LAST_USER_FILE = path.join(ROOT_DIR, "last-feishu-user.json");

export function getLastFeishuUser() {
    if (lastKnownOpenId) return lastKnownOpenId;
    try {
        if (fs.existsSync(LAST_USER_FILE)) {
            lastKnownOpenId = fs.readFileSync(LAST_USER_FILE, "utf-8").trim();
            return lastKnownOpenId;
        }
    } catch {}
    return null;
}

/**
 * 初始化飞书 WebSocket 长连接通道
 * @param {Object} options
 * @param {Object} options.config - 飞书配置 { appId, appSecret }
 * @param {Function} options.onMessage - 收到消息回调 ({ channel, userId, text, replyContext })
 * @param {Function} options.onApprovalAction - 收到卡片按钮点击回调 ({ reqId, decision, userId })
 */
export async function initFeishuChannel({ config, onMessage, onApprovalAction, onCardAction }) {
    if (!config || !config.appId || !config.appSecret) {
        console.warn("[!] 飞书配置缺失 (appId 或 appSecret 未填)，跳过飞书通道启动。");
        return null;
    }

    try {
        larkClient = new lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
        });

        larkWsClient = new lark.WSClient({
            appId: config.appId,
            appSecret: config.appSecret,
            loggerLevel: lark.LoggerLevel.warn,
        });

        const eventDispatcher = new lark.EventDispatcher({}).register({
            // 监听收到的私聊或群聊消息
            "im.message.receive_v1": async (data) => {
                try {
                    const message = data.message;
                    if (!message || message.message_type !== "text") return;

                    const contentObj = JSON.parse(message.content);
                    // 兼容群聊中的 @ 机器人格式（去掉 @_user_xxx 前缀）
                    const rawText = (contentObj.text || "").replace(/@_user_\d+\s*/g, "").trim();
                    if (!rawText) return;

                    const openId = data.sender?.sender_id?.open_id;
                    const chatId = message.chat_id;
                    if (openId) {
                        lastKnownOpenId = openId;
                        try {
                            fs.writeFileSync(LAST_USER_FILE, openId, "utf-8");
                        } catch {}
                    }

                    console.log(`\n[收到飞书指令]: "${rawText}" (来自: ${openId})`);

                    if (onMessage) {
                        onMessage({
                            channel: "feishu",
                            userId: openId,
                            text: rawText,
                            replyContext: { openId, chatId, messageId: message.message_id },
                        });
                    }
                } catch (err) {
                    console.error("[-] 飞书消息解析异常:", err.message);
                }
            },

            // 监听富文本交互卡片上的按钮点击动作（一键审批核心！）
            "card.action.trigger": async (data) => {
                try {
                    const actionVal = data.action?.value || {};
                    const reqId = actionVal.reqId ? parseInt(actionVal.reqId, 10) : null;
                    const decision = actionVal.decision || "已选择";
                    const openId = data.open_id;

                    console.log(`\n[飞书卡片按钮点击]: #${reqId} -> "${decision}" (用户: ${openId})`);

                    // 1. 人机决策审批动作
                    if (reqId && onApprovalAction) {
                        const actionRes = await onApprovalAction({
                            reqId,
                            decision,
                            userId: openId,
                        });
                        const isAlreadyDone = actionRes && actionRes.alreadyAnswered;
                        return {
                            toast: {
                                type: isAlreadyDone ? "info" : "success",
                                content: isAlreadyDone ? `该事项已处理完毕: ${decision}` : `已提交选项: ${decision}`,
                            },
                        };
                    }

                    // 2. 自定义交互卡片动作 (切换任务、切换助手、设为默认、关闭任务、快捷命令等)
                    if (actionVal.action && onCardAction) {
                        const cardRes = await onCardAction({
                            action: actionVal.action,
                            payload: actionVal,
                            userId: openId,
                        });
                        return {
                            toast: {
                                type: cardRes?.type || (cardRes?.success ? "success" : "info"),
                                content: cardRes?.message || "操作已完成",
                            },
                        };
                    }

                    return {
                        toast: {
                            type: "info",
                            content: `已选择: ${decision}`,
                        },
                    };
                } catch (err) {
                    console.error("[-] 飞书卡片动作处理异常:", err.message);
                    return {
                        toast: {
                            type: "error",
                            content: "处理操作失败",
                        },
                    };
                }
            },
        });

        await larkWsClient.start({ eventDispatcher });
        console.log("[+] 飞书长连接接入成功");
        return { client: larkClient, wsClient: larkWsClient };
    } catch (err) {
        console.error("[-] 飞书通道启动异常:", err.message);
        return null;
    }
}

/**
 * 向飞书用户发送纯文本消息
 */
export async function sendFeishuReply(openId, content) {
    if (!larkClient) {
        console.error("[-] 飞书客户端未初始化，无法发送消息");
        return;
    }
    const targetId = openId || getLastFeishuUser();
    if (!targetId) {
        console.warn("[!] 飞书发送目标 openId 为空，请先在飞书中向机器人发送一条任意消息。");
        return;
    }

    try {
        await larkClient.im.message.create({
            params: {
                receive_id_type: "open_id",
            },
            data: {
                receive_id: targetId,
                msg_type: "text",
                content: JSON.stringify({ text: content }),
            },
        });
    } catch (err) {
        console.error("[-] 发送飞书消息失败:", err.message);
    }
}

/**
 * 向飞书用户发送带交互按钮的多方向/二选一决策卡片
 */
export async function sendFeishuApprovalCard(openId, { reqId, question, options, projectName, agentName, timeoutSeconds = 300 }) {
    if (!larkClient) return;
    const targetId = openId || getLastFeishuUser();
    if (!targetId) return;

    try {
        const actionsList = [];

        if (Array.isArray(options) && options.length > 0) {
            // 场景 2：多方向决策（每个选项一个独立按钮）
            options.forEach((opt, idx) => {
                const optText = String(opt).trim();
                actionsList.push({
                    tag: "button",
                    text: {
                        tag: "plain_text",
                        content: optText.length > 25 ? optText.slice(0, 25) + "..." : optText,
                    },
                    type: idx === 0 ? "primary" : "default",
                    value: {
                        reqId,
                        decision: optText,
                    },
                });
            });

            // 补充红色的拒绝/终止按钮
            actionsList.push({
                tag: "button",
                text: {
                    tag: "plain_text",
                    content: "拒绝",
                },
                type: "danger",
                value: {
                    reqId,
                    decision: "拒绝",
                },
            });
        } else {
            // 场景 1：常规二选一审批（同意 / 拒绝）
            actionsList.push(
                {
                    tag: "button",
                    text: {
                        tag: "plain_text",
                        content: "同意",
                    },
                    type: "primary",
                    value: {
                        reqId,
                        decision: "同意",
                    },
                },
                {
                    tag: "button",
                    text: {
                        tag: "plain_text",
                        content: "拒绝",
                    },
                    type: "danger",
                    value: {
                        reqId,
                        decision: "拒绝",
                    },
                }
            );
        }

        const cardJson = {
            config: {
                wide_screen_mode: true,
            },
            header: {
                template: "orange",
                title: {
                    tag: "plain_text",
                    content: `[${projectName || "项目"}] 审批请示 #${reqId}`,
                },
            },
            elements: [
                {
                    tag: "div",
                    text: {
                        tag: "lark_md",
                        content: `**发起智能体**: ${agentName || "Claude Code"}\n**请示事项**: ${question}\n\n*(请在 ${timeoutSeconds} 秒内选择，也可在聊天框直接回复说明)*`,
                    },
                },
                {
                    tag: "hr",
                },
                {
                    tag: "action",
                    actions: actionsList,
                },
            ],
        };

        await larkClient.im.message.create({
            params: {
                receive_id_type: "open_id",
            },
            data: {
                receive_id: targetId,
                msg_type: "interactive",
                content: JSON.stringify(cardJson),
            },
        });
        console.log(`[+] 已向飞书用户 ${targetId} 推送决策卡片 #${reqId}`);
    } catch (err) {
        console.error("[-] 推送飞书决策卡片失败:", err.message);
    }
}

/**
 * 向飞书用户发送任务与项目列表交互卡片
 */
export async function sendFeishuTaskListCard(openId, { instances, activeInst, machineLabel }) {
    if (!larkClient) return;
    const targetId = openId || getLastFeishuUser();
    if (!targetId) return;

    try {
        const elements = [];
        const hasTasks = Array.isArray(instances) && instances.length > 0;

        if (!hasTasks) {
            elements.push({
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: `**运行设备**: \`${machineLabel || "本地终端"}\`\n当前暂无活动任务，处于空闲待命状态。\n\n直接在对话框发送需求即可自动启动执行。`,
                },
            });
            elements.push({ tag: "hr" });
            elements.push({
                tag: "action",
                actions: [
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "智能体列表" },
                        type: "default",
                        value: { action: "quick_cmd", cmd: "智能体" },
                    },
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "帮助菜单" },
                        type: "default",
                        value: { action: "quick_cmd", cmd: "菜单" },
                    },
                ],
            });
        } else {
            elements.push({
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: `**运行设备**: \`${machineLabel || "本地终端"}\`\n当前活动焦点: **[${activeInst?.num || 1}] ${activeInst?.projectName || "工作区"}** (${activeInst?.agentName || "智能体"})`,
                },
            });
            elements.push({ tag: "hr" });

            instances.forEach((inst) => {
                const isCurrent = activeInst && inst.id === activeInst.id;
                const statusTag = isCurrent ? " **[当前焦点]**" : "";
                elements.push({
                    tag: "div",
                    text: {
                        tag: "lark_md",
                        content: `**[${inst.num}] ${inst.projectName}** (${inst.agentName})${statusTag}\n路径: \`${inst.workDir}\` · 会话轮次: ${inst.turnCount || 0}`,
                    },
                });

                const actionButtons = [];
                if (!isCurrent) {
                    actionButtons.push({
                        tag: "button",
                        text: { tag: "plain_text", content: "切换" },
                        type: "primary",
                        value: { action: "switch_instance", num: inst.num },
                    });
                } else {
                    actionButtons.push({
                        tag: "button",
                        text: { tag: "plain_text", content: "当前任务" },
                        type: "default",
                        value: { action: "toast", message: `当前已经在 [${inst.num}] ${inst.projectName}` },
                    });
                }

                actionButtons.push({
                    tag: "button",
                    text: { tag: "plain_text", content: "关闭" },
                    type: "danger",
                    value: { action: "close_instance", num: inst.num },
                });

                elements.push({
                    tag: "action",
                    actions: actionButtons,
                });
                elements.push({ tag: "hr" });
            });

            // 底部快捷工具栏
            elements.push({
                tag: "action",
                actions: [
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "新建任务" },
                        type: "primary",
                        value: { action: "quick_cmd", cmd: "新任务" },
                    },
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "智能体列表" },
                        type: "default",
                        value: { action: "quick_cmd", cmd: "智能体" },
                    },
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "帮助菜单" },
                        type: "default",
                        value: { action: "quick_cmd", cmd: "菜单" },
                    },
                ],
            });
        }

        const cardJson = {
            config: { wide_screen_mode: true },
            header: {
                template: "blue",
                title: { tag: "plain_text", content: hasTasks ? `任务列表 (${instances.length} 个任务)` : "任务列表 (空闲待命)" },
            },
            elements,
        };

        await larkClient.im.message.create({
            params: { receive_id_type: "open_id" },
            data: {
                receive_id: targetId,
                msg_type: "interactive",
                content: JSON.stringify(cardJson),
            },
        });
        console.log(`[+] 已向飞书用户 ${targetId} 推送任务列表交互卡片`);
    } catch (err) {
        console.error("[-] 推送飞书任务列表卡片失败:", err.message);
    }
}

/**
 * 向飞书用户发送本机智能体选择与切换卡片
 */
export async function sendFeishuAgentListCard(openId, { detectedAgents, defAgent, activeInst, machineLabel }) {
    if (!larkClient) return;
    const targetId = openId || getLastFeishuUser();
    if (!targetId) return;

    try {
        const elements = [];
        elements.push({
            tag: "div",
            text: {
                tag: "lark_md",
                content: `**当前任务**: [${activeInst.num}] ${activeInst.projectName}\n**当前助手**: **${activeInst.agentName}** (${activeInst.agentKey})\n**生效目录**: \`${activeInst.workDir}\``,
            },
        });
        elements.push({ tag: "hr" });

        if (!detectedAgents || detectedAgents.length === 0) {
            elements.push({
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: "本机未检测到已就绪的 AI 智能体，请先在系统中安装对应 CLI 工具。",
                },
            });
        } else {
            detectedAgents.forEach((agent, idx) => {
                const isGlobalDef = agent.key === defAgent.key;
                const isCurrentActive = agent.key === activeInst.agentKey;
                let tag = "";
                if (isGlobalDef && isCurrentActive) tag = " **[全局默认·当前使用]**";
                else if (isGlobalDef) tag = " **[全局默认]**";
                else if (isCurrentActive) tag = " **[当前任务使用]**";

                elements.push({
                    tag: "div",
                    text: {
                        tag: "lark_md",
                        content: `**[${idx + 1}] ${agent.name}** (\`${agent.key}\`)${tag}`,
                    },
                });

                elements.push({
                    tag: "action",
                    actions: [
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: isCurrentActive ? "当前使用" : "设为当前助手" },
                            type: isCurrentActive ? "default" : "primary",
                            value: isCurrentActive ? { action: "toast", message: `当前任务已在使用 ${agent.name}` } : { action: "switch_agent", key: agent.key, name: agent.name },
                        },
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: isGlobalDef ? "已是全局默认" : "设为全局默认" },
                            type: isGlobalDef ? "default" : "primary",
                            value: isGlobalDef ? { action: "toast", message: `${agent.name} 已经是全局默认` } : { action: "set_default_agent", key: agent.key, name: agent.name },
                        },
                    ],
                });
            });
        }
        elements.push({ tag: "hr" });

        const cardJson = {
            config: { wide_screen_mode: true },
            header: {
                template: "purple",
                title: { tag: "plain_text", content: `本机智能体列表 · ${machineLabel || "本地"}` },
            },
            elements,
        };

        await larkClient.im.message.create({
            params: { receive_id_type: "open_id" },
            data: {
                receive_id: targetId,
                msg_type: "interactive",
                content: JSON.stringify(cardJson),
            },
        });
        console.log(`[+] 已向飞书用户 ${targetId} 推送智能体选择交互卡片`);
    } catch (err) {
        console.error("[-] 推送飞书智能体卡片失败:", err.message);
    }
}

/**
 * 中枢首次启动/连接就绪时向飞书推送环境卡片
 */
export async function sendFeishuOnlineNotice(openId, { machineLabel, defAgent, workDir }) {
    if (!larkClient) return;
    const targetId = openId || getLastFeishuUser();
    if (!targetId) return;

    try {
        const cardJson = {
            config: { wide_screen_mode: true },
            header: {
                template: "turquoise",
                title: { tag: "plain_text", content: "Agent Hub 服务已启动" },
            },
            elements: [
                {
                    tag: "div",
                    text: {
                        tag: "lark_md",
                        content: `**运行设备**: \`${machineLabel || "本地终端"}\`\n**默认智能体**: **${defAgent?.name || "Claude Code"}** (全局默认)\n**全局工作目录**: \`${workDir}\`\n\n已与飞书建立加密长连接通道，直接发送自然语言任务即可开始执行。`,
                    },
                },
                { tag: "hr" },
                {
                    tag: "action",
                    actions: [
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "任务列表" },
                            type: "primary",
                            value: { action: "quick_cmd", cmd: "列表" },
                        },
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "智能体列表" },
                            type: "default",
                            value: { action: "quick_cmd", cmd: "智能体" },
                        },
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "帮助菜单" },
                            type: "default",
                            value: { action: "quick_cmd", cmd: "菜单" },
                        },
                    ],
                },
            ],
        };

        await larkClient.im.message.create({
            params: { receive_id_type: "open_id" },
            data: {
                receive_id: targetId,
                msg_type: "interactive",
                content: JSON.stringify(cardJson),
            },
        });
        console.log(`[+] 已向飞书用户 ${targetId} 推送上线就绪通知卡片`);
    } catch (err) {
        console.error("[-] 推送飞书上线通知失败:", err.message);
    }
}
