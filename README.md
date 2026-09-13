# Chat Agent Hub

> **本地多通道 AI 智能体跨端调度中枢**  
> 将微信、飞书、钉钉连接到本地 AI 编程工具，随时随地通过手机下发编程任务、审批敏感操作、接收进度通知。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()

---

## 核心亮点

- **全通道长连接直连（免公网 IP / 免内网穿透）**：
  - **微信**：基于 OpenClaw 协议直连，控制台扫码即登，深度解决 PC 微信 CommonMark 换行折叠问题，支持超长输出智能分片。
  - **飞书**：官方 WebSocket 长连接直连，独家支持 Interactive Card（富文本交互卡片）一键点击审批与任务切换。
  - **钉钉**：官方 Stream 模式长连接直连，免公网回调，支持 Markdown 消息渲染与请示审批。
- **多智能体矩阵与开放扩展**：
  - 原生内置支持主流 AI 编程工具：**Claude Code**、**OpenCode**、**Hermes**、**Codex**、**Pi**、**OpenClaw**。
  - 启动自检**仅显示本机实际已就绪的工具**，拒绝未安装项干扰。
  - 支持在 `config.json` 中配置任意**外部自定义智能体**，支持 `{prompt}`、`{workDir}`、`{sessionId}` 动态参数占位符。
- **会话级保活与空闲看门狗**：
  - **连贯追问保活**：任务完成后在设定的保活窗口（默认 15 分钟）内保持待命，继续发消息自动连贯追问，无需反复新建任务。
  - **空闲自动释放**：超过保活时长无操作，看门狗自动释放任务并清理编号；全部空闲后转入零占用待命态，新需求自动拉起。
- **人机交互审批（MCP 支持）**：
  - 智能体执行高危系统命令或技术方案抉择时，通过 MCP 工具主动向手机发起请示并挂起等待。
  - 飞书支持卡片按钮一键确认/拒绝；微信与钉钉支持回复数字编号或「同意 101」快速放行。
- **极简跨平台运维（仅 2 个管理脚本）**：
  - **Windows (`run.bat`)**：内置控制台模式（扫码/日志）与后台静默模式（**无黑窗口常驻桌面**）；已运行时再次双击按回车即可一键停止。
  - **Linux / macOS (`run.sh`)**：支持后台守护启动（nohup）、前台运行与一键安全停止。
- **系统健康度与磁盘自洁**：
  - 手机端回复「状态」，随时掌握服务运行时间（Uptime）、内存占用、当前活动任务。
  - 启动时自动清理超过 14 天的历史日志（`logs/`），长期常驻零垃圾累积。

---

## 安装与快速上手

### 1. 环境准备

- **运行环境**：Node.js >= 18.0.0
- **系统平台**：Windows 10/11、Linux、macOS

```bash
git clone https://github.com/PipiCraft/chat-agent-hub.git
cd chat-agent-hub
npm install
```

### 2. 配置文件

复制模板生成本地 `config.json`（若直接启动，系统也会自动根据模板创建）：

```bash
cp config.example.json config.json
```

核心配置示例（按需启用对应通道并填入凭证）：

```json
{
  "machineName": "我的工作站",
  "defaultAgent": "auto",
  "sessionIdleMinutes": 15,
  "channels": {
    "wechat": {
      "enabled": true
    },
    "feishu": {
      "enabled": false,
      "appId": "",
      "appSecret": ""
    },
    "dingtalk": {
      "enabled": false,
      "clientId": "",
      "clientSecret": ""
    }
  }
}
```

> 完整高级配置项（多工作区 `projects`、自定义智能体 `customAgents`、日志清理天数等）可直接参考 [`config.example.json`](config.example.json)。

---

### 3. 服务启停与日常使用

系统已将多平台运维脚本统一合并为 2 个入口文件：

#### Windows 环境（推荐双击交互）：
- **初次启动 / 扫码登录**：
  直接双击 `run.bat`，按 **回车** 进入控制台模式，在黑窗口中扫描微信登录二维码；扫码成功后凭证将自动持久化保存在本地。
- **日常使用（后台静默模式，无黑窗口）**：
  双击 `run.bat`，输入 **2** 然后回车。服务将在系统后台无感常驻，**启动窗口会立即自动关闭退出，完全不占桌面与任务栏**。
- **停止服务**：
  再次双击 `run.bat`，脚本自动检测后台运行中的 PID，直接按 **回车** 即可一键安全停止。
