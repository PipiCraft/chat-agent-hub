/**
 * 消息渠道公共配置与推送过滤辅助工具
 */

export function normalizeChannelName(input) {
    if (!input) return null;
    const s = String(input).trim().toLowerCase();
    if (s === "all" || s === "*" || s === "全部" || s === "所有") return "all";
    if (s === "wechat" || s === "wx" || s === "微信") return "wechat";
    if (s === "feishu" || s === "lark" || s === "飞书") return "feishu";
    if (s === "dingtalk" || s === "ding" || s === "dd" || s === "钉钉") return "dingtalk";
    return s;
}

export function getChannelDisplayName(channelKey) {
    switch (channelKey) {
        case "wechat": return "微信";
        case "feishu": return "飞书";
        case "dingtalk": return "钉钉";
        default: return channelKey;
    }
}

/**
 * 判断本地启动的任务是否应当向指定渠道发送通知
 * @param {Object} cfg - config.json 配置对象
 * @param {string} channelName - "wechat" | "feishu" | "dingtalk"
 * @returns {boolean}
 */
export function shouldNotifyChannel(cfg, channelName) {
    const ch = normalizeChannelName(channelName);
    if (!ch || ch === "all") return false;

    // 1. 检查该渠道是否已在 channels 配置中启用
    const channelConf = cfg?.channels?.[ch];
    if (ch === "wechat") {
        if (channelConf && channelConf.enabled === false) return false;
    } else {
        if (!channelConf || !channelConf.enabled) return false;
    }

    // 2. 检查本地任务推送白名单配置 notifyChannels
    const notifySetting = cfg?.notifyChannels;
    if (!notifySetting) return true; // 默认全部已启用的渠道

    let targets = [];
    if (Array.isArray(notifySetting)) {
        targets = notifySetting.map(normalizeChannelName).filter(Boolean);
    } else if (typeof notifySetting === "string") {
        targets = notifySetting.split(/[,，\s]+/).map(normalizeChannelName).filter(Boolean);
    }

    if (targets.length === 0 || targets.includes("all")) {
        return true;
    }

    return targets.includes(ch);
}

/**
 * 获取当前有效的本地任务推送渠道列表及状态
 * @param {Object} cfg
 * @returns {Array<{ key: string, name: string, enabled: boolean, willNotify: boolean }>}
 */
export function getChannelNotifyStatus(cfg) {
    const allChannels = [
        { key: "wechat", name: "微信" },
        { key: "feishu", name: "飞书" },
        { key: "dingtalk", name: "钉钉" },
    ];

    return allChannels.map((c) => {
        const chConf = cfg?.channels?.[c.key];
        const isEnabled = c.key === "wechat" ? (chConf?.enabled !== false) : Boolean(chConf?.enabled);
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
 * 原理：
 * 1. 电脑端微信基于 CommonMark 规范渲染，单换行默认被视为空格折叠。
 * 2. 微信服务端 (ilink) 会自动裁剪行末空格，导致 Markdown 标准的行尾双空格硬换行失效。
 * 3. 通过将普通文本每行转换为独立段落 (双换行)，可 100% 保证在 PC 微信客户端正常分行；
 * 4. 同时保持 Markdown 代码块 (```) 内部格式与换行不受影响。
 * 
 * @param {string} rawText
 * @returns {string}
 */
export function formatWechatText(rawText) {
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

