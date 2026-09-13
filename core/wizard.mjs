import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, execSync } from "node:child_process";
import {
    ROOT_DIR,
    CONFIG_PATH,
    AUTH_PATH,
    PID_PATH,
    getConfig,
    saveConfig,
} from "./state.mjs";

function askQuestion(rl, query) {
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            resolve((answer || "").trim());
        });
    });
}

function getRunningPid() {
    try {
        if (fs.existsSync(PID_PATH)) {
            const p = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
            if (p && !isNaN(p)) {
                if (process.platform === "win32") {
                    const out = execSync(`tasklist /FI "PID eq ${p}" 2>nul`, { encoding: "utf-8" });
                    if (out.includes(String(p))) return p;
                } else {
                    execSync(`kill -0 ${p} 2>/dev/null`);
                    return p;
                }
            }
        }
    } catch {}
    return null;
}

function restartService(runningPid) {
    console.log("\n[*] 正在重启 Agent Hub 服务...");
    try {
        if (runningPid) {
            if (process.platform === "win32") {
                execSync(`taskkill /F /PID ${runningPid} /T >nul 2>&1`);
            } else {
                execSync(`kill -9 ${runningPid} 2>/dev/null`);
            }
        }
        if (fs.existsSync(PID_PATH)) {
            try { fs.unlinkSync(PID_PATH); } catch {}
        }

        if (process.platform === "win32") {
            const psCmd = `$dir = '${ROOT_DIR.replace(/'/g, "''")}'; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('node.exe \"' + $dir + '\\bridge.mjs\"'); CurrentDirectory=$dir}`;
            execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, { stdio: "ignore" });
        } else {
            const logPath = path.join(ROOT_DIR, "logs", "hub.log");
            const child = spawn("node", ["bridge.mjs"], {
                cwd: ROOT_DIR,
                detached: true,
                stdio: ["ignore", fs.openSync(logPath, "a"), fs.openSync(logPath, "a")],
            });
            child.unref();
            if (child.pid) {
                fs.writeFileSync(PID_PATH, String(child.pid), "utf-8");
            }
        }
        console.log("[+] 服务已成功在后台重启！新通道已加载。");
    } catch (err) {
        console.log("[-] 重启触发异常，请手动执行 .\\run.bat restart。");
    }
}

async function configureFeishu(rl, config, runningPid) {
    const cur = config.channels?.feishu || {};
    console.log("\n========================================================");
    console.log("  【飞书通道配置指南】");
    console.log("========================================================");
    console.log("1. 浏览器访问飞书开放平台: https://open.feishu.cn/");
    console.log("2. 创建「企业自建应用」，并在「添加应用能力」中添加「机器人」");
    console.log("3. 在「权限管理」中开通 im:message (获取与发送消息)");
    console.log("4. 在「事件与回调」选择 长连接 (WebSocket) 模式");
    console.log("   在「事件配置」添加事件: im.message.receive_v1 (接收消息)");
    console.log("   (可选) 在「回调配置」添加: card.action.trigger (卡片按钮审批)");
    console.log("5. 发布应用版本，在「凭证与基础信息」复制 App ID 与 App Secret");
    console.log("--------------------------------------------------------");

    const defaultAppId = cur.appId || "";
    const promptId = defaultAppId
        ? `请输入 App ID (如 cli_xxx) [当前: ${defaultAppId}，直接回车保留]: `
        : "请输入 App ID (如 cli_xxx，输入 q 取消): ";
    const inputAppId = await askQuestion(rl, promptId);

    if (inputAppId.toLowerCase() === "q") {
        console.log("[*] 已取消配置。");
        return;
    }
    const finalAppId = inputAppId || defaultAppId;
    if (!finalAppId) {
        console.log("[-] App ID 不能为空，已取消。");
        return;
    }

    const defaultSecret = cur.appSecret || "";
    const promptSecret = defaultSecret
        ? `请输入 App Secret [已配置密匙，直接回车保留]: `
        : "请输入 App Secret (输入 q 取消): ";
    const inputSecret = await askQuestion(rl, promptSecret);

    if (inputSecret.toLowerCase() === "q") {
        console.log("[*] 已取消配置。");
        return;
    }
    const finalSecret = inputSecret || defaultSecret;
    if (!finalSecret) {
        console.log("[-] App Secret 不能为空，已取消。");
        return;
    }

    if (!config.channels) config.channels = {};
    config.channels.feishu = {
        enabled: true,
        appId: finalAppId,
        appSecret: finalSecret,
    };
    saveConfig(config);
    console.log("\n[+] 飞书通道配置已成功保存至 config.json！通道状态: [已启用]");

    if (runningPid) {
        const restartAns = await askQuestion(rl, `[*] 检测到服务正在后台运行 (PID: ${runningPid})，是否立即重启以激活飞书？[Y/n]: `);
        if (restartAns === "" || restartAns.toLowerCase() === "y" || restartAns.toLowerCase() === "yes") {
            restartService(runningPid);
        } else {
            console.log("[i] 您稍后可执行 .\\run.bat restart 手动重启生效。");
        }
    } else {
        console.log("[i] 配置完成。执行 .\\run.bat 启动服务即可自动连通飞书。");
    }
}