- **命令行快捷调用（PowerShell 请加 `.\`，CMD 可直接运行）**：
  ```bash
  .\run.bat           # 打开交互式菜单 (按 c 可进配置向导)
  .\run.bat start     # 控制台前台启动
  .\run.bat start -s  # 后台静默启动（无窗口常驻）
  .\run.bat stop      # 停止后台服务
  .\run.bat restart   # 重启服务
  .\run.bat status    # 查询当前运行状态与 PID
  .\run.bat config    # 通道配置助手 (交互式添加/修改飞书、钉钉并自动重启)
  ```

#### Linux / macOS 环境：
```bash
./run.sh            # 交互式管理菜单 (输入 c 进配置向导)
./run.sh start      # 前台控制台模式启动
./run.sh start -d   # 后台守护模式启动 (nohup)
./run.sh stop       # 停止后台服务
./run.sh restart    # 重启服务
./run.sh status     # 查看运行状态
./run.sh logs       # 查看最近运行日志
./run.sh config     # 打开通道配置向导
```

---

## 消息通道配置指南

### 微信通道（扫码直连）
- 将 `config.json` 中 `channels.wechat.enabled` 设为 `true`。
- 启动服务后，使用手机微信扫描控制台输出的二维码即可登录。登录凭证自动保存至 `auth.json`，后续启动免扫码直连。

### 飞书通道（WebSocket 长连接）
1. 登录 [飞书开放平台](https://open.feishu.cn/)，创建「企业自建应用」并添加「机器人」能力。
2. 在「权限管理」中开通 `im:message`（获取与发送单聊/群聊消息）权限。
3. 在「事件与回调」中将订阅方式设置为 **长连接 (WebSocket)**：
   - 在「事件配置」中添加事件：`im.message.receive_v1`（接收消息）。
   - *(可选)* 在「回调配置」中添加回调：`card.action.trigger`（卡片回传交互，用于在手机端一键点击审批卡片按钮；若未配置，也可直接回复文字「同意 101」审批）。
4. 发布应用版本，将凭证 `App ID` 和 `App Secret` 填入 `config.json` 中的 `channels.feishu`，将 `enabled` 设为 `true`。

### 钉钉通道（Stream 模式）
1. 登录 [钉钉开发者后台](https://open-dev.dingtalk.com/)，创建企业内部应用。
2. 在「应用能力」中添加「机器人」，消息接收模式选择 **Stream 模式**，保存并发布。
3. 在「凭证与基础信息」中获取 `Client ID` 与 `Client Secret`。
4. 将凭证填入 `config.json` 中的 `channels.dingtalk`，将 `enabled` 设为 `true`。

---

## 智能体集成配置 (MCP)

Hub 内置提供兼容 Model Context Protocol 的服务端脚本 `mcp-server.mjs`，为本地 AI 工具提供跨端交互能力：
- `notify_agent`：向手机端发送进度汇报或长任务完成通知。
- `ask_agent`：向手机端发起方案决策或执行审批，挂起等待手机用户答复（支持选项与超时回退）。

可将 `mcp-server.mjs` 作为 stdio MCP 服务直接挂载至任意支持 MCP 的智能体或客户端（如 Claude Code、Codex 等）。

---

## 自定义智能体扩展指南

如果希望接入其他本地命令行智能体或自研脚本，只需在 `config.json` 中添加 `customAgents` 项：

```json
{
  "customAgents": [
    {
      "key": "deepseek",
      "name": "DeepSeek Coder",
      "aliases": ["ds", "deepseek"],
      "cmd": "deepseek-cli",
      "args": ["run", "{prompt}", "--dir", "{workDir}"]
    }
  ]
}
```

- **参数占位符**：
  - `{prompt}`：自动替换为手机端发送的用户指令。
  - `{workDir}`：自动替换为当前任务绑定的工作目录绝对路径。
  - `{sessionId}`：自动替换为当前任务的会话上下文 ID。
- 系统会在启动时自动检测 `cmd` 在系统 PATH 中是否可用，并在手机端「助手」列表中自动挂载呈现。

---

## 移动端指令参考手册

在微信、飞书、钉钉中直接向机器人发送以下文本指令即可操作调度中枢：

| 指令 | 说明 | 示例 |
| :--- | :--- | :--- |
| **`菜单`** / **`?`** | 查看全部可用指令说明 | `菜单` |
| **`状态`** / **`系统状态`** | 查看 Hub 运行健康度、Uptime、内存占用与当前焦点 | `状态` |
| **`列表`** | 查看当前所有活动任务详情及焦点 (飞书支持卡片一键操作) | `列表` |
| **`切换 <编号>`** | 切换当前操控的任务焦点 | `切换 2` |
| **`新任务 [名称]`** | 创建独立新任务（继承当前环境） | `新任务 接口重构` |
| **`cd <路径>`** | 切换当前任务生效的工作目录 | `cd ./my-project` |
| **`助手 [编号/名称]`** | 查看当前已安装智能体，或切换当前任务的智能体 | `助手` 或 `助手 2` 或 `助手 opencode` |
| **`默认助手 <编号/名称>`**| 更改全局默认智能体并持久化保存 | `默认助手 claude` |
| **`关闭 <编号>`** | 手动关闭并释放指定任务 | `关闭 2` |
| **`停止`** / **`取消`** | 强制终止当前任务正在运行的子进程树 | `停止` |
| **`改动`** / **`diff`** | 查看当前任务工作目录的 Git 变更统计与 diff | `改动` |
| **`日志`** | 查看当前任务控制台最新的执行日志片段 | `日志` |
| **`推送 [渠道]`** | 查看或配置本地任务通知的目标渠道 | `推送 微信 飞书` |
| **`通道`** / **`添加飞书`** | 查看各通道启用状态与添加飞书/钉钉接入指南 | `通道` 或 `添加飞书` |
| **`保活 [分钟]`** | 查看或修改任务空闲自动释放窗口 | `保活 30` |
| **`同意` / `拒绝`** | 审批智能体提出的高危操作或方案请求 | `同意 101` / `拒绝 101` / 直接回复选项数字 `1` |

> **多端交互说明**：
> - **微信与钉钉**：采用整洁的 Markdown 排版，支持回复「切换 2」、「换助手 1」、「同意 101」等快速操控。
> - **飞书**：支持专属 Interactive Card（交互卡片），发送「列表」或「智能体」时输出按钮卡片，支持免键盘一键点击操作。

---

## 外部脚本通知 (CLI)

除了智能体自主调用 MCP 外，还可以通过 `notify.mjs` 在外部脚本、自动化部署流程或 Git Hook 中主动推流通知至手机：

```bash
node notify.mjs "构建任务成功完成，耗时 42 秒。" "构建机器人" "./projects/frontend"
```

---

## 贡献与许可

欢迎提交 Issue 与 Pull Request 协助改进项目。

本项目基于 [MIT License](LICENSE) 协议开源。
