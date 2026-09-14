import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import qrcodeTerminal from "qrcode-terminal";
import pc from "picocolors";
import * as p from "@clack/prompts";
import { formatWechatText } from "./common.js";
import type { WechatAuth } from "../types/index.js";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = 132104;

const baseInfo = {
    channel_version: "2.4.8",
    bot_agent: "OpenClaw",
};

let currentAuth: WechatAuth | null = null;
let lastKnownUserId: string | null = null;

function randomWechatUin(): string {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function commonHeaders(token: string | null = null): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
        "X-WECHAT-UIN": randomWechatUin(),
    };
    if (token) {
        headers["AuthorizationType"] = "ilink_bot_token";
        headers["Authorization"] = `Bearer ${token.trim()}`;
    }
    return headers;
}

// 扫码登录流程（使用 @clack/prompts 原生 p.note + p.spinner，不侵入篡改底层 stdin/rawMode）
export async function loginWechatFlow(
    authPath?: string,
    onExitConfirm?: () => Promise<boolean>
): Promise<WechatAuth | null> {
    let qrData: any;
    try {
        const qrRes = await fetch(`${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
            method: "POST",
            headers: commonHeaders(),
            body: JSON.stringify({ local_token_list: [], base_info: baseInfo }),
        });
        qrData = (await qrRes.json()) as any;
        if (!qrData.qrcode || !qrData.qrcode_img_content) {
            throw new Error("获取二维码失败: " + JSON.stringify(qrData));
        }
    } catch (err: any) {
        throw new Error("向微信服务器请求登录二维码失败: " + (err?.message || err));
    }

    let qrAscii = "";
    qrcodeTerminal.generate(qrData.qrcode_img_content, { small: true }, (code) => {
        qrAscii = code.trim();
    });

    p.note(
        [
            pc.bold("请使用手机微信扫描下方二维码绑定账号:"),
            "",
            qrAscii,
            "",
            `备用链接: ${pc.cyan(qrData.qrcode_img_content)}`,
            pc.dim("提示: 扫码后请在手机微信上点击「确认授权」 (按 Ctrl+C 可取消)"),
        ].join("\n"),
        "微信通道扫码登录授权"
    );

    const s = p.spinner();
    s.start("等待手机微信扫码中...");

    let currentBaseUrl = FIXED_BASE_URL;
    let isCancelled = false;

    const sigintHandler = async () => {
        if (onExitConfirm) {
            s.stop();
            const shouldExit = await onExitConfirm();
            if (shouldExit) {
                isCancelled = true;
            } else {
                s.start("继续等待手机微信扫码中...");
                process.once("SIGINT", sigintHandler);
            }
        } else {
            isCancelled = true;
        }
    };

    if (onExitConfirm) {
        process.once("SIGINT", sigintHandler);
    }

    try {
        while (!isCancelled) {
            try {
                const pollRes = await fetch(
                    `${currentBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrData.qrcode)}`,
                    {
                        method: "GET",
                        headers: {
                            "iLink-App-Id": ILINK_APP_ID,
                            "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
                        },
                    }
                );
                const statusData = (await pollRes.json()) as any;

                if (statusData.status === "confirmed") {
                    s.stop(pc.green("微信扫码授权成功！已绑定微信账号。"));
                    const authInfo: WechatAuth = {
                        botToken: statusData.bot_token,
                        baseUrl: statusData.baseurl || FIXED_BASE_URL,
                        userId: statusData.ilink_user_id,
                    };
                    if (authPath) {
                        fs.writeFileSync(authPath, JSON.stringify(authInfo, null, 2), "utf-8");
                    }
                    currentAuth = authInfo;
                    return authInfo;
                } else if (statusData.status === "scaned") {
                    s.message(pc.cyan("手机已扫码，请在手机上点击确认授权..."));
                } else if (statusData.status === "scaned_but_redirect" && statusData.redirect_host) {
                    currentBaseUrl = `https://${statusData.redirect_host}`;
                } else if (statusData.status === "expired") {
                    s.stop(pc.red("二维码已过期，请重新进入微信管理菜单扫码。"));
                    return null;
                }
            } catch (e: any) {
                // 忽略网络瞬时抖动，继续轮询
            }

            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        s.stop(pc.yellow("微信扫码登录已取消。"));
        return null;
    } finally {
        if (onExitConfirm) {
            process.removeListener("SIGINT", sigintHandler);
        }
    }
}

