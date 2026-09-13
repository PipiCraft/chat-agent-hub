import fs from "node:fs";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { AUTH_PATH, CONFIG_PATH, getConfig, saveConfig } from "./state.js";
import { getRunningPid, restartDaemon } from "./process.js";
import { loginWechatFlow } from "../channels/wechat.js";
import type { Config } from "../types/index.js";

async function promptRestartIfRunning(runningPid: number | null): Promise<void> {
    if (!runningPid) return;
    const shouldRestart = await p.confirm({
        message: `检测到服务正在后台运行 (PID: ${runningPid})，是否立即平滑重启以使新配置生效？`,
        initialValue: true,
    });
    if (p.isCancel(shouldRestart)) return;
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

async function configureFeishu(config: Config, runningPid: number | null): Promise<void> {
    p.note(
        [
            "1. 浏览器访问飞书开放平台: https://open.feishu.cn/",
            "2. 创建「企业自建应用」，并在「添加应用能力」中添加「机器人」",
            "3. 在「权限管理」中开通 im:message (获取与发送消息)",
            "4. 在「事件与回调」选择 长连接 (WebSocket) 模式",
            "   添加事件: im.message.receive_v1",
            "5. 发布版本，并在「凭证与基础信息」复制 App ID 与 Secret",
        ].join("\n"),
        "飞书接入指引"
    );

    const cur = config.channels?.feishu || { enabled: false, appId: "", appSecret: "" };

    const appId = await p.text({
        message: "请输入飞书 App ID (如 cli_xxx):",
        initialValue: cur.appId || "",
        placeholder: "cli_a1b2c3d4e5",
        validate: (val) => (!val?.trim() ? "App ID 不能为空" : undefined),
    });
    if (p.isCancel(appId) || typeof appId !== "string") return;

    const appSecret = await p.text({
        message: "请输入飞书 App Secret:",
        initialValue: cur.appSecret || "",
        placeholder: "密匙字符串",
        validate: (val) => (!val?.trim() ? "App Secret 不能为空" : undefined),
    });
    if (p.isCancel(appSecret) || typeof appSecret !== "string") return;

    if (!config.channels) (config as any).channels = {};
    config.channels.feishu = {
        enabled: true,
        appId: appId.trim(),
        appSecret: appSecret.trim(),
    };
    saveConfig(config);
    p.log.success(pc.green("飞书通道配置已保存至 config.json，状态已设置为 [已启用]！"));

    await promptRestartIfRunning(runningPid);
}

async function configureDingtalk(config: Config, runningPid: number | null): Promise<void> {
    p.note(
        [
            "1. 浏览器访问钉钉开发者后台: https://open-dev.dingtalk.com/",
            "2. 创建企业内部应用，并在「应用能力」中添加「机器人」",
            "3. 消息接收模式设为 Stream 模式并保存发布",
            "4. 在「凭证与基础信息」获取 Client ID 与 Client Secret",
        ].join("\n"),
        "钉钉接入指引"
    );

    const cur = config.channels?.dingtalk || { enabled: false, clientId: "", clientSecret: "" };

    const clientId = await p.text({
        message: "请输入钉钉 Client ID (AppKey):",
        initialValue: cur.clientId || "",
        validate: (val) => (!val?.trim() ? "Client ID 不能为空" : undefined),
    });
    if (p.isCancel(clientId) || typeof clientId !== "string") return;

    const clientSecret = await p.text({
        message: "请输入钉钉 Client Secret (AppSecret):",
        initialValue: cur.clientSecret || "",
        validate: (val) => (!val?.trim() ? "Client Secret 不能为空" : undefined),
    });
    if (p.isCancel(clientSecret) || typeof clientSecret !== "string") return;

    if (!config.channels) (config as any).channels = {};
    config.channels.dingtalk = {
        enabled: true,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
    };
    saveConfig(config);
    p.log.success(pc.green("钉钉通道配置已保存至 config.json，状态已设置为 [已启用]！"));

    await promptRestartIfRunning(runningPid);
}

async function manageWechat(config: Config, runningPid: number | null): Promise<void> {
    const isEnabled = config.channels?.wechat?.enabled !== false;
    const hasAuth = fs.existsSync(AUTH_PATH);

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (!hasAuth) {
        options.push({ value: "scan", label: "立即扫码登录微信", hint: "终端显示二维码，微信扫码绑定" });
    } else {
        options.push({ value: "scan", label: "重新扫码登录 (更换账号)", hint: "获取新二维码并覆盖登录" });
        options.push({ value: "logout", label: "退出登录 (清除授权凭据)", hint: "删除本地 auth.json 登录文件" });
    }
    options.push({ value: "toggle", label: isEnabled ? "停用微信通道" : "启用微信通道" });
    options.push({ value: "back", label: "返回上级菜单" });

    const choice = await p.select({
        message: `微信通道管理 (当前: ${isEnabled ? pc.green("已开启") : pc.red("已停用")}, 状态: ${hasAuth ? pc.green("已授权免扫码") : pc.yellow("待扫码")})`,
        options,
    });
    if (p.isCancel(choice) || choice === "back") return;

    if (choice === "scan") {
        try {
            if (!config.channels) (config as any).channels = {};
            if (!config.channels.wechat) config.channels.wechat = { enabled: true };
            config.channels.wechat.enabled = true;
            saveConfig(config);

            p.log.info(pc.cyan("正在请求微信登录二维码，请稍候..."));
            await loginWechatFlow(AUTH_PATH);
            p.log.success(pc.green("微信账号授权成功，并已自动启用微信通道！"));
            await promptRestartIfRunning(runningPid);
        } catch (e: any) {
            p.log.error(`微信扫码登录失败: ${e?.message || e}`);
        }
    } else if (choice === "logout") {
        try {
            if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
            p.log.success(pc.green("微信授权凭据已成功清除。"));
            await promptRestartIfRunning(runningPid);
        } catch (e: any) {
            p.log.error(`清除失败: ${e?.message}`);
        }
    } else if (choice === "toggle") {
        if (!config.channels) (config as any).channels = {};
        if (!config.channels.wechat) config.channels.wechat = { enabled: true };
        config.channels.wechat.enabled = !isEnabled;
        saveConfig(config);
        p.log.success(`微信通道已切换为: ${!isEnabled ? pc.green("启用") : pc.red("停用")}`);
        await promptRestartIfRunning(runningPid);
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

        const wechatOn = config.channels?.wechat?.enabled !== false;
        const feishuOn = Boolean(config.channels?.feishu?.enabled);
        const feishuAppId = config.channels?.feishu?.appId ? ` (${config.channels.feishu.appId})` : "";
        const dingtalkOn = Boolean(config.channels?.dingtalk?.enabled);
        const dingtalkClientId = config.channels?.dingtalk?.clientId ? ` (${config.channels.dingtalk.clientId})` : "";

        p.note(
            [
                `运行状态: ${runningPid ? pc.green(`运行中 (PID: ${runningPid})`) : pc.yellow("未运行")}`,
                `微信通道: ${wechatOn ? pc.green("已启用") : pc.red("未启用")} ${fs.existsSync(AUTH_PATH) ? "(已登录免扫码)" : "(待扫码)"}`,
                `飞书通道: ${feishuOn ? pc.green("已启用" + feishuAppId) : pc.red("未启用")}`,
                `钉钉通道: ${dingtalkOn ? pc.green("已启用" + dingtalkClientId) : pc.red("未启用")}`,
            ].join("\n"),
            "通道概览"
        );

        const action = await p.select({
            message: "请选择要配置的项目:",
            options: [
                { value: "feishu", label: "添加 / 配置飞书通道", hint: "支持交互式卡片审批" },
                { value: "dingtalk", label: "添加 / 配置钉钉通道", hint: "Stream 长连接免公网" },
                { value: "wechat", label: "微信通道管理", hint: "开关 / 清除凭据重扫码" },
                { value: "editor", label: "打开 config.json 文本编辑", hint: "完整高级配置" },
                { value: "exit", label: "退出配置向导" },
            ],
        });

        if (p.isCancel(action) || action === "exit") {
            p.outro(pc.dim("已退出配置向导。"));
            break;
        }

        if (action === "feishu") await configureFeishu(config, runningPid);
        else if (action === "dingtalk") await configureDingtalk(config, runningPid);
        else if (action === "wechat") await manageWechat(config, runningPid);
        else if (action === "editor") openConfigInEditor();
    }
}
