import type { Config } from "../types/index.js";

/**
 * 消息渠道公共配置与推送过滤辅助工具
 */
export function normalizeChannelName(input: any): string | null {
    if (!input) return null;
    const s = String(input).trim().toLowerCase();
    if (s === "all" || s === "*" || s === "全部" || s === "所有") return "all";
    if (s === "wechat" || s === "wx" || s === "微信") return "wechat";
    if (s === "feishu" || s === "lark" || s === "飞书") return "feishu";
    if (s === "dingtalk" || s === "ding" || s === "dd" || s === "钉钉") return "dingtalk";
    return s;
}

export function getChannelDisplayName(channelKey: string): string {
    switch (channelKey) {
        case "wechat": return "微信";
        case "feishu": return "飞书";
        case "dingtalk": return "钉钉";
        default: return channelKey;
    }
}

export interface ChannelNotifyStatusItem {
    key: string;
    name: string;
    enabled: boolean;
    willNotify: boolean;
}

/**
 * 判断本地启动的任务是否应当向指定渠道发送通知
 */
export function shouldNotifyChannel(cfg: Config, channelName: string): boolean {
    const ch = normalizeChannelName(channelName);
    if (!ch || ch === "all") return false;

    // 1. 检查该渠道是否已在 channels 配置中启用
    const channelConf = (cfg?.channels as any)?.[ch];
    if (!channelConf || !channelConf.enabled) return false;

    // 2. 检查本地任务推送白名单配置 notifyChannels
    const notifySetting = cfg?.notifyChannels;
    if (!notifySetting) return true;

    let targets: string[] = [];
    if (Array.isArray(notifySetting)) {
        targets = notifySetting.map(normalizeChannelName).filter((x): x is string => Boolean(x));
    } else if (typeof notifySetting === "string") {
        targets = (notifySetting as string).split(/[,，\s]+/).map(normalizeChannelName).filter((x): x is string => Boolean(x));
    }

    if (targets.length === 0 || targets.includes("all")) {
        return true;
    }

    return targets.includes(ch);
}

/**
 * 获取当前有效的本地任务推送渠道列表及状态
 */
export function getChannelNotifyStatus(cfg: Config): ChannelNotifyStatusItem[] {
    const allChannels = [
        { key: "wechat", name: "微信" },
        { key: "feishu", name: "飞书" },
        { key: "dingtalk", name: "钉钉" },
    ];

    return allChannels.map((c) => {
        const chConf = (cfg?.channels as any)?.[c.key];
        const isEnabled = Boolean(chConf?.enabled);
        const willNotify = shouldNotifyChannel(cfg, c.key);
        return {
            ...c,
            enabled: isEnabled,
            willNotify,
        };
    });
}

/**
 * 格式化微信文本消息，确保在 Windows 电脑端微信及手机端均能正常换行显示
 */
export function formatWechatText(rawText: string): string {
    if (!rawText) return "";
    const str = String(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const parts = str.split(/(```[\s\S]*?```)/g);
    const formattedParts = parts.map((part) => {
        if (part.startsWith("```")) {
            return part.trim();
        }
        const lines = part
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        return lines.join("\n\n");
    });

    const joined = formattedParts
        .filter((p) => p.length > 0)
        .join("\n\n")
        .replace(/\n{3,}/g, "\n\n");

    return joined.replace(/\n/g, "\r\n");
}
