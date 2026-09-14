import fs from "node:fs";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { AUTH_PATH, CONFIG_PATH, getConfig, saveConfig } from "./state.js";
import { getRunningPid, restartDaemon, ensureTerminalClean } from "./process.js";
import { loginWechatFlow } from "../channels/wechat.js";

/**
 * 全局退出二次确认：防止误触 Ctrl+C
 */
export async function confirmExitPrompt(): Promise<boolean> {
    const reallyExit = await p.confirm({
        message: "检测到退出信号 (Ctrl+C)，确定要退出 Chat Agent Hub 吗？",
        initialValue: true,
    });
    if (p.isCancel(reallyExit) || reallyExit === true) {
        p.outro(pc.dim("已安全退出 Chat Agent Hub。再见！"));
        process.exit(0);
    }
    return false;
}

async function promptRestartIfRunning(runningPid: number | null): Promise<void> {
    if (!runningPid) return;
    const shouldRestart = await p.confirm({
        message: `检测到服务正在后台运行 (PID: ${runningPid})，是否立即平滑重启以使新配置生效？`,
        initialValue: true,
    });
    if (p.isCancel(shouldRestart)) {
        await confirmExitPrompt();
        return;
    }
    if (shouldRestart) {
        const s = p.spinner();
        s.start("正在重启 Agent Hub 服务...");
        const res = restartDaemon();
        if (res.success) {
            s.stop(pc.green(`服务已成功在后台重启！新 PID: ${res.pid}`));
        } else {
            s.stop(pc.red("重启失败，您可以稍后执行 cah restart 重试。"));
        }
    } else {
        p.log.info("您可随时在终端执行 " + pc.cyan("cah restart") + " 手动重启服务生效。");
    }
}

async function manageFeishu(): Promise<void> {
    while (true) {
        const curConfig = getConfig();
        const runningPid = getRunningPid();
        const cur = curConfig.channels?.feishu;
        const isConfigured = Boolean(cur?.appId && cur?.appSecret);
        const isEnabled = Boolean(cur?.enabled && isConfigured);

        const options: Array<{ value: string; label: string; hint?: string }> = [];
        if (!isConfigured) {
            options.push({ value: "setup", label: "配置飞书凭据并启用", hint: "输入 App ID 与 App Secret" });
        } else {
            options.push({ value: "setup", label: "修改飞书凭据", hint: `当前 App ID: ${cur?.appId}` });
            options.push({ value: "toggle", label: isEnabled ? "停用飞书通道" : "启用飞书通道", hint: isEnabled ? "暂停接收飞书消息" : "恢复接收飞书消息" });
            options.push({ value: "clear", label: "清除配置并停用", hint: "删除 App ID 与 Secret 凭据" });
        }
        options.push({ value: "back", label: "返回上级菜单" });

        let statusDesc = pc.red("未配置");
        if (isEnabled) statusDesc = pc.green(`已启用 (${cur?.appId})`);
        else if (isConfigured) statusDesc = pc.yellow(`已配置但停用 (${cur?.appId})`);

        const choice = await p.select({
            message: `飞书通道管理 (状态: ${statusDesc})`,
            options,
            initialValue: isConfigured ? "back" : "setup",
        });

        if (choice === "back") return;
        if (p.isCancel(choice)) {
            await confirmExitPrompt();
            continue;
        }

        if (choice === "setup") {
            p.note(
                [
                    "1. 浏览器访问飞书开放平台: https://open.feishu.cn/",
                    "2. 创建「企业自建应用」，并在「添加应用能力」中添加「机器人」",
                    "3. 在「权限管理」中开通 im:message (获取与发送消息)",
                    "4. 在「事件与回调」选择 长连接 (WebSocket) 模式",
                    "   添加事件: im.message.receive_v1",
                    "5. 发布版本，并在「凭证与基础信息」复制 App ID 与 Secret",
                    pc.dim("提示: 输入 'b' 可返回上级菜单，Ctrl+C 触发退出确认"),
                ].join("\n"),
                "飞书接入指引"
            );

            const appId = await p.text({
                message: "请输入飞书 App ID (输入 'b' 返回):",
                initialValue: cur?.appId || "",
                placeholder: "cli_a1b2c3d4e5",
                validate: (val) => (!val?.trim() ? "App ID 不能为空 (输入 'b' 返回)" : undefined),
            });
            if (typeof appId === "string" && appId.trim().toLowerCase() === "b") continue;
            if (p.isCancel(appId)) {
                await confirmExitPrompt();
                continue;
            }

            const appSecret = await p.text({
                message: "请输入飞书 App Secret (输入 'b' 返回):",
                initialValue: cur?.appSecret || "",
                placeholder: "密匙字符串",
                validate: (val) => (!val?.trim() ? "App Secret 不能为空 (输入 'b' 返回)" : undefined),
            });
            if (typeof appSecret === "string" && appSecret.trim().toLowerCase() === "b") continue;
            if (p.isCancel(appSecret)) {
                await confirmExitPrompt();
                continue;
            }
            if (typeof appId !== "string" || typeof appSecret !== "string") continue;

            const latestConfig = getConfig();
            if (!latestConfig.channels) (latestConfig as any).channels = {};
            latestConfig.channels.feishu = {
                enabled: true,
                appId: appId.trim(),
                appSecret: appSecret.trim(),
            };
            saveConfig(latestConfig);
            p.log.success(pc.green("飞书通道配置已保存至 config.json，状态已设置为 [已启用]！"));
            await promptRestartIfRunning(runningPid);
        } else if (choice === "toggle") {
            const latestConfig = getConfig();
            if (!latestConfig.channels) (latestConfig as any).channels = {};
            if (!latestConfig.channels.feishu) latestConfig.channels.feishu = { enabled: true, appId: "", appSecret: "" };
            latestConfig.channels.feishu.enabled = !isEnabled;
            saveConfig(latestConfig);
            p.log.success(`飞书通道已切换为: ${!isEnabled ? pc.green("启用") : pc.red("停用")}`);
            await promptRestartIfRunning(runningPid);
        } else if (choice === "clear") {
            const latestConfig = getConfig();
            if (latestConfig.channels?.feishu) {
                latestConfig.channels.feishu = { enabled: false, appId: "", appSecret: "" };
                saveConfig(latestConfig);
                p.log.success(pc.green("飞书通道配置已清空并设为停用。"));
                await promptRestartIfRunning(runningPid);
            }
        }
    }
}