async function configureDingtalk(rl, config, runningPid) {
    const cur = config.channels?.dingtalk || {};
    console.log("\n========================================================");
    console.log("  【钉钉通道配置指南】");
    console.log("========================================================");
    console.log("1. 浏览器访问钉钉开发者后台: https://open-dev.dingtalk.com/");
    console.log("2. 创建企业内部应用，并在「应用能力」中添加「机器人」");
    console.log("3. 消息接收模式选择 Stream 模式并保存发布");
    console.log("4. 在「凭证与基础信息」中获取 Client ID 与 Client Secret");
    console.log("--------------------------------------------------------");

    const defaultClientId = cur.clientId || "";
    const promptId = defaultClientId
        ? `请输入 Client ID [当前: ${defaultClientId}，直接回车保留]: `
        : "请输入 Client ID (输入 q 取消): ";
    const inputId = await askQuestion(rl, promptId);

    if (inputId.toLowerCase() === "q") {
        console.log("[*] 已取消配置。");
        return;
    }
    const finalId = inputId || defaultClientId;
    if (!finalId) {
        console.log("[-] Client ID 不能为空，已取消。");
        return;
    }

    const defaultSecret = cur.clientSecret || "";
    const promptSecret = defaultSecret
        ? `请输入 Client Secret [已配置密匙，直接回车保留]: `
        : "请输入 Client Secret (输入 q 取消): ";
    const inputSecret = await askQuestion(rl, promptSecret);

    if (inputSecret.toLowerCase() === "q") {
        console.log("[*] 已取消配置。");
        return;
    }
    const finalSecret = inputSecret || defaultSecret;
    if (!finalSecret) {
        console.log("[-] Client Secret 不能为空，已取消。");
        return;
    }

    if (!config.channels) config.channels = {};
    config.channels.dingtalk = {
        enabled: true,
        clientId: finalId,
        clientSecret: finalSecret,
    };
    saveConfig(config);
    console.log("\n[+] 钉钉通道配置已成功保存至 config.json！通道状态: [已启用]");

    if (runningPid) {
        const restartAns = await askQuestion(rl, `[*] 检测到服务正在后台运行 (PID: ${runningPid})，是否立即重启以激活钉钉？[Y/n]: `);
        if (restartAns === "" || restartAns.toLowerCase() === "y" || restartAns.toLowerCase() === "yes") {
            restartService(runningPid);
        } else {
            console.log("[i] 您稍后可执行 .\\run.bat restart 手动重启生效。");
        }
    } else {
        console.log("[i] 配置完成。执行 .\\run.bat 启动服务即可自动连通钉钉。");
    }
}

