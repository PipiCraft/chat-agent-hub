import fs from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";

import {
    ROOT_DIR,
    AUTH_PATH,
    getConfig,
    registerOrUpdateInstance,
} from "./core/state.mjs";
import { shouldNotifyChannel, formatWechatText } from "./channels/common.mjs";

const LAST_FEISHU_USER_PATH = path.join(ROOT_DIR, "last-feishu-user.json");
const LAST_DINGTALK_USER_PATH = path.join(ROOT_DIR, "last-dingtalk-user.json");

const message = process.argv[2];
const agentName = process.argv[3] || "智能体";
const targetPathOrName = process.argv[4] || process.cwd();

if (!message) {
    console.log("用法: node notify.mjs \"消息内容\" [智能体名称] [项目路径/名称]");
    process.exit(1);
}

const config = getConfig();
const lowerName = agentName.toLowerCase();
const agentKey = lowerName.includes("opencode")
    ? "opencode"
    : lowerName.includes("hermes")
    ? "hermes"
    : lowerName.includes("codex")
    ? "codex"
    : lowerName.includes("pi")
    ? "pi"
    : lowerName.includes("openclaw")
    ? "openclaw"
    : "claude";

const inst = registerOrUpdateInstance(agentKey, agentName, targetPathOrName, null, "cli");

const text = [
    `[${inst.projectName}] ${agentName}`,
    message,
    "━━━━━━━━━━━━━━",
    `当前项目: [${inst.num}] ${inst.projectName} (直接回复继续)`,
].join("\n\n");

let sentChannels = 0;

// 1. 推送微信通道 (若配置并已登录)
if (shouldNotifyChannel(config, "wechat") && fs.existsSync(AUTH_PATH)) {
    try {
        const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
        if (auth && auth.botToken && auth.userId) {
            const formattedText = formatWechatText(text);

            const payload = {
                msg: {
                    from_user_id: "",
                    to_user_id: auth.userId,
                    client_id: `cb-cli-${Date.now()}`,
                    message_type: 2,
                    message_state: 2,
                    item_list: [{ type: 1, text_item: { text: formattedText } }],
                },
                base_info: { channel_version: "2.4.8", bot_agent: "OpenClaw" },
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
            const d = await res.json();
            if (d.ret === 0 || d.ret === undefined) {
                console.log("[√] 已成功推送到微信！");
                sentChannels++;
            }
        }
    } catch (e) {
        console.error("[-] 微信推送失败:", e.message);
    }
}

// 2. 推送飞书通道 (若配置启用)
if (shouldNotifyChannel(config, "feishu") && config.channels?.feishu?.appId && config.channels?.feishu?.appSecret) {
    try {
        let receiveIdType = "open_id";
        let feishuTargetId = null;
        if (fs.existsSync(LAST_FEISHU_USER_PATH)) {
            const raw = fs.readFileSync(LAST_FEISHU_USER_PATH, "utf-8").trim();
            if (raw.startsWith("{")) {
                try {
                    const parsed = JSON.parse(raw);
                    feishuTargetId = parsed.openId || parsed.chatId;
                    receiveIdType = feishuTargetId?.startsWith("oc_") ? "chat_id" : "open_id";
                } catch {}
            } else if (raw) {
                feishuTargetId = raw;
                receiveIdType = raw.startsWith("oc_") ? "chat_id" : "open_id";
            }
        }

        if (feishuTargetId) {
            const client = new lark.Client({
                appId: config.channels.feishu.appId,
                appSecret: config.channels.feishu.appSecret,
            });

            await client.im.message.create({
                params: { receive_id_type: receiveIdType },
                data: {
                    receive_id: feishuTargetId,
                    msg_type: "text",
                    content: JSON.stringify({ text }),
                },
            });
            console.log("[√] 已成功推送到飞书！");
            sentChannels++;
        } else {
            console.log("[!] 飞书尚未记录活跃用户，请先在飞书中向机器人发送一条任意消息。");
        }
    } catch (e) {
        console.error("[-] 飞书推送失败:", e.message);
    }
}

// 3. 推送钉钉通道 (若配置启用)
if (shouldNotifyChannel(config, "dingtalk") && fs.existsSync(LAST_DINGTALK_USER_PATH)) {
    try {
        const dtData = JSON.parse(fs.readFileSync(LAST_DINGTALK_USER_PATH, "utf-8"));
        if (dtData?.webhook) {
            const firstLine = text.split("\n")[0].slice(0, 30);
            await fetch(dtData.webhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    msgtype: "markdown",
                    markdown: {
                        title: firstLine || "Agent Hub 通知",
                        text: text,
                    },
                }),
            });
            console.log("[√] 已成功推送到钉钉！");
            sentChannels++;
        }
    } catch (e) {
        console.error("[-] 钉钉推送失败:", e.message);
    }
}

if (sentChannels > 0) {
    console.log(`[+] 当前焦点已锁定为: [${inst.num}] ${inst.projectName} (${agentName})。`);
} else {
    console.warn("[-] 未能推送到任何消息通道，请检查目标通道是否配置启用或有活跃连接。");
}