async function manageDingtalk(): Promise<void> {
    while (true) {
        const curConfig = getConfig();
        const runningPid = getRunningPid();
        const cur = curConfig.channels?.dingtalk;
        const isConfigured = Boolean(cur?.clientId && cur?.clientSecret);
        const isEnabled = Boolean(cur?.enabled && isConfigured);

        const options: Array<{ value: string; label: string; hint?: string }> = [];
        if (!isConfigured) {
            options.push({ value: "setup", label: "配置钉钉凭据并启用", hint: "输入 Client ID 与 Client Secret" });
        } else {
            options.push({ value: "setup", label: "修改钉钉凭据", hint: `当前 Client ID: ${cur?.clientId}` });
            options.push({ value: "toggle", label: isEnabled ? "停用钉钉通道" : "启用钉钉通道", hint: isEnabled ? "暂停接收钉钉消息" : "恢复接收钉钉消息" });
            options.push({ value: "clear", label: "清除配置并停用", hint: "删除 Client ID 与 Secret 凭据" });
        }
        options.push({ value: "back", label: "返回上级菜单" });

        let statusDesc = pc.red("未配置");
        if (isEnabled) statusDesc = pc.green(`已启用 (${cur?.clientId})`);
        else if (isConfigured) statusDesc = pc.yellow(`已配置但停用 (${cur?.clientId})`);

        const choice = await p.select({
            message: `钉钉通道管理 (状态: ${statusDesc})`,
            options,
            initialValue: isConfigured ? "back" : "setup",
        });

        if (choice === "back") return;
        if (p.isCancel(choice)) {
            await confirmExitPrompt();
            continue;
        }

        if (choice === "setup") {
            p.note(
                [
                    "1. 浏览器访问钉钉开发者后台: https://open-dev.dingtalk.com/",
                    "2. 创建企业内部应用，并在「应用能力」中添加「机器人」",
                    "3. 消息接收模式设为 Stream 模式并保存发布",
                    "4. 在「凭证与基础信息」获取 Client ID 与 Client Secret",
                    pc.dim("提示: 输入 'b' 可返回上级菜单，Ctrl+C 触发退出确认"),
                ].join("\n"),
                "钉钉接入指引"
            );

            const clientId = await p.text({
                message: "请输入钉钉 Client ID (AppKey, 输入 'b' 返回):",
                initialValue: cur?.clientId || "",
                validate: (val) => (!val?.trim() ? "Client ID 不能为空 (输入 'b' 返回)" : undefined),
            });
            if (typeof clientId === "string" && clientId.trim().toLowerCase() === "b") continue;
            if (p.isCancel(clientId)) {
                await confirmExitPrompt();
                continue;
            }

            const clientSecret = await p.text({
                message: "请输入钉钉 Client Secret (AppSecret, 输入 'b' 返回):",
                initialValue: cur?.clientSecret || "",
                validate: (val) => (!val?.trim() ? "Client Secret 不能为空 (输入 'b' 返回)" : undefined),
            });
            if (typeof clientSecret === "string" && clientSecret.trim().toLowerCase() === "b") continue;
            if (p.isCancel(clientSecret)) {
                await confirmExitPrompt();
                continue;
            }
            if (typeof clientId !== "string" || typeof clientSecret !== "string") continue;

            const latestConfig = getConfig();
            if (!latestConfig.channels) (latestConfig as any).channels = {};
            latestConfig.channels.dingtalk = {
                enabled: true,
                clientId: clientId.trim(),
                clientSecret: clientSecret.trim(),
            };
            saveConfig(latestConfig);
            p.log.success(pc.green("钉钉通道配置已保存至 config.json，状态已设置为 [已启用]！"));
            await promptRestartIfRunning(runningPid);
        } else if (choice === "toggle") {
            const latestConfig = getConfig();
            if (!latestConfig.channels) (latestConfig as any).channels = {};
            if (!latestConfig.channels.dingtalk) latestConfig.channels.dingtalk = { enabled: true, clientId: "", clientSecret: "" };
            latestConfig.channels.dingtalk.enabled = !isEnabled;
            saveConfig(latestConfig);
            p.log.success(`钉钉通道已切换为: ${!isEnabled ? pc.green("启用") : pc.red("停用")}`);
            await promptRestartIfRunning(runningPid);
        } else if (choice === "clear") {
            const latestConfig = getConfig();
            if (latestConfig.channels?.dingtalk) {
                latestConfig.channels.dingtalk = { enabled: false, clientId: "", clientSecret: "" };
                saveConfig(latestConfig);
                p.log.success(pc.green("钉钉通道配置已清空并设为停用。"));
                await promptRestartIfRunning(runningPid);
            }
        }
    }
}

