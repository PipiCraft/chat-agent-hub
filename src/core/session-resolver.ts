import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

/**
 * 探测指定工作目录下当前活跃的 Claude Code 交互会话 ID
 */
export function resolveActiveClaudeSession(workDir: string): string | null {
    const resolvedTarget = path.resolve(workDir).toLowerCase();

    // 1. 优先从 claude agents --json 获取当前正在前台运行的交互式会话 ID
    try {
        const stdout = execSync("claude agents --json", {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
            windowsHide: true,
        });
        const list = JSON.parse(stdout);
        if (Array.isArray(list)) {
            const matched = list.find((item) => {
                const itemCwd = item.cwd ? path.resolve(item.cwd).toLowerCase() : "";
                return itemCwd === resolvedTarget && item.sessionId;
            });
            if (matched?.sessionId) return matched.sessionId;
        }
    } catch {}

    // 2. 回退：扫描 ~/.claude/projects/ 下该项目最近更新的 .jsonl 会话文件
    try {
        const homedir = os.homedir();
        const projectsDir = path.join(homedir, ".claude", "projects");
        if (fs.existsSync(projectsDir)) {
            const entries = fs.readdirSync(projectsDir);
            const targetBase = path.basename(workDir).toLowerCase().replace(/[^a-z0-9]/g, "");
            for (const entry of entries) {
                const normEntry = entry.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (normEntry.includes(targetBase)) {
                    const projFolder = path.join(projectsDir, entry);
                    if (fs.statSync(projFolder).isDirectory()) {
                        const files = fs.readdirSync(projFolder)
                            .filter((f) => f.endsWith(".jsonl"))
                            .map((f) => ({
                                id: f.replace(/\.jsonl$/, ""),
                                mtime: fs.statSync(path.join(projFolder, f)).mtimeMs,
                            }))
                            .sort((a, b) => b.mtime - a.mtime);
                        if (files.length > 0) {
                            return files[0].id;
                        }
                    }
                }
            }
        }
    } catch {}

    return null;
}
