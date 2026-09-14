export type AgentKey = "auto" | "claude" | "opencode" | "hermes" | "codex" | "pi" | "openclaw" | string;

export type SourceType = "desktop" | "cli" | "bridge" | string;

export interface WechatChannelConfig {
    enabled: boolean;
}

export interface FeishuChannelConfig {
    enabled: boolean;
    appId: string;
    appSecret: string;
    defaultChatId?: string;
}

export interface DingtalkChannelConfig {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
}

export interface ProjectConfig {
    name: string;
    path: string;
}

export interface CustomAgentConfig {
    key: string;
    name: string;
    aliases?: string[];
    cmd: string;
    args?: string[];
}

export interface Config {
    machineName: string;
    defaultAgent: string;
    sessionIdleMinutes: number;
    logRetentionDays: number;
    workDir: string;
    notifyChannels: string[];
    projects: ProjectConfig[];
    customAgents?: CustomAgentConfig[];
    channels: {
        wechat: WechatChannelConfig;
        feishu: FeishuChannelConfig;
        dingtalk: DingtalkChannelConfig;
    };
}

export interface Instance {
    id: string;
    num: number;
    agentKey: string;
    agentName: string;
    projectName: string;
    workDir: string;
    source: SourceType;
    sourceLabel: string;
    sessionId: string;
    turnCount: number;
    active: boolean;
    createdAt: number;
    lastActiveAt: number;
}

export interface ActiveFocus {
    instanceId: string;
    num: number;
    agentKey: string;
    agentName: string;
    projectName: string;
    workDir: string;
    source: string;
    updatedAt: number;
}

export interface QuestionOption {
    label: string;
    action: string;
}

export interface PendingQuestion {
    reqId: number;
    id?: string;
    answered?: boolean;
    answer?: string | null;
    projectName?: string;
    agentName?: string;
    feishuPushed?: boolean;
    dingtalkPushed?: boolean;
    toolCallId?: string;
    question: string;
    options: any[];
    createdAt: number;
    timeoutMs?: number;
    channel?: string;
    userId?: string;
    replyContext?: any;
    status?: "pending" | "resolved" | "expired";
    resolvedAnswer?: string;
}

export interface ReplyTarget {
    channel: "wechat" | "feishu" | "dingtalk" | string;
    userId: string;
    replyContext?: any;
    contextToken?: string;
    workDir?: string;
}

export interface FeishuTarget {
    openId?: string;
    chatId?: string;
}

export interface DingtalkTarget {
    webhook?: string;
    userId?: string;
}

export interface WechatAuth {
    baseUrl: string;
    botToken: string;
    userId: string;
}

export interface AgentRunnerResult {
    output: string;
    isQuestion?: boolean;
    isFinished?: boolean;
}

export interface InstalledAgentInfo {
    key: string;
    name: string;
    installed: boolean;
    path?: string;
    aliases?: string[];
    custom?: boolean;
    mcpConfigured?: boolean;
    mcpDetails?: string;
    mcpHint?: string;
}