async function manageWechat(): Promise<void> {
    while (true) {
        const curConfig = getConfig();
        const runningPid = getRunningPid();
        const isEnabled = Boolean(curConfig.channels?.wechat?.enabled);
        const hasAuth = fs.existsSync(AUTH_PATH);

        const options: Array<{ value: string; label: string; hint?: string }> = [];
        if (!hasAuth) {
            options.push({ value: "scan", label: "立即扫码登录微信并启用", hint: "终端显示二维码，微信扫码绑定账号" });
        } else {
            options.push({ value: "scan", label: "重新扫码登录 (更换账号)", hint: "获取新二维码并覆盖当前登录" });
            options.push({ value: "toggle", label: isEnabled ? "停用微信通道" : "启用微信通道", hint: isEnabled ? "保留凭据，暂停微信消息接收" : "恢复已登录的微信通道" });
            options.push({ value: "logout", label: "退出登录 (清除授权凭据并停用)", hint: "删除 auth.json 并关闭微信通道" });
        }
        options.push({ value: "back", label: "返回上级菜单" });

        let statusDesc = pc.red("已停用");
        if (isEnabled && hasAuth) statusDesc = pc.green("已启用 (已登录免扫码)");
        else if (isEnabled && !hasAuth) statusDesc = pc.yellow("待扫码 (未登录不可用)");

        const choice = await p.select({
            message: `微信通道管理 (状态: ${statusDesc})`,
            options,
            initialValue: hasAuth ? "back" : "scan",
        });

        if (choice === "back") return;
        if (p.isCancel(choice)) {
            await confirmExitPrompt();
            continue;
        }

        if (choice === "scan") {
            try {
                p.log.info(pc.cyan("正在请求微信登录二维码，请稍候..."));
                const auth = await loginWechatFlow(AUTH_PATH, confirmExitPrompt);
                if (!auth) {
                    p.log.warn("已取消微信扫码登录，已返回微信管理菜单。");
                    continue;
                }

                const latestConfig = getConfig();
                if (!latestConfig.channels) (latestConfig as any).channels = {};
                if (!latestConfig.channels.wechat) latestConfig.channels.wechat = { enabled: true };
                latestConfig.channels.wechat.enabled = true;
                saveConfig(latestConfig);

                p.log.success(pc.green("微信账号授权成功，并已自动启用微信通道！"));
                await promptRestartIfRunning(runningPid);
            } catch (e: any) {
                p.log.error(`微信扫码登录失败: ${e?.message || e}`);
            }
        } else if (choice === "logout") {
            try {
                if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
                const latestConfig = getConfig();
                if (!latestConfig.channels) (latestConfig as any).channels = {};
                if (!latestConfig.channels.wechat) latestConfig.channels.wechat = { enabled: false };
                latestConfig.channels.wechat.enabled = false;
                saveConfig(latestConfig);
                p.log.success(pc.green("微信授权凭据已成功清除，微信通道已自动设为停用。"));
                await promptRestartIfRunning(runningPid);
            } catch (e: any) {
                p.log.error(`清除失败: ${e?.message}`);
            }
        } else if (choice === "toggle") {
            if (!hasAuth) {
                p.log.warn(pc.yellow("当前尚未扫码登录微信账号，无法直接启用。请先扫码登录！"));
                continue;
            }
            const latestConfig = getConfig();
            if (!latestConfig.channels) (latestConfig as any).channels = {};
            if (!latestConfig.channels.wechat) latestConfig.channels.wechat = { enabled: true };
            latestConfig.channels.wechat.enabled = !isEnabled;
            saveConfig(latestConfig);
            p.log.success(`微信通道已切换为: ${!isEnabled ? pc.green("启用") : pc.red("停用")}`);
            await promptRestartIfRunning(runningPid);
        }
    }
}

