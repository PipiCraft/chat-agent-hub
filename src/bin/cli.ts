#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { cac } from "cac";
import * as p from "@clack/prompts";
import pc from "picocolors";

import {
    ROOT_DIR,
    DATA_DIR,
    CONFIG_PATH,
    LOGS_DIR,
    AUTH_PATH,
    getConfig,
    getInstances,
} from "../core/state.js";
import {
    getRunningPid,
    startDaemon,
    stopDaemon,
    restartDaemon,
    checkChannelsReadiness,
    ensureTerminalClean,
} from "../core/process.js";
import { detectInstalledAgents, resolveDefaultAgent } from "../core/runner.js";
import { showConfigWizard, confirmExitPrompt } from "../core/wizard.js";
import { sendNotification } from "../notify.js";

const cli = cac("cah");

function resolveBridgeExec(): { execCmd: string; execArgs: string[] } {
    const distBridge = path.join(ROOT_DIR, "dist", "bridge.js");
    const srcBridge = path.join(ROOT_DIR, "src", "bridge.ts");

    if (fs.existsSync(distBridge)) {
        return { execCmd: process.execPath, execArgs: [distBridge] };
    }

    const tsxBin = path.join(ROOT_DIR, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    if (fs.existsSync(tsxBin)) {
        return { execCmd: tsxBin, execArgs: [srcBridge] };
    }

    return { execCmd: process.execPath, execArgs: [srcBridge] };
}

// 1. cah start
cli
    .command("start", "启动 Chat Agent Hub 服务")
    .option("-s, --silent", "后台静默守护启动（无控制台黑窗口）")
    .option("-d, --daemon", "后台守护模式（等同于 -s）")
    .action(async (options) => {
        const isSilent = options.silent || options.daemon;
        const readiness = checkChannelsReadiness();

        if (isSilent && !readiness.readyForDaemon) {
            console.log(pc.yellow(`\n[!] 后台静默启动中止: ${readiness.reason}`));
            console.log(pc.dim(`    建议操作: 运行 ${pc.cyan("cah config")} 开启并配置通道，或运行 ${pc.cyan("cah start")} 前台扫码登录。\n`));
            return;
        }

        if (!isSilent && !readiness.hasAnyEnabled) {
            console.log(pc.yellow("\n[!] 前台启动中止: 当前尚未开启任何消息通道 (微信/飞书/钉钉均处于未配置或未启用状态)。"));
            console.log(pc.dim(`    请先运行 ${pc.cyan("cah config")} 开启并配置至少一个消息通道。\n`));
            return;
        }

        if (isSilent) {
            const res = startDaemon();
            if (res.alreadyRunning) {
                console.log(pc.yellow(`[!] Agent Hub 已经在后台运行中 (PID: ${res.pid})。`));
                console.log(pc.dim(`    如需平滑重启请运行: ${pc.cyan("cah restart")}`));
                console.log(pc.dim(`    如需停止服务请运行: ${pc.cyan("cah stop")}`));
                return;
            }
            if (res.success) {
                console.log(pc.green(`[√] Agent Hub 服务已在后台成功启动！(PID: ${res.pid})`));
                console.log(pc.dim(`[i] 日志文件: ${res.logPath}`));
                console.log(pc.dim(`[i] 查看日志: ${pc.cyan("cah logs")}`));
                console.log(pc.dim(`[i] 停止服务: ${pc.cyan("cah stop")}`));
            } else {
                console.error(pc.red(`[-] 后台启动失败: ${res.error}`));
            }
            return;
        }

        // 前台启动
        const existingPid = getRunningPid();
        if (existingPid) {
            console.log(pc.yellow(`[!] 检测到 Agent Hub 服务正在后台运行中 (PID: ${existingPid})。`));
            console.log(pc.yellow(`    在前台重复启动可能会导致微信/飞书长连接抢占。`));
            console.log(pc.dim(`    建议先运行 ${pc.cyan("cah stop")} 停止后台服务，或运行 ${pc.cyan("cah logs")} 查看日志。\n`));
        }

        const { execCmd, execArgs } = resolveBridgeExec();
        const child = spawn(execCmd, execArgs, {
            cwd: DATA_DIR,
            stdio: "inherit",
        });

        child.on("exit", (code) => {
            process.exit(code || 0);
        });
    });

// 2. cah stop
cli
    .command("stop", "停止运行中的后台服务")
    .action(() => {
        const pid = getRunningPid();
        if (!pid) {
            console.log(pc.yellow("[!] Agent Hub 当前未在运行。"));
            return;
        }
        stopDaemon(pid);
        console.log(pc.green(`[√] Agent Hub 服务 (PID: ${pid}) 已成功安全停止。`));
    });

// 3. cah restart
cli
    .command("restart", "重启 Agent Hub 服务")
    .action(() => {
        const res = restartDaemon();
        if (res.success) {
            console.log(pc.green(`[√] Agent Hub 服务已成功在后台重启！(PID: ${res.pid})`));
            console.log(pc.dim(`[i] 查看实时日志: ${pc.cyan("cah logs -f")}`));
        } else {
            console.error(pc.red(`[-] 重启失败: ${res.error}`));
        }
    });

function printStatusSummary(): void {
    const pid = getRunningPid();
    const config = getConfig();
    const instances = getInstances();
    const allAgents = detectInstalledAgents();
    const installed = allAgents.filter((a) => a.installed);
    const defAgent = resolveDefaultAgent(config, allAgents);

    const wechatOn = Boolean(config.channels?.wechat?.enabled);
    const wechatAuthed = fs.existsSync(AUTH_PATH);
    let wechatStatus = pc.red("[- 未启用]");
    if (wechatOn && wechatAuthed) {
        wechatStatus = pc.green("[√ 已启用] (已登录免扫码)");
    } else if (wechatOn && !wechatAuthed) {
        wechatStatus = pc.yellow("[! 待扫码] (未登录不可用)");
    }

    const feishuOn = Boolean(config.channels?.feishu?.enabled);
    const dingtalkOn = Boolean(config.channels?.dingtalk?.enabled);

    console.log(pc.bold(pc.cyan("\n========================================================")));
    console.log(pc.bold(pc.cyan("  Chat Agent Hub (CAH) 运行状态")));
    console.log(pc.bold(pc.cyan("========================================================")));

    console.log(`服务状态:   ${pid ? pc.green(`● 运行中 (PID: ${pid})`) : pc.gray("○ 已停止")}`);
    console.log(`数据目录:   ${pc.dim(DATA_DIR)}`);
    console.log(`配置文件:   ${pc.dim(CONFIG_PATH)}`);
    console.log(`日志目录:   ${pc.dim(LOGS_DIR)}`);
    console.log("--------------------------------------------------------");
    console.log("通道状态:");
    console.log(`  • 微信通道: ${wechatStatus}`);
    console.log(`  • 飞书通道: ${feishuOn ? pc.green("[√ 已启用]") : pc.red("[- 未启用]")} ${config.channels?.feishu?.appId ? `(${config.channels.feishu.appId})` : ""}`);
    console.log(`  • 钉钉通道: ${dingtalkOn ? pc.green("[√ 已启用]") : pc.red("[- 未启用]")} ${config.channels?.dingtalk?.clientId ? `(${config.channels.dingtalk.clientId})` : ""}`);
    console.log("--------------------------------------------------------");
    console.log(`默认智能体: ${pc.bold(defAgent.name)} (模式: ${config.defaultAgent || "auto"})`);
    if (installed.length > 0) {
        console.log("已就绪智能体与 MCP 接入状态:");
        installed.forEach((a) => {
            const mcpTag = a.mcpConfigured ? pc.green(`[√ ${a.mcpDetails}]`) : pc.yellow(`[! ${a.mcpDetails}]`);
            console.log(`  • ${pc.bold(a.name.padEnd(12))} (${a.key})  ${mcpTag}`);
            if (!a.mcpConfigured && a.mcpHint) {
                console.log(`    └─ ${pc.dim(a.mcpHint)}`);
            }
        });
    } else {
        console.log(`已就绪智能体: ${pc.gray("暂未检测到")}`);
    }
    console.log(`活跃任务数: ${instances.length} 个 (会话保活: ${config.sessionIdleMinutes ?? 15} 分钟)`);
    console.log(pc.bold(pc.cyan("========================================================\n")));
}

function printLogsSummary(linesToShow: number = 30): void {
    const logPath = path.join(LOGS_DIR, "hub.log");
    if (!fs.existsSync(logPath)) {
        console.log(pc.yellow(`[!] 日志文件尚未生成: ${logPath}\n`));
        return;
    }

    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    console.log(pc.bold(pc.cyan(`\n--- 最近运行日志 (最后 ${linesToShow} 行) ---`)));
    console.log(lines.slice(-linesToShow).join("\n"));
    console.log(pc.bold(pc.cyan("-------------------------------------------\n")));
}

async function waitForMenuReturn(): Promise<void> {
    const res = await p.select({
        message: "操作完成，请选择:",
        options: [
            { value: "back", label: "返回控制面板主菜单" },
        ],
    });
    if (p.isCancel(res)) {
        await confirmExitPrompt();
        return;
    }
}

// 4. cah status
cli
    .command("status", "查看当前服务运行状态、通道连接与智能体")
    .action(() => {
        printStatusSummary();
    });

// 5. cah logs
cli
    .command("logs", "查看运行日志")
    .option("-f, --follow", "实时追踪后续日志更新")
    .option("-n, --lines <number>", "显示的最新行数", { default: 30 })
    .action(async (options) => {
        const logPath = path.join(LOGS_DIR, "hub.log");
        if (!fs.existsSync(logPath)) {
            console.log(pc.yellow(`[!] 日志文件尚未生成: ${logPath}`));
            return;
        }

        const linesToShow = parseInt(options.lines, 10) || 30;
        printLogsSummary(linesToShow);

        if (options.follow) {
            console.log(pc.dim("\n[正在实时监听日志更新 (按 Ctrl+C 退出)...]\n"));
            let currentSize = fs.statSync(logPath).size;

            fs.watchFile(logPath, { interval: 500 }, () => {
                try {
                    const newStat = fs.statSync(logPath);
                    if (newStat.size > currentSize) {
                        const stream = fs.createReadStream(logPath, {
                            start: currentSize,
                            end: newStat.size,
                            encoding: "utf-8",
                        });
                        stream.pipe(process.stdout);
                        currentSize = newStat.size;
                    } else if (newStat.size < currentSize) {
                        currentSize = newStat.size;
                    }
                } catch {}
            });
        }
    });

// 6. cah config
cli
    .command("config", "交互式配置飞书、钉钉、微信通道与参数")
    .action(async () => {
        await showConfigWizard();
    });

// 7. cah mcp
cli
    .command("mcp", "启动 stdio MCP 协议服务端 (供 Claude Desktop/Cursor 直连)")
    .action(async () => {
        const distMcp = path.join(ROOT_DIR, "dist", "mcp-server.js");
        const srcMcp = path.join(ROOT_DIR, "src", "mcp-server.ts");

        if (fs.existsSync(distMcp)) {
            await import(pathToFileURL(distMcp).href);
        } else {
            await import(pathToFileURL(srcMcp).href);
        }
    });

// 8. cah notify
cli
    .command("notify <message> [agent] [project]", "向各已配置通道推送通知消息")
    .action(async (message, agent, project) => {
        await sendNotification(message, agent || "智能体", project || process.cwd());
    });

cli.help();
cli.version("1.0.0");

// 交互式主菜单 fallback
async function showInteractiveMenu(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" Chat Agent Hub (CAH) 控制面板 ")));

    while (true) {
        const pid = getRunningPid();
        const config = getConfig();
        const allAgents = detectInstalledAgents(config.workDir);
        const installed = allAgents.filter((a) => a.installed);
        const defAgent = resolveDefaultAgent(config, allAgents);

        const mcpCount = installed.filter((a) => a.mcpConfigured).length;
        const mcpTag = installed.length > 0
            ? (mcpCount === installed.length
                ? pc.green(`已就绪 (${mcpCount}/${installed.length})`)
                : pc.yellow(`部分未配 (${mcpCount}/${installed.length})`))
            : pc.gray("未检测到");

        p.note(
            [
                `服务状态:   ${pid ? pc.green(`● 运行中 (PID: ${pid})`) : pc.gray("○ 未运行")}`,
                `默认智能体: ${pc.cyan(defAgent.name)} (模式: ${config.defaultAgent || "auto"})`,
                `MCP 接入:   ${mcpTag}`,
                `数据目录:   ${pc.dim(DATA_DIR)}`,
            ].join("\n"),
            "系统概览"
        );

        const action = await p.select({
            message: "请选择操作:",
            options: [
                { value: "start-console", label: "控制台前台启动", hint: "实时输出/按 q 停止返回/按 Ctrl+C 退出" },
                { value: "start-silent", label: "后台静默启动", hint: "系统无感常驻，无黑窗口" },
                { value: "stop", label: "停止后台服务", hint: pid ? pc.red(`正在运行 (PID: ${pid})`) : "当前未运行" },
                { value: "restart", label: "平滑重启服务", hint: "重新加载通道配置" },
                { value: "status", label: "查看运行状态与通道", hint: "健康度、连接数、智能体" },
                { value: "config", label: "通道配置向导", hint: "添加/管理飞书、钉钉、微信" },
                { value: "logs", label: "查看运行日志", hint: "tail 最近 30 行" },
                { value: "exit", label: "退出控制面板" },
            ],
        });

        if (action === "exit") {
            p.outro(pc.dim("再见！"));
            break;
        }
        if (p.isCancel(action)) {
            await confirmExitPrompt();
            continue;
        }

        if (action === "start-console") {
            const readiness = checkChannelsReadiness();
            if (!readiness.hasAnyEnabled) {
                p.log.warn(pc.yellow("当前尚未启用任何消息通道 (微信、飞书、钉钉均处于关闭状态)。"));
                const goConfig = await p.confirm({
                    message: "未配置任何通道将无法接收消息。是否立即前往「通道配置向导」？",
                    initialValue: true,
                });
                if (p.isCancel(goConfig)) {
                    await confirmExitPrompt();
                    continue;
                }
                if (goConfig) {
                    await showConfigWizard();
                }
                continue;
            }

            const { execCmd, execArgs } = resolveBridgeExec();
            const child = spawn(execCmd, execArgs, { cwd: DATA_DIR, stdio: "inherit" });

            let receivedSigint = false;
            const sigintHandler = () => {
                receivedSigint = true;
            };
            process.on("SIGINT", sigintHandler);

            const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
                child.on("exit", (code, signal) => resolve({ code, signal }));
            });

            process.off("SIGINT", sigintHandler);
            ensureTerminalClean();

            // 如果是通过 Ctrl+C (退出码 130) 或 SIGINT 退出，触发全局退出二次确认
            if (receivedSigint || exitResult.code === 130 || exitResult.signal === "SIGINT") {
                await confirmExitPrompt();
            }
        } else if (action === "start-silent") {
            const readiness = checkChannelsReadiness();
            if (!readiness.readyForDaemon) {
                p.log.warn(pc.yellow(`无法进行后台静默启动: ${readiness.reason}`));
                const goConfig = await p.confirm({
                    message: "是否立即前往「通道配置向导」进行通道配置与登录？",
                    initialValue: true,
                });
                if (p.isCancel(goConfig)) {
                    await confirmExitPrompt();
                    continue;
                }
                if (goConfig) {
                    await showConfigWizard();
                }
                continue;
            }

            const res = startDaemon();
            if (res.success) p.log.success(pc.green(`已在后台成功启动！(PID: ${res.pid})`));
            else p.log.warn(res.alreadyRunning ? `服务已在运行 (PID: ${res.pid})` : `启动失败: ${res.error}`);
        } else if (action === "stop") {
            const curPid = getRunningPid();
            if (curPid) {
                stopDaemon(curPid);
                p.log.success(pc.green(`已停止服务 (PID: ${curPid})`));
            } else {
                p.log.warn("服务当前未在运行。");
            }
        } else if (action === "restart") {
            const res = restartDaemon();
            if (res.success) p.log.success(pc.green(`服务已成功重启！(PID: ${res.pid})`));
            else p.log.error(`重启失败: ${res.error}`);
        } else if (action === "status") {
            printStatusSummary();
            await waitForMenuReturn();
        } else if (action === "config") {
            await showConfigWizard();
        } else if (action === "logs") {
            printLogsSummary(30);
            await waitForMenuReturn();
        }
    }
}

// 执行解析
cli.parse(process.argv, { run: false });

if (!cli.matchedCommand && process.argv.slice(2).length === 0) {
    showInteractiveMenu().catch((err) => {
        console.error(pc.red("控制面板异常:"), err);
    });
} else {
    cli.runMatchedCommand();
}