// 发送单条消息到微信（深度兼容 Windows 电脑端微信 Markdown 渲染规范）
async function sendSingleWechatMessage(auth: WechatAuth | null, toUserId: string, text: string, contextToken?: string): Promise<void> {
    const activeAuth = auth || currentAuth;
    if (!activeAuth) return;

    const formattedText = formatWechatText(text);

    const payload = {
        msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: `cb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            message_type: 2,
            message_state: 2,
            item_list: [
                {
                    type: 1,
                    text_item: { text: formattedText },
                },
            ],
            context_token: contextToken,
        },
        base_info: baseInfo,
    };

    try {
        const res = await fetch(`${activeAuth.baseUrl}/ilink/bot/sendmessage`, {
            method: "POST",
            headers: commonHeaders(activeAuth.botToken),
            body: JSON.stringify(payload),
        });
        const d = await res.json() as any;
        if (d.ret !== undefined && d.ret !== 0) {
            console.error("[-] 发送微信消息返回错误:", JSON.stringify(d));
        }
    } catch (err: any) {
        console.error("[-] 发送微信回复异常:", err?.message);
    }
}

// 发送消息到微信（支持超长内容智能分片 + 保存至 latest_result.md）
export async function sendWechatReply(auth: WechatAuth | null, toUserId: string | null, content: string, contextToken?: string, workDir: string | null = null): Promise<void> {
    if (!content) return;
    const targetUserId = toUserId || lastKnownUserId;
    if (!targetUserId) return;

    if (content.length > 1800 && workDir) {
        try {
            const outPath = path.join(workDir, "latest_result.md");
            fs.writeFileSync(outPath, content, "utf-8");
        } catch {}
    }

    if (content.length <= 1800) {
        await sendSingleWechatMessage(auth, targetUserId, content, contextToken);
        return;
    }

    const CHUNK_SIZE = 1700;
    const totalChunks = Math.ceil(content.length / CHUNK_SIZE);
    const maxSend = Math.min(totalChunks, 3);

    for (let i = 0; i < maxSend; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, content.length);
        let chunkText = content.slice(start, end);

        if (totalChunks > 1) {
            const isLast = (i === maxSend - 1);
            if (isLast && totalChunks > maxSend) {
                chunkText = `(${i + 1}/${totalChunks})\n` + chunkText + `\n\n[完整输出已保存至 workspace/latest_result.md]`;
            } else {
                chunkText = `(${i + 1}/${totalChunks})\n` + chunkText;
            }
        }

        await sendSingleWechatMessage(auth, targetUserId, chunkText, contextToken);
        if (i < maxSend - 1) {
            await new Promise((r) => setTimeout(r, 600));
        }
    }
}

export interface StartWechatOptions {
    authPath?: string;
    syncPath?: string;
    onMessage?: (msg: { channel: string; userId: string; text: string; contextToken?: string }) => void;
}

// 启动微信轮询监听
export async function startWechatChannel({ authPath, syncPath, onMessage }: StartWechatOptions) {
    let auth: WechatAuth | null = null;
    if (authPath && fs.existsSync(authPath)) {
        try {
            auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        } catch {}
    }

    if (!auth || !auth.botToken) {
        auth = await loginWechatFlow(authPath);
        if (!auth) {
            console.log(pc.yellow("[!] 微信扫码登录已取消。"));
            return null;
        }
    }
    currentAuth = auth;
    console.log(`[+] 微信通道已激活`);

    let syncBuf = "";
    if (syncPath && fs.existsSync(syncPath)) {
        try {
            syncBuf = fs.readFileSync(syncPath, "utf-8").trim();
        } catch {}
    }

    (async () => {
        while (true) {
            try {
                const res = await fetch(`${auth!.baseUrl}/ilink/bot/getupdates`, {
                    method: "POST",
                    headers: commonHeaders(auth!.botToken),
                    body: JSON.stringify({
                        get_updates_buf: syncBuf,
                        base_info: baseInfo,
                    }),
                });
                const data = await res.json() as any;

                const isError =
                    (data.ret !== undefined && data.ret !== 0) ||
                    (data.errcode !== undefined && data.errcode !== 0);

                if (!isError) {
                    if (data.get_updates_buf && syncPath) {
                        syncBuf = data.get_updates_buf;
                        fs.writeFileSync(syncPath, syncBuf, "utf-8");
                    }

                    if (Array.isArray(data.msgs) && data.msgs.length > 0) {
                        for (const msg of data.msgs) {
                            const fromUser = msg.from_user_id;
                            const textItem = msg.item_list?.find((i: any) => i.type === 1);
                            const rawText = textItem?.text_item?.text?.trim();
                            if (!rawText) continue;

                            lastKnownUserId = fromUser;
                            console.log(`\n[微信消息]: "${rawText}" (来自: ${fromUser})`);

                            if (onMessage) {
                                onMessage({
                                    channel: "wechat",
                                    userId: fromUser,
                                    text: rawText,
                                    contextToken: msg.context_token,
                                });
                            }
                        }
                    }
                } else if (data.ret === 40001 || data.errcode === 40001) {
                    console.warn("[!] 微信凭证失效，正在重新登录...");
                    if (authPath && fs.existsSync(authPath)) fs.unlinkSync(authPath);
                    const newAuth = await loginWechatFlow(authPath);
                    if (newAuth) {
                        auth = newAuth;
                        currentAuth = auth;
                    }
                } else {
                    await new Promise((r) => setTimeout(r, 2000));
                }
            } catch (err: any) {
                console.error("[-] 微信轮询异常:", err?.message);
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
    })();

    return { auth, sendReply: sendWechatReply };
}