function openConfigInEditor(): void {
    p.log.info("正在调起系统默认文本编辑器打开 " + pc.cyan(CONFIG_PATH) + " ...");
    try {
        if (process.platform === "win32") {
            execSync(`start "" notepad "${CONFIG_PATH}"`);
        } else if (process.platform === "darwin") {
            execSync(`open "${CONFIG_PATH}"`);
        } else {
            execSync(`xdg-open "${CONFIG_PATH}" 2>/dev/null || nano "${CONFIG_PATH}"`);
        }
    } catch {
        p.log.info("配置文件物理路径: " + CONFIG_PATH);
    }
}

export async function showConfigWizard(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" Chat Agent Hub 通道配置向导 ")));

    while (true) {
        const config = getConfig();
        const runningPid = getRunningPid();

        const wechatOn = Boolean(config.channels?.wechat?.enabled);
        const hasAuth = fs.existsSync(AUTH_PATH);
        let wechatStatusText = pc.red("未启用");
        if (wechatOn && hasAuth) wechatStatusText = pc.green("已启用 (已登录免扫码)");
        else if (wechatOn && !hasAuth) wechatStatusText = pc.yellow("待扫码 (未登录不可用)");

        const feishuOn = Boolean(config.channels?.feishu?.enabled);
        const feishuAppId = config.channels?.feishu?.appId ? ` (${config.channels.feishu.appId})` : "";
        const dingtalkOn = Boolean(config.channels?.dingtalk?.enabled);
        const dingtalkClientId = config.channels?.dingtalk?.clientId ? ` (${config.channels.dingtalk.clientId})` : "";

        p.note(
            [
                `运行状态: ${runningPid ? pc.green(`运行中 (PID: ${runningPid})`) : pc.yellow("未运行")}`,
                `微信通道: ${wechatStatusText}`,
                `飞书通道: ${feishuOn ? pc.green("已启用" + feishuAppId) : pc.red("未启用")}`,
                `钉钉通道: ${dingtalkOn ? pc.green("已启用" + dingtalkClientId) : pc.red("未启用")}`,
            ].join("\n"),
            "通道概览"
        );

        const action = await p.select({
            message: "请选择要配置的项目:",
            options: [
                { value: "feishu", label: "飞书通道管理", hint: "配置凭据 / 启停 / 交互卡片审批" },
                { value: "dingtalk", label: "钉钉通道管理", hint: "配置凭据 / 启停 / Stream 长连接" },
                { value: "wechat", label: "微信通道管理", hint: "扫码登录 / 凭据管理 / 启停" },
                { value: "editor", label: "打开 config.json 文本编辑", hint: "完整高级配置" },
                { value: "exit", label: "返回上级菜单 / 退出向导" },
            ],
        });

        if (action === "exit") {
            p.outro(pc.dim("已退出通道配置向导。"));
            break;
        }

        if (p.isCancel(action)) {
            await confirmExitPrompt();
            continue;
        }

        if (action === "feishu") await manageFeishu();
        else if (action === "dingtalk") await manageDingtalk();
        else if (action === "wechat") await manageWechat();
        else if (action === "editor") {
            openConfigInEditor();
            ensureTerminalClean();
        }
    }
}