async function manageWechat(rl, config, runningPid) {
    const isEnabled = config.channels?.wechat?.enabled !== false;
    const hasAuth = fs.existsSync(AUTH_PATH);

    console.log("\n========================================================");
    console.log("  【微信通道管理】");
    console.log("========================================================");
    console.log(`当前状态: ${isEnabled ? "已开启" : "已停用"} | 登录凭据: ${hasAuth ? "已缓存 (免扫码)" : "未登录 (需扫码)"}`);
    console.log("");
    console.log("  1. " + (isEnabled ? "停用微信通道" : "启用微信通道"));
    console.log("  2. 清除登录凭据并重新扫码");
    console.log("  q. 返回主菜单");
    console.log("--------------------------------------------------------");

    const choice = await askQuestion(rl, "请选择操作 [1/2/q]: ");
    if (choice === "1") {
        if (!config.channels) config.channels = {};
        if (!config.channels.wechat) config.channels.wechat = {};
        config.channels.wechat.enabled = !isEnabled;
        saveConfig(config);
        console.log(`[+] 微信通道已设置为: ${!isEnabled ? "启用" : "停用"}`);
        if (runningPid) {
            const restartAns = await askQuestion(rl, `是否立即重启服务生效？[Y/n]: `);
            if (restartAns === "" || restartAns.toLowerCase() === "y") restartService(runningPid);
        }
    } else if (choice === "2") {
        try {
            if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
            console.log("[+] 微信旧登录缓存已清除。");
            console.log("[i] 接下来启动服务或执行 .\\run.bat start 控制台模式即可重新扫码。");
        } catch (e) {
            console.log("[-] 清除失败: " + e.message);
        }
    }
}

function openConfigInEditor() {
    console.log("\n[*] 正在用默认文本编辑器打开 config.json...");
    try {
        if (process.platform === "win32") {
            execSync(`start "" notepad "${CONFIG_PATH}"`);
        } else if (process.platform === "darwin") {
            execSync(`open "${CONFIG_PATH}"`);
        } else {
            execSync(`xdg-open "${CONFIG_PATH}" 2>/dev/null || nano "${CONFIG_PATH}"`);
        }
    } catch {
        console.log("[i] 配置文件路径: " + CONFIG_PATH);
    }
}

export async function runWizard() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        while (true) {
            const config = getConfig();
            const runningPid = getRunningPid();

            const wechatOn = config.channels?.wechat?.enabled !== false;
            const feishuOn = Boolean(config.channels?.feishu?.enabled);
            const feishuAppId = config.channels?.feishu?.appId ? ` (${config.channels.feishu.appId})` : "";
            const dingtalkOn = Boolean(config.channels?.dingtalk?.enabled);
            const dingtalkClientId = config.channels?.dingtalk?.clientId ? ` (${config.channels.dingtalk.clientId})` : "";

            console.log("\n========================================================");
            console.log("  Chat Agent Hub 通道配置助手");
            console.log("========================================================");
            console.log(`服务状态: ${runningPid ? `正在后台运行 (PID: ${runningPid})` : "未运行"}`);
            console.log("[当前通道状态]");
            console.log(`  ${wechatOn ? "[√]" : "[-]"} 微信通道 : ${wechatOn ? (fs.existsSync(AUTH_PATH) ? "已启用 (已授权免扫码)" : "已启用 (待扫码)") : "未启用"}`);
            console.log(`  ${feishuOn ? "[√]" : "[-]"} 飞书通道 : ${feishuOn ? "已启用" + feishuAppId : "未启用"}`);
            console.log(`  ${dingtalkOn ? "[√]" : "[-]"} 钉钉通道 : ${dingtalkOn ? "已启用" + dingtalkClientId : "未启用"}`);
            console.log("");
            console.log("[操作选项]");
            console.log("  1. 添加 / 配置飞书通道 (推荐，支持点击交互卡片审批)");
            console.log("  2. 添加 / 配置钉钉通道 (Stream 直连免公网)");
            console.log("  3. 微信通道管理 (开启 / 停用 / 重新扫码)");
            console.log("  4. 打开完整 config.json 手动编辑");
            console.log("  q. 退出配置助手");
            console.log("========================================================");

            const choice = await askQuestion(rl, "请选择操作 [1-4 或 q 退出]: ");
            if (choice === "1") {
                await configureFeishu(rl, config, runningPid);
            } else if (choice === "2") {
                await configureDingtalk(rl, config, runningPid);
            } else if (choice === "3") {
                await manageWechat(rl, config, runningPid);
            } else if (choice === "4") {
                openConfigInEditor();
            } else if (choice.toLowerCase() === "q" || choice.toLowerCase() === "exit") {
                console.log("已退出配置助手。");
                break;
            } else {
                console.log("[-] 无效选项，请重新选择。");
            }
        }
    } finally {
        rl.close();
    }
}

if (process.argv[1] && process.argv[1].endsWith("wizard.mjs")) {
    runWizard().catch((err) => {
        console.error("[-] 配置助手异常:", err);
    });
}
