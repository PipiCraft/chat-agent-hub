import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as lark from "@larksuiteoapi/node-sdk";

import {
    AUTH_PATH,
    LAST_FEISHU_USER_PATH,
    LAST_DINGTALK_USER_PATH,
    getConfig,
    getPendingQuestions,
    savePendingQuestions,
    allocateReqId,
    registerOrUpdateInstance,
} from "./core/state.js";
import { shouldNotifyChannel, formatWechatText } from "./channels/common.js";

const baseInfo = {
    channel_version: "2.4.8",
    bot_agent: "OpenClaw",
};

function getAuth() {
    if (!fs.existsSync(AUTH_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
    } catch {
        return null;
    }
}

async function sendToFeishu(text: string): Promise<boolean | null> {
    try {
        const conf = getConfig();
        const feishuConf = conf.channels?.feishu;
        if (!feishuConf || !feishuConf.enabled || !feishuConf.appId || !feishuConf.appSecret) return null;
        if (!fs.existsSync(LAST_FEISHU_USER_PATH)) return null;
        const raw = fs.readFileSync(LAST_FEISHU_USER_PATH, "utf-8").trim();
        if (!raw) return null;

        let receiveIdType = "open_id";
        let receiveId = raw;
        if (raw.startsWith("{")) {
            try {
                const parsed = JSON.parse(raw);
                receiveId = parsed.openId || parsed.chatId;
                receiveIdType = receiveId?.startsWith("oc_") ? "chat_id" : "open_id";
            } catch {}
        } else if (raw.startsWith("oc_")) {
            receiveIdType = "chat_id";
        }

        if (!receiveId) return null;

        const larkClient = new lark.Client({ appId: feishuConf.appId, appSecret: feishuConf.appSecret });
        await larkClient.im.message.create({
            params: { receive_id_type: receiveIdType as any },
            data: {
                receive_id: receiveId,
                msg_type: "text",
                content: JSON.stringify({ text }),
            },
        });
        return true;
    } catch {
        return null;
    }
}

async function sendToDingtalk(content: string): Promise<boolean | null> {
    if (!fs.existsSync(LAST_DINGTALK_USER_PATH)) return null;
    try {
        const conf = getConfig();
        if (!conf.channels?.dingtalk?.enabled) return null;
        const dtData = JSON.parse(fs.readFileSync(LAST_DINGTALK_USER_PATH, "utf-8"));
        if (!dtData?.webhook) return null;

        const firstLine = content.split("\n")[0].slice(0, 30);
        await fetch(dtData.webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                msgtype: "markdown",
                markdown: {
                    title: firstLine || "Agent Hub 通知",
                    text: content,
                },
            }),
        });
        return true;
    } catch {
        return null;
    }
}

async function sendToWechat(text: string): Promise<any> {
    const auth = getAuth();
    if (!auth || !auth.botToken || !auth.baseUrl) return null;

    const formattedText = formatWechatText(text);

    const payload = {
        msg: {
            from_user_id: "",
            to_user_id: auth.userId,
            client_id: `cb-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            message_type: 2,
            message_state: 2,
            item_list: [
                {
                    type: 1,
                    text_item: {
                        text: formattedText,
                    },
                },
            ],
        },
        base_info: baseInfo,
    };

    const res = await fetch(`${auth.baseUrl}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": "132104",
            "X-WECHAT-UIN": Buffer.from(String(12345678)).toString("base64"),
            "AuthorizationType": "ilink_bot_token",
            "Authorization": `Bearer ${auth.botToken.trim()}`,
        },
        body: JSON.stringify(payload),
    });

    const data = await res.json() as any;
    if (data.ret !== undefined && data.ret !== 0) {
        throw new Error(`微信发送失败: ${JSON.stringify(data)}`);
    }
    return data;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

function sendResponse(response: any): void {
    process.stdout.write(JSON.stringify(response) + "\n");
}

rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch (e) {
        return;
    }

    const { id, method, params } = msg;

    if (method === "initialize") {
        sendResponse({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "agent-hub", version: "2.0.0" },
            },
        });
        return;
    }

    if (method === "notifications/initialized") return;

    if (method === "ping") {
        sendResponse({ jsonrpc: "2.0", id, result: {} });
        return;
    }

    // 精简 MCP 工具列表：仅暴露核心的 notify_agent 与 ask_agent
    if (method === "tools/list") {
        sendResponse({
            jsonrpc: "2.0",
            id,
            result: {
                tools: [
                    {
                        name: "notify_agent",
                        description: "向用户的手机移动端（微信/飞书/钉钉）发送任务完成汇报、进度或重要通知。发送后会自动锁定上下文，用户回复将自动路由回当前智能体。",
                        inputSchema: {
                            type: "object",
                            properties: {
                                message: {
                                    type: "string",
                                    description: "要发送给用户的汇报或通知内容",
                                },
                                agent: {
                                    type: "string",
                                    description: "当前智能体名称（如 Claude Code, OpenCode, Hermes 等），默认为 Claude Code",
                                },
                            },
                            required: ["message"],
                        },
                    },
                    {
                        name: "ask_agent",
                        description: "向用户的手机移动端发起方案决策或人机确认请示，并挂起等待用户在手机上的确认或选项答复。适用于需要用户确认、二选一决策或重大变更审批场景。",
                        inputSchema: {
                            type: "object",
                            properties: {
                                question: {
                                    type: "string",
                                    description: "向用户提问的具体问题或需要确认的事项",
                                },
                                options: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "可选的备选方案/选项列表。提供时飞书将生成交互按钮，微信/钉钉生成数字编号供用户快捷回复。",
                                },
                                agent: {
                                    type: "string",
                                    description: "当前智能体名称，默认为 Claude Code",
                                },
                                timeout_seconds: {
                                    type: "number",
                                    description: "等待用户回复的超时时间（秒），默认 300 秒",
                                },
                            },
                            required: ["question"],
                        },
                    },
                ],
            },
        });
        return;
    }

    if (method === "tools/call") {
        const { name, arguments: args } = params || {};

        // 统一处理 notify_agent 及旧别名 notify_wechat
        if (name === "notify_agent" || name === "notify_wechat") {
            const message = args?.message || "任务已执行完毕。";
            const agentName = args?.agent || "Claude Code";
            const agentKey = agentName.toLowerCase().includes("opencode") ? "opencode" : agentName.toLowerCase().includes("hermes") ? "hermes" : "claude";
            const workDir = args?.workDir || process.cwd();
            const customProject = args?.project;

            try {
                const inst = registerOrUpdateInstance(agentKey, agentName, workDir, customProject, "desktop");

                const wechatContent = [
                    `[${inst.projectName}] ${agentName}`,
                    message,
                    "━━━━━━━━━━━━━━",
                    `当前项目: [${inst.num}] ${inst.projectName} (直接回复继续)`,
                ].join("\n\n");

                const conf = getConfig();
                const pushTasks: Promise<any>[] = [];
                const pushedChannels: string[] = [];

                if (shouldNotifyChannel(conf, "wechat")) {
                    pushTasks.push(
                        sendToWechat(wechatContent).then((res) => {
                            if (res) pushedChannels.push("微信");
                        })
                    );
                }
                if (shouldNotifyChannel(conf, "feishu")) {
                    pushTasks.push(
                        sendToFeishu(wechatContent).then((res) => {
                            if (res) pushedChannels.push("飞书");
                        })
                    );
                }
                if (shouldNotifyChannel(conf, "dingtalk")) {
                    pushTasks.push(
                        sendToDingtalk(wechatContent).then((res) => {
                            if (res) pushedChannels.push("钉钉");
                        })
                    );
                }

                await Promise.allSettled(pushTasks);

                const targetDesc = pushedChannels.length > 0 ? ` (${pushedChannels.join("、")})` : "";
                sendResponse({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: `已推送到手机移动端${targetDesc} (项目: [${inst.num}] ${inst.projectName})`,
                            },
                        ],
                    },
                });
            } catch (err: any) {
                sendResponse({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `推送失败: ${err?.message}` }],
                        isError: true,
                    },
                });
            }
            return;
        }

        // 统一处理 ask_agent 及旧别名 ask_wechat
        if (name === "ask_agent" || name === "ask_wechat") {
            const question = args?.question || "请确认是否继续？";
            const options = Array.isArray(args?.options) && args.options.length > 0 ? args.options : null;
            const agentName = args?.agent || "Claude Code";
            const agentKey = agentName.toLowerCase().includes("opencode") ? "opencode" : agentName.toLowerCase().includes("hermes") ? "hermes" : "claude";
            const workDir = args?.workDir || process.cwd();
            const customProject = args?.project;
            const timeoutSeconds = args?.timeout_seconds || 300;

            try {
                const inst = registerOrUpdateInstance(agentKey, agentName, workDir, customProject, "desktop");
                const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                const reqId = allocateReqId();

                const conf = getConfig();
                const questions = getPendingQuestions();
                const questionObj = {
                    reqId,
                    id: questionId,
                    instanceId: inst.id,
                    question,
                    options,
                    agent: agentKey,
                    agentName,
                    projectName: inst.projectName,
                    createdAt: Date.now(),
                    timeoutMs: timeoutSeconds * 1000,
                    answered: false,
                    answer: null,
                    feishuPushed: false,
                    dingtalkPushed: false,
                };
                questions.push(questionObj);
                savePendingQuestions(questions);

                let optionsText = "";
                if (options && options.length > 0) {
                    optionsText = "\n\n备选方案：\n" + options.map((opt: any, idx: number) => `[${idx + 1}] ${opt}`).join("\n");
                }

                const replyGuide = options && options.length > 0
                    ? `回复方式:\n• 回复编号「1」～「${options.length}」快速选定\n• 回复「拒绝 ${reqId}」终止\n• 或回复「#${reqId} 你的说明」`
                    : `回复方式:\n• 同意 ${reqId} / 允许 ${reqId}\n• 拒绝 ${reqId}\n• 或回复「#${reqId} 你的说明」`;

                const wechatContent = [
                    `[${inst.projectName} 询问 #${reqId}]`,
                    `${question}${optionsText}`,
                    "━━━━━━━━━━━━━━",
                    replyGuide,
                    `(${timeoutSeconds}s 内有效)`,
                ].join("\n\n");

                const askTasks: Promise<any>[] = [];
                if (shouldNotifyChannel(conf, "wechat")) {
                    askTasks.push(sendToWechat(wechatContent));
                }
                if (shouldNotifyChannel(conf, "dingtalk")) {
                    askTasks.push(sendToDingtalk(wechatContent));
                }
                await Promise.allSettled(askTasks);

                const startTime = Date.now();
                const timeoutMs = timeoutSeconds * 1000;
                let userReply = null;

                while (Date.now() - startTime < timeoutMs) {
                    await new Promise((r) => setTimeout(r, 1000));
                    const currentQuestions = getPendingQuestions();
                    const targetQ = currentQuestions.find((q) => q.id === questionId);
                    if (targetQ && targetQ.answered) {
                        userReply = targetQ.answer;
                        break;
                    }
                }

                const remaining = getPendingQuestions().filter((q) => q.id !== questionId);
                savePendingQuestions(remaining);

                if (userReply !== null) {
                    sendResponse({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: `收到移动端用户回复: ${userReply}`,
                                },
                            ],
                        },
                    });
                } else {
                    sendResponse({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: `等待超时 (${timeoutSeconds}s)，用户未在移动端回复。`,
                                },
                            ],
                            isError: true,
                        },
                    });
                }
            } catch (err: any) {
                sendResponse({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: `执行异常: ${err?.message}` }],
                        isError: true,
                    },
                });
            }
            return;
        }

        sendResponse({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${name}` },
        });
    }
});
