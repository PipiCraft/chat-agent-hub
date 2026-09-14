import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerOrUpdateInstance } from "./core/state.js";
import { pushToActiveChannels } from "./channels/dispatcher.js";
import { resolveAgentKey } from "./core/runner.js";

export async function sendNotification(
    message: string,
    agentName: string = "智能体",
    targetPathOrName: string = process.cwd()
): Promise<boolean> {
    const agentKey = resolveAgentKey(agentName);
    const inst = registerOrUpdateInstance(agentKey, agentName, targetPathOrName, undefined, "cli");

    const text = [
        `[${inst.projectName}] ${agentName}`,
        message,
        "━━━━━━━━━━━━━━",
        `当前项目: [${inst.num}] ${inst.projectName} (直接回复继续)`,
    ].join("\n\n");

    const pushRes = await pushToActiveChannels(text);

    if (pushRes.success) {
        console.log(`[√] 已成功推送到: ${pushRes.pushedChannels.join("、")}`);
        console.log(`[+] 当前焦点已锁定为: [${inst.num}] ${inst.projectName} (${agentName})。`);
        return true;
    } else {
        const attempted = pushRes.failedChannels.length > 0 ? ` (尝试渠道: ${pushRes.failedChannels.join("、")})` : "";
        console.warn(`[-] 未能推送到任何消息通道${attempted}，请检查目标通道是否配置启用或有活跃连接。`);
        return false;
    }
}

// 直接脚本运行处理
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
    const message = process.argv[2];
    const agentName = process.argv[3] || "智能体";
    const targetPathOrName = process.argv[4] || process.cwd();

    if (!message) {
        console.log("用法: node notify.js \"消息内容\" [智能体名称] [项目路径/名称]");
        console.log("  或: cah notify \"消息内容\" [智能体名称] [项目路径/名称]");
        process.exit(1);
    }

    await sendNotification(message, agentName, targetPathOrName);
}
