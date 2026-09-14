import fs from "node:fs";
import * as lark from "@larksuiteoapi/node-sdk";
import {
    AUTH_PATH,
    LAST_FEISHU_USER_PATH,
    LAST_DINGTALK_USER_PATH,
    getConfig,
} from "../core/state.js";
import { shouldNotifyChannel, formatWechatText } from "./common.js";

export interface PushResult {
    success: boolean;
    pushedChannels: string[];
    failedChannels: string[];
}

const baseInfo = { channel_version: "2.4.8", bot_agent: "OpenClaw" };

export async function pushToWechat(text: string): Promise<boolean> {
    if (!fs.existsSync(AUTH_PATH)) return false;
    try {
        const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
        if (!auth?.botToken || !auth?.userId || !auth?.baseUrl) return false;

        const formattedText = formatWechatText(text);
        const payload = {
            msg: {
                from_user_id: "",
                to_user_id: auth.userId,
                client_id: `cb-push-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                message_type: 2,
                message_state: 2,
                item_list: [{ type: 1, text_item: { text: formattedText } }],
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
        const d = (await res.json()) as any;
        return d.ret === 0 || d.ret === undefined;
    } catch {
        return false;
    }
}

export async function pushToFeishu(text: string): Promise<boolean> {
    const conf = getConfig();
    const feishuConf = conf.channels?.feishu;
    if (!feishuConf?.appId || !feishuConf?.appSecret) return false;

    try {
        let receiveIdType: "open_id" | "chat_id" = "open_id";
        let receiveId: string | null = null;

        if (fs.existsSync(LAST_FEISHU_USER_PATH)) {
            const raw = fs.readFileSync(LAST_FEISHU_USER_PATH, "utf-8").trim();
            if (raw.startsWith("{")) {
                try {
                    const parsed = JSON.parse(raw);
                    receiveId = parsed.openId || parsed.chatId;
                    if (receiveId?.startsWith("oc_")) receiveIdType = "chat_id";
                } catch {}
            } else if (raw) {
                receiveId = raw;
                if (raw.startsWith("oc_")) receiveIdType = "chat_id";
            }
        }

        if (!receiveId && feishuConf.defaultChatId) {
            receiveId = feishuConf.defaultChatId;
            receiveIdType = "chat_id";
        }

        if (!receiveId) return false;

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
        return false;
    }
}

export async function pushToDingtalk(text: string): Promise<boolean> {
    if (!fs.existsSync(LAST_DINGTALK_USER_PATH)) return false;
    try {
        const conf = getConfig();
        if (!conf.channels?.dingtalk?.enabled) return false;
        const dtData = JSON.parse(fs.readFileSync(LAST_DINGTALK_USER_PATH, "utf-8"));
        if (!dtData?.webhook) return false;

        const firstLine = text.split("\n")[0].slice(0, 30);
        const res = await fetch(dtData.webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                msgtype: "markdown",
                markdown: {
                    title: firstLine || "Agent Hub 通知",
                    text,
                },
            }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 统一多通道推送网关
 */
export async function pushToActiveChannels(text: string): Promise<PushResult> {
    const conf = getConfig();
    const pushedChannels: string[] = [];
    const failedChannels: string[] = [];
    const tasks: Promise<any>[] = [];

    if (shouldNotifyChannel(conf, "wechat")) {
        tasks.push(
            pushToWechat(text).then((ok) => {
                if (ok) pushedChannels.push("微信");
                else failedChannels.push("微信");
            })
        );
    }

    if (shouldNotifyChannel(conf, "feishu")) {
        tasks.push(
            pushToFeishu(text).then((ok) => {
                if (ok) pushedChannels.push("飞书");
                else failedChannels.push("飞书");
            })
        );
    }

    if (shouldNotifyChannel(conf, "dingtalk")) {
        tasks.push(
            pushToDingtalk(text).then((ok) => {
                if (ok) pushedChannels.push("钉钉");
                else failedChannels.push("钉钉");
            })
        );
    }

    await Promise.allSettled(tasks);

    return {
        success: pushedChannels.length > 0,
        pushedChannels,
        failedChannels,
    };
}
