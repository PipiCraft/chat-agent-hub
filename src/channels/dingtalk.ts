import fs from "node:fs";
import path from "node:path";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import { LAST_DINGTALK_USER_PATH } from "../core/state.js";

let dwClient: any = null;
let lastSessionWebhook: any = null;
let lastSenderId: any = null;

const LAST_USER_FILE = LAST_DINGTALK_USER_PATH;

export function getLastDingtalkTarget() {
    if (lastSessionWebhook) return { webhook: lastSessionWebhook, userId: lastSenderId };
    try {
        if (fs.existsSync(LAST_USER_FILE)) {
            const data = JSON.parse(fs.readFileSync(LAST_USER_FILE, "utf-8"));
            lastSessionWebhook = data.webhook;
            lastSenderId = data.userId;
            return data;
        }
    } catch {}
    return null;
}

/**
 * 初始化钉钉 Stream 模式长连接通道 (免公网 IP 直连)
 * @param {Object} options
 * @param {Object} options.config - 钉钉配置 { clientId, clientSecret }
 * @param {Function} options.onMessage - 收到消息回调 ({ channel, userId, text, replyContext })
 */
export async function initDingtalkChannel({ config, onMessage }: any) {
    if (!config || !config.clientId || !config.clientSecret) {
        console.warn("[!] 钉钉配置缺失 (clientId 或 clientSecret 未填)，跳过钉钉通道启动。");
        return null;
    }

    try {
        dwClient = new DWClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
        });

        // 监听机器人消息接收
        dwClient.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
            try {
                // 必须向服务端返回 ACK 响应，避免 60 秒内服务端重试投递
                dwClient.socketCallBackResponse(res.headers.messageId, { status: "SUCCESS" });

                const data = typeof res.data === "string" ? JSON.parse(res.data) : (res.data || {});
                const rawText = (data.text?.content || "").trim();
                const senderId = data.senderStaffId || data.senderId || "unknown";
                const sessionWebhook = data.sessionWebhook;

                if (!rawText) return;

                if (sessionWebhook) {
                    lastSessionWebhook = sessionWebhook;
                    lastSenderId = senderId;
                    try {
                        fs.writeFileSync(LAST_USER_FILE, JSON.stringify({ webhook: sessionWebhook, userId: senderId }, null, 2), "utf-8");
                    } catch {}
                }

                console.log(`\n[收到钉钉指令]: "${rawText}" (来自: ${senderId})`);

                if (onMessage) {
                    onMessage({
                        channel: "dingtalk",
                        userId: senderId,
                        text: rawText,
                        replyContext: { senderId, sessionWebhook, conversationId: data.conversationId },
                    });
                }
            } catch (err: any) {
                console.error("[-] 钉钉机器人消息处理异常:", err.message);
            }
        });

        await dwClient.connect();
        console.log("[+] 钉钉长连接接入成功");
        return { client: dwClient };
    } catch (err: any) {
        console.error("[-] 钉钉通道启动异常:", err.message);
        return null;
    }
}

/**
 * 向钉钉用户发送消息回复 (优先走 Session Webhook，极速且免鉴权)
 */
export async function sendDingtalkReply(replyTarget: any, text: any) {
    let webhook = null;
    if (replyTarget && typeof replyTarget === "object" && replyTarget.sessionWebhook) {
        webhook = replyTarget.sessionWebhook;
    } else if (replyTarget && typeof replyTarget === "string" && replyTarget.startsWith("http")) {
        webhook = replyTarget;
    } else {
        const last = getLastDingtalkTarget();
        webhook = last?.webhook;
    }

    if (!webhook) {
        console.warn("[!] 钉钉回复目标 webhook 为空，请先在钉钉中向机器人发送一条消息。");
        return;
    }

    try {
        // 使用 Markdown 格式渲染钉钉消息
        const firstLine = text.split("\n")[0].slice(0, 30);
        const res = await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                msgtype: "markdown",
                markdown: {
                    title: firstLine || "Agent Hub 回复",
                    text: text,
                },
            }),
            signal: AbortSignal.timeout(8000),
        });
        const d = await res.json();
        if (d.errcode && d.errcode !== 0) {
            throw new Error(`DingTalk error ${d.errcode}: ${d.errmsg}`);
        }
    } catch (err: any) {
        // 若 markdown 发送受限，兜底降级为纯文本
        try {
            await fetch(webhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    msgtype: "text",
                    text: { content: text },
                }),
                signal: AbortSignal.timeout(5000),
            });
        } catch (e: any) {
            console.error("[-] 发送钉钉消息失败:", e.message);
        }
    }
}

/**
 * 向钉钉推送审批请示
 */
export async function sendDingtalkApprovalCard(replyTarget: any, { reqId, question, options, projectName, agentName, timeoutSeconds = 300 }: any) {
    let optionsText = "";
    if (Array.isArray(options) && options.length > 0) {
        optionsText = "\n\n**可选方案**:\n" + options.map((opt, idx) => `${idx + 1}. ${opt}`).join("\n");
        optionsText += `\n\n*(请回复数字编号如「1」或「同意 ${reqId}」/「拒绝 ${reqId}」)*`;
    } else {
        optionsText = `\n\n*(请回复「同意 ${reqId}」或「拒绝 ${reqId}」)*`;
    }

    const cardMarkdown = [
        `### [${projectName || "项目"}] 审批请示 #${reqId}`,
        `**发起智能体**: ${agentName || "Claude Code"}`,
        `**请示事项**: ${question}`,
        optionsText,
    ].join("\n\n");

    await sendDingtalkReply(replyTarget, cardMarkdown);
}
