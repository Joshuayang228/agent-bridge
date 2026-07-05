# Agent Bridge

> 一根「够得着 agent」的通道——agent 跑在你的电脑上（有手、能跑 shell、能控文件），人在外面用手机就能指挥它干活、看它跑到哪、在关键动作上拍板（批准 / 否决）。

不是又一个 chatbot UI，是一个**通用 agent 网关**：定一个极简协议，任何后端 agent 都能挂上来获得手机通道。配一个从零写的 Mock + Claude Code demo 即可演示，后续可挂你自己的 agent。

## 核心特性

- **手机端 Web App**：浏览器打开即用，零安装、跨平台。扫码配对自动连接。
- **多 agent 接入**：通过 `AgentProvider` 接口统一抽象，配置驱动挂载多个 agent 引擎。
- **流式输出**：WebSocket JSON-RPC 推送 `delta` 事件，逐字渲染；OpenAI 兼容 SSE 端点。
- **能力白名单 + 危险操作审批**：`allowedTools` 限定 agent 可用工具；`dangerousTools` 触发手机端「批准 / 否决」。
- **多会话管理**：每个 agent 可开多个会话，独立上下文，可切换 / 删除。
- **Agent 主动推送**：通过 `schedule` 配置定时触发，agent 可主动给手机发消息。
- **PWA 支持**：手机可「添加到主屏幕」作为独立 App。
- **安全设计**：配对码鉴权 + device token + 路径穿越防护 + XSS 防护（DOMPurify）。

## 快速开始

### 环境要求

- Node.js 18+（使用了原生 fetch、WebSocket 等现代 API）
- 可选：Claude Code CLI（要接通 Claude Code agent 时需要，已安装 `claude` 命令即可）

### 安装

```bash
git clone https://github.com/Joshuayang228/agent-bridge.git
cd agent-bridge
npm install
```

### 运行

```bash
npm start
```

启动后终端会输出：

```
┌──────────────────────────────────────────────────────┐
│  Agent Bridge 已启动                                   │
│  配对码:    972669                                     │
│  扫码页:    http://localhost:18789/pair                │
│  局域网:    http://192.168.x.x:18789/pair              │
│  Agents:    3 个已加载                                 │
└──────────────────────────────────────────────────────┘

提示：在电脑浏览器打开 http://localhost:18789/pair 看到二维码，用手机扫码即可配对。
```

### 配对（两种方式）

**方式一：扫码（推荐）**

1. 在电脑浏览器打开 `http://localhost:18789/pair`
2. 页面显示二维码 + 配对码
3. 手机摄像头扫码 → 自动打开 Web App 并完成配对

**方式二：手动输入配对码**

1. 手机浏览器打开 `http://<电脑IP>:18789`
2. 输入终端显示的 6 位配对码（如 `972669`）

配对成功后，会拿到一个 `device token`（保存在 localStorage），下次打开自动连接，无需再配对。

## 使用流程

### 在 Web App 中

1. **选择 agent**：顶部下拉选择，会显示能力标签（`chat` / `shell` / `files` 等，`shell` 标红）
2. **发消息**：底部输入框回车发送，发送后立即显示「思考中」动画
3. **看流式输出**：agent 回复逐字渲染，支持完整 Markdown（代码高亮 + 表格 + 列表）
4. **审批弹窗**：agent 调用危险工具时，底部弹出审批条，显示 agent 名 + 操作描述，批准或否决
5. **多会话**：左上角菜单展开侧边栏，新建 / 切换 / 删除会话
6. **代码块复制**：hover 代码块右上角「复制」按钮

### 通过 OpenAI 兼容 API

启动时设置 `GATEWAY_TOKEN` 环境变量：

```bash
# Windows PowerShell
$env:GATEWAY_TOKEN="test-secret"; npm start

# Linux/macOS
GATEWAY_TOKEN=test-secret npm start
```

调用 OpenAI 兼容端点（任何 OpenAI SDK 都能用）：

