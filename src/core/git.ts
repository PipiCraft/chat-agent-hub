import { execSync } from "node:child_process";

export interface GitSummaryResult {
    hasChanges: boolean;
    summary: string;
}

/**
 * 获取指定目录的 Git 变动状态与统计摘要
 */
export async function getGitSummary(workDir: string): Promise<GitSummaryResult | null> {
    try {
        const status = execSync("git status --short", { cwd: workDir, encoding: "utf-8", timeout: 3000 });
        if (!status || !status.trim()) {
            return { hasChanges: false, summary: "代码无未提交改动。" };
        }
        let diff = "";
        try {
            diff = execSync("git diff --stat", { cwd: workDir, encoding: "utf-8", timeout: 5000 });
        } catch {}

        const lines = status.trim().split("\n");
        const summary = `Git 变动 (${lines.length} 个文件):\n${status.trim()}${diff.trim() ? "\n\n" + diff.trim() : ""}`;
        return { hasChanges: true, summary };
    } catch {
        return null;
    }
}

/**
 * 获取完整的 git diff (限长 2000 字符)
 */
export async function getGitFullDiff(workDir: string): Promise<string> {
    try {
        const diff = execSync("git diff HEAD", { cwd: workDir, encoding: "utf-8", timeout: 5000 });
        if (!diff || !diff.trim()) {
            return "暂无已追踪文件的修改。";
        }
        if (diff.length > 2000) {
            return diff.slice(0, 2000) + "\n\n...(diff 过长，已截断)";
        }
        return diff;
    } catch (e: any) {
        return `获取 diff 失败: ${e?.message}`;
    }
}