```bash
# 非流式
curl -X POST http://localhost:18789/v1/chat/completions \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-code","messages":[{"role":"user","content":"你好"}]}'

# 流式（SSE）
curl -N -X POST http://localhost:18789/v1/chat/completions \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-code","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

`model` 字段填 agent id（如 `mock`、`mock-echo`、`claude-code`）。

## Agent 配置

编辑 [agents.config.json](agents.config.json) 添加 / 修改 agent：

```json
{
  "agents": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "type": "claude-code",
      "capabilities": ["chat", "shell", "files", "tools"],
      "allowedTools": ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
      "dangerousTools": ["Bash", "Write", "Edit"]
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `id` | 全局唯一标识，用作 OpenAI API 的 `model` 字段 |
| `name` | 显示名 |
| `type` | Provider 类型：`mock` / `claude-code` |
| `capabilities` | 能力标签数组，会显示在 UI 上 |
| `allowedTools` | 传给 agent CLI 的工具白名单（如 Claude Code 的 `--allowedTools`） |
| `dangerousTools` | `allowedTools` 的子集，调用时触发手机审批 |
| `schedule` | 可选，定时触发：`{"intervalMs": 60000, "prompt": "..."}` |
| `config` | 可选，Provider 自定义配置（如 mock 的 `{"mode": "echo"}`） |

### 新增 agent 引擎

写一个实现 `AgentProvider` 接口的 Provider，在 [src/providers/registry.ts](src/providers/registry.ts) 注册工厂函数即可：

```typescript
const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  mock: (config) => new MockProvider(config),
  "claude-code": (config) => new ClaudeCodeProvider(config),
  "my-agent": (config) => new MyAgentProvider(config), // ← 新增
};
```

## 技术栈

- **Node.js + TypeScript**：服务端单进程单端口复用 WS + HTTP + 静态托管
- **ws**：WebSocket 实现
- **vitest**：单元测试（32 个测试覆盖 auth / sessions / providers / registry）
- **marked + DOMPurify + highlight.js**：前端 Markdown 渲染 + XSS 防护 + 代码高亮
- **qrcode (esm.sh)**：扫码配对页二维码渲染

## 项目结构

```
.
├── src/
│   ├── index.ts                  # 入口：加载配置 + 启动 Gateway
│   ├── protocol/
│   │   └── frames.ts             # 通讯协议帧定义（req/res/event）
│   ├── providers/
│   │   ├── types.ts              # AgentProvider 接口 + AgentEvent 类型
│   │   ├── mock-provider.ts      # Mock agent（流式 + echo + 审批演示）
│   │   ├── claude-code-provider.ts # Claude Code CLI 接入
│   │   └── registry.ts           # 配置驱动的 provider 注册表
│   └── gateway/
│       ├── server.ts             # HTTP + WS 单服务器（含 /pair 路由）
│       ├── auth.ts               # 配对码 + device token 认证
│       ├── session-manager.ts    # 多会话 CRUD
│       ├── connection-manager.ts # WS 连接池 + 广播
│       ├── ws-handler.ts         # WS 协议处理（connect/req/event/approval）
│       ├── openai-http.ts        # OpenAI 兼容 HTTP/SSE 端点
│       └── cron-scheduler.ts    # Agent 定时主动触发
├── web/
│   ├── index.html                # Web App（手机端）
│   ├── pair.html                 # 扫码配对页（主机端展示）
│   ├── manifest.json             # PWA manifest
│   └── icon.svg                  # PWA 图标
├── agents.config.json            # Agent 配置
├── docs/                         # 设计文档 + 决策记录
└── package.json
```

## 测试

```bash
npm test           # 运行 vitest
npm run typecheck  # tsc --noEmit 类型检查
```

覆盖：配对码生成 / device token 颁发 / 会话 CRUD / mock provider 流式输出 / registry 配置加载。

## 安全设计

| 层 | 机制 |
|------|------|
| 配对鉴权 | 6 位配对码（启动时显示）→ device token（持久化），未配对连接拒绝 |
| API 鉴权 | OpenAI 端点要求 `GATEWAY_TOKEN` 或 device token（Bearer） |
| 能力白名单 | `allowedTools` 限定 agent 可调用工具，默认走白名单 |
| 危险操作审批 | `dangerousTools` 触发手机端「批准 / 否决」交互 |
| 路径穿越 | 静态文件服务做 `WEB_DIR` 前缀检查 |
| XSS | Markdown 渲染走 DOMPurify |
| 错误信息 | 对外只暴露用户友好内容，不泄露堆栈 / 内部路径 |

## 远程访问（外出时用手机连家中 agent）

Gateway 默认绑定 `0.0.0.0`，支持局域网直连。外出时通过内网穿透：

**Tailscale（推荐，零配置）**

1. 家里电脑和手机都装 Tailscale 客户端 + 登录同一账号
2. 启动 Gateway 后，手机用 Tailscale IP 访问 `http://<tailscale-ip>:18789/pair` 扫码
3. 配对后手机随时随地都能连回家中 agent

**Cloudflare Tunnel（公网域名）**

```bash
cloudflared tunnel --url http://localhost:18789
```

> ⚠️ 公网暴露时务必设置 `GATEWAY_TOKEN` 环境变量，否则任何人拿到配对码都能配对。

## 路线图

- [x] WebSocket JSON-RPC 协议 + 流式输出
- [x] 配对码 + device token 认证
- [x] 多会话管理
- [x] 能力白名单 + 危险操作审批
- [x] OpenAI 兼容 HTTP/SSE 端点
- [x] Agent 定时主动推送
- [x] 扫码配对 + PWA 支持
- [ ] 接入 my-agent（用户自己的 agent 引擎）
- [ ] 远程穿透配置文档 + 实测
- [ ] 工具安全等级表（agent 接入时声明工具等级，Gateway 自动归类）

## 设计文档

- [docs/progress.md](docs/progress.md) — 进度时间线
- [docs/decisions.md](docs/decisions.md) — 关键技术决策记录
- [docs/pitfalls.md](docs/pitfalls.md) — 踩坑记录
- [AGENTS.md](AGENTS.md) — 项目规则（自包含权威规则源）

## 许可证

MIT
