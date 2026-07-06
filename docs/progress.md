# trae大赛 — 进展记录

> 按时间顺序追加，新内容在下方。AI 在每次实质推进后追加，同时更新"当前状态"。

## 当前状态

**自用工具**（2026-07-06 退出 Trae 大赛）：手机遥控家里 agent 的「通道」——agent 跑在电脑上，人在外面用手机指挥、看进度、危险动作远程批准/否决。定位是「揣在兜里的操作员驾驶舱」。

**已落地**：Node.js/TS Gateway + Web App + WS JSON-RPC + 扫码配对 + 多会话 + 能力白名单 + ClaudeCodeProvider + OpenAI 兼容 API + SessionWatcher（CC/Codex 续接）+ **云端 Relay + SQLite 持久化**（断连重连拉历史 + 审批状态全局化 + agent 状态广播）。GitHub: https://github.com/Joshuayang228/agent-bridge

**参考教材**：`_reference/openclaw-1/`、`_reference/paseo-main/`（2026-07-06 新增）

**下一步优先级**（自用导向）：
1. 部署云端 VPS（WSS + 域名 + Caddy 反代）——relay 代码已就绪，待真实环境打磨
2. 接 my-agent 作为首要下游 Provider
3. 日常体验打磨（chat.send 通过 relay 上行、推送通知等）

---

## 进展记录

### [2026-07-04] 项目启动

- 项目建立，初始化基础文件结构（CLAUDE.md + docs/）

### [2026-07-04] 选题确定：桌面伙伴（桌宠 × my-agent 引擎）

- **确认约束**：Trae 大赛只要求「用 Trae 开发」，作品形态不限；美术资产用 gpt-image-2 生成；代码基座 fork my-agent。
- **选题逻辑**：桌宠踩在三个优势交叉点——(1) my-agent 已完成最难的 Agent 引擎（Loop/向量记忆/人格模板/语音/托盘/20 工具），桌宠是给成熟引擎换「活的表现层」，风险和工作量都小；(2) Demo 冲击力碾压聊天窗口，第一眼记得住；(3) 是「数字伙伴而非命令式工具」产品哲学的最终形态。
- **差异化赢点**：不是靠画风萌，而是「有真正 agent 大脑的桌面伙伴」——长期记忆、能调工具、人格进化、主动感知搭话。别人抄不走，因为没有这套引擎。
- **审阅 my-agent 代码后确认 fork 可行**：纯 Web 技术栈（React 19 + Vite + sql.js WASM，无原生编译模块），`npm install` 可直接跑。
- **识别出 fork 的三个改造点**（详见 decisions.md）：① 窗口形态改根（透明/无边框/置顶/点击穿透）；② 单窗→双窗架构（pet window + chat window 共享 runtime）；③ fork 后版本分叉，my-agent 视为「素材库」而非「上游」。
- **下一步**：产品设计——桌宠形态、情绪/状态机、主动行为触发、与聊天窗的唤起关系。

### [2026-07-04] Fork 落地并验证 + 两项设计决策确定

- **Fork 方式**：用 `git clone` 本地 my-agent 仓库到 `trae大赛/desktop-pet/`，只带 git 追踪文件（自动跳过 node_modules/dist），保留完整提交历史（含 4 个未推送 commit）。clone 后立即移除 origin remote，防误推回 my-agent 上游。
- **Fork 验证通过（实证「无雷」）**：`npm install` 装 739 包无致命错误 → `tsc --noEmit` 零错误 → `vitest run` 139 测试全过（15 文件）。fork 可跑得到证实。
- **主动性档位**：定为「定时主动搭话」——复用 my-agent 现有 Scheduler，不新建感知/触发子系统，控制范围。
- **优先级**：两周赛程内先跑通形态闭环（桌宠能显示、能动、能唤起对话），再谈丰富度。
- **动画技术方案**：定为 **序列帧动画 + CSS 辅助**（详见 decisions.md）。核心理由：gpt-image-2 只能出静态图，序列帧是唯一「直接吃 AI 静态图、无需建模绑骨、Electron 集成零门槛」的路径，两周可落地。Live2D/Spine/Rive/Lottie 都要自建动画工程，发挥不出 AI 出图优势，且学习曲线陡。
- **下一步**：产品设计定形态，然后动第一刀——窗口改根（透明/无边框/置顶/点击穿透）。

### [2026-07-04] 重大转向：放弃桌宠+fork，改做「手机遥控 agent 通道」（从 0 开发）

> 上面的桌宠方案与 fork 决策**已作废**，保留记录以留下决策演变轨迹。

- **为什么推翻**：意识到比赛提交通常要求把作品的使用/展示/演示权授予主办方。fork my-agent 意味着整套引擎（Loop/记忆/人格/沙箱）IP 随提交物一起交出去，为一个比赛不值得。
- **新方向**：从 0 到 1 独立开发一个「通道」——让跑在家里电脑上的 agent（有手、能跑 shell、能控文件）可被手机远程指挥。核心不是再造 agent，是做「够得着 agent 的那根线」。
- **为什么这个方向好**：① 让未来的 agent（含 my-agent）从「在工位才能用」变成「随时能召唤」，是能力质变；② 通道是协议+网关层，不含任何 my-agent 源码，独立成立可参赛；③ 精准复用「有手的 agent + 危险操作手机确认」这个稀缺框架，比「又一个 IM bot」新鲜。
- **赢点定位**：不是「手机上聊 LLM」，是「手机上远程操控一个有手的 agent，并在小屏上做人类监督（批准/否决动作）」——揣在兜里的操作员驾驶舱。安全（配对鉴权/能力白名单/破坏性操作手机确认）既是底线也是最亮的交互 demo。
- **已定决策**：手机端走**方向 A**（借现成 IM 如 Telegram/飞书当客户端，不自建 App），两周内最稳、demo 最直观。
- **已办**：① 删除 desktop-pet fork（保项目干净，比赛包无 my-agent 源码）；② 确认参考项目为 GitHub `openclaw/openclaw`（"personal AI assistant, any OS/platform"）；③ 从 my-agent 搬来自包含 harness——7 份通用 agent-skills（writing-style/code-review/debug-guide/git-workflow/security-checklist/typescript-guidelines/methodology-writing）+ 重写 CLAUDE.md 为自包含结构（剥掉 my-agent 专属的 Electron 分层/IPC 三同步/LLM 架构，因项目将独立成 repo，Trae 打开时父级 CLAUDE.md 不加载）；未搬 frontend/deploy/model-config 三份（my-agent 专属，待技术栈定后按需新写）。
- **下一步**：修复 openclaw clone → 通读其架构偷师连接方式 → 定通道最小协议与技术栈 → 确认赛程时间。

### [2026-07-04] OpenClaw 研究完成 + 最终定位与协议确定

- **OpenClaw clone 已就位**：`_reference/openclaw-1/openclaw-main/`，完成架构通读（详见对话报告）。
- **关键偷师**：① 单 Gateway 进程单端口复用 WS+HTTP ② 三帧 JSON-RPC（req/res/event）+ 两阶段运行模型（立即 ack + 流式 agent 事件 + 最终响应）③ OpenAI 兼容 SSE 端点 ④ 设备配对认证 ⑤ Tailscale 远程穿透。
- **定位最终确定**：参赛作品 = **手机接入多 agent 的完整通道工具**。自建 Web App + Node.js/TS Gateway，多 agent = 多引擎接入（对接多个 agent 后端统一暴露）。不借 IM，从 0 新写。
- **技术选型**（见 decisions.md）：Web App 手机端 / Node.js+TS Gateway / WS JSON-RPC + 流式事件 + OpenAI 兼容 SSE。
- **下一步**：设计多引擎架构 → 搭骨架 → WS 协议层 → mock provider → Web App 最小页。

### [2026-07-04] 骨架落地 + 审批机制 + Claude Code 接入

- **项目骨架完成**：Node.js + TypeScript，单进程单端口复用 WS + HTTP + 静态托管。tsc --noEmit 通过，npm install 完成。
- **WS JSON-RPC 协议层完成**：三帧（req/res/event）+ connect 握手 + hello-ok（带 agent 列表快照）+ chat.send 两阶段流式（立即 ack → delta 事件 → done）+ chat.abort + agents.list。
- **AgentProvider 接口完成**：`send(input) → AsyncIterable<AgentEvent>`，配置驱动注册表（agents.config.json → 按 type 实例化 Provider）。
- **MockProvider 完成**：逐字流式输出 + echo 模式 + **危险操作审批演示**（消息含"删除"时触发 approval_required → 等手机端批准/否决）。
- **审批机制完整链路打通**：Provider `requestApproval` 回调 → Gateway 推 `approval_required` 事件 → 手机端审批弹窗（批准/否决按钮）→ `chat.approve`/`chat.reject` → Provider 继续。这是核心交互亮点。
- **ClaudeCodeProvider 完成**：spawn `claude -p <msg> --output-format stream-json --verbose`，逐行解析 JSON：`assistant.content[].text` → delta，`tool_use` → tool_start，`tool_result` → tool_end，`result` → done。工具调用（Bash/Read/Write 等）在手机端用特殊样式显示。
- **Web App 完成**：agent 选择 + 发消息 + 逐字流式渲染 + 工具调用样式 + 审批弹窗 UI。
- **3 个 agent 已加载**：mock（测试机器人）、mock-echo（回声）、claude-code（Claude Code CLI）。
- **下一步**：OpenAI 兼容 SSE 端点 / 认证 + 远程访问 / Codex CLI 接入（待安装）。

### [2026-07-04] 认证与远程访问完成

- **AGENTS.md 对齐**：更新 AGENTS.md 背景上下文，将过时的"方案 A 借 IM"改为"自建 Web App"，状态更新为骨架已落地。
- **配对码认证系统完成**：参考 OpenClaw 的 5 种认证模式（shared-secret/device-token/tailscale/trusted-proxy/bootstrap-token），简化为**配对码 → device token 两步握手**。
  - Gateway 启动生成 6 位配对码，终端显示
  - 手机端首次连接输入配对码 → 验证 → 颁发 32 位 device token
  - device token 存 localStorage，后续连接自动认证
  - 支持 GATEWAY_TOKEN 环境变量（固定 token 模式，跳过配对）
- **远程访问完成**：绑定 0.0.0.0 让局域网可访问 + 自动检测局域网 IP 显示 + 提示 Tailscale 穿透方案。
- **Web App 配对流程**：首次打开弹出配对码输入框 → 输入后自动配对 → 后续免输入。
- **tsc --noEmit 通过**，3 个 agent 加载正常，配对码 306796 已验证。
- **下一步**：git commit / 打磨 Demo 体验 / OpenAI 兼容 SSE 端点。

### [2026-07-04] 扫码配对 + Git 初始化

- **Git 仓库初始化**：首次 commit（`330e540`），28 文件 2941 行。.gitignore 排除 _reference/node_modules/dist/.env。
- **扫码配对完成**：Gateway 启动时在终端渲染二维码（qrcode-terminal），二维码内容为 `http://<局域网IP>:<port>/?code=<配对码>`。手机扫码 → 打开 Web App → URL 参数自动配对 → 获得 device token → 后续免输入。
  - 终端显示配对码 + 二维码 + 局域网 IP
  - Web App 检测 `?code=` URL 参数，自动用配对码连接
  - Demo 体验：手机扫码即用，无需手输配对码
- **commit**：`9fbd78e` feat: QR code pairing
- **下一步**：多会话管理 / agent 主动推送 / OpenAI 兼容 SSE / push 到 GitHub。

### [2026-07-04] 多会话管理完成

- **SessionManager 完成**：内存存储，每会话绑定 agent，存消息历史。方法：create/get/list/history/addUserMessage/addAssistantMessage/delete。
- **协议扩展**：`sessions.list` / `sessions.create` / `sessions.delete` / `chat.history` 四个新方法。chat.send 时自动存用户消息 + assistant 回复到历史。
- **Web App 侧边栏**：抽屉式会话列表（≡ 按钮开关），新建会话、切换会话、加载历史。首次发消息自动创建会话，用首条消息作标题。
- **tsc --noEmit 通过**，配对+会话+历史端到端验证通过。
- **commit**：`f02fbac` feat: multi-session management
- **下一步**：agent 主动推送 / OpenAI 兼容 SSE / UI 打磨 / push 到 GitHub（待用户创建 agent-bridge 仓库）。

### [2026-07-04] 能力白名单完成

- **安全红线满足**：实现了 AGENTS.md 要求的「能力白名单——agent 可执行的动作走白名单而非黑名单，默认拒绝未知动作」。
- **两层安全机制**：
  - `allowedTools`：传给 Claude Code CLI 的 `--allowedTools` 参数，CLI 层面拦截不在列表的工具
  - `dangerousTools`：allowedTools 的子集，Provider 收到这些工具的 tool_use 事件时触发手机审批弹窗
- **拦截流程**：tool_use 事件 → 检查是否在 dangerousTools → 推送 approval_required 事件到手机 → 批准则继续 / 拒绝则 kill 子进程 + error
- **配置示例**：Claude Code agent 声明 `allowedTools: [Read,Write,Edit,Grep,Glob,Bash]`，`dangerousTools: [Bash,Write,Edit]`（读/Grep/Glob 直接放行，写/执行需手机审批）
- **commit**：`fdbefc7` feat: capability whitelist
- **下一步**：agent 主动推送 / OpenAI 兼容 SSE / UI 打磨 / push 到 GitHub。

### [2026-07-04] UI 打磨 + GitHub push

- **GitHub 仓库创建**：https://github.com/Joshuayang228/agent-bridge （gh CLI 自动创建，全部代码已 push）
- **Markdown 渲染**：Claude Code 回复的 markdown 格式现在正确渲染（标题、列表、代码块、表格、引用块、链接）
- **代码高亮**：highlight.js (github-dark 主题) 自动高亮代码块
- **安全**：DOMPurify 清洗 markdown HTML，防 XSS
- **Agent 头像**：每条 agent 消息前显示 🤖 图标
- **CDN 引入**：marked.js + DOMPurify + highlight.js（CSS+JS），零本地依赖
- **commit**：`222901d` feat: markdown rendering + code highlighting
- **下一步**：agent 主动推送 / OpenAI 兼容 SSE / Demo 脚本打磨。

### [2026-07-04] 单元测试补齐 + 自审修复

- **闸3 违规补救**：此前每次 commit 只做 tsc --noEmit，跳过了闸3 第1步（自审）和第2步（运行测试）。本次补齐。
- **自审发现并修复**：
  - cron-scheduler.ts 空 catch 块 → 加 console.error
  - web/index.html highlightCode 空 catch → 加注释
  - registry.ts loadConfig 不处理文件不存在 → 加 existsSync 守卫
- **单元测试**：32 tests / 4 files，全部通过
  - auth.test.ts (8 tests)：配对码生成、pair 正确/错误、verify 有效/无效/null、环境变量 token
  - session-manager.test.ts (11 tests)：create、get、list 排序、history、addUserMessage 标题更新、delete
  - mock-provider.test.ts (5 tests)：info、delta 流式、done 事件、echo 回声、审批回调触发
  - registry.test.ts (7 tests)：空列表、loadConfig 单/多 agent、allowedTools、文件不存在、未知 type 跳过
- **vitest.config.ts**：排除 _reference/ 目录的测试文件
- **commit**：`834c98b` test: add unit tests for core modules
- **下一步**：OpenAI 兼容 SSE / Demo 脚本打磨 / 接 my-agent。

### [2026-07-04] OpenAI 兼容 API 完成

- **GET /v1/models** — 返回所有 agent 作为 model（model 名 = agent id）
- **POST /v1/chat/completions** — 支持 `stream: true`（SSE 流式）和非流式
- **认证**：Bearer token（GATEWAY_TOKEN 或 device token）
- **CORS** 已启用，浏览器端 OpenAI SDK 可直接调用
- **curl 验证**：
  - `GET /v1/models` → 返回 3 个 agent ✓
  - 非流式 → `chat.completion` JSON ✓
  - 流式 → SSE `data: {chunk}\n\n` + `data: [DONE]` ✓
- **commit**：`65e820f` feat: OpenAI-compatible API
- **下一步**：Demo 脚本打磨 / 接 my-agent / 写 README。

### [2026-07-04] Harness 回流模板 + 双源漂移修复 + 卫生清理

> 本次会话为旁路整理，不动产品主线代码，只做规则基建与文档卫生。

- **搬入自包含 harness**：从 my-agent 剥离 7 份通用 agent-skills（writing-style / code-review / debug-guide / git-workflow / security-checklist / typescript-guidelines / methodology-writing），剥掉 my-agent 专属（Electron 分层 / IPC 三同步 / LLM 架构），落到本项目 `docs/agent-skills/`。security-checklist 转向「远程通道安全」（配对鉴权 / 命令分级 / 手机端确认）。
- **回流到冷启动模板**（用户批准）：把 7 份再蒸馏成 **stack 中立 + 领域中立**版，写入 `模板/项目冷启动/docs/agent-skills/`（typescript-guidelines → 改名 coding-guidelines 去语言绑定；security 砍掉远程通道内核只留通用；git 去个人代理端口私货）。以后每个新项目冷启动自带 harness，不用重挖。
- **改动模板骨架 3 处**（L1/L2，已展示 diff 获批）：① `CLAUDE.md.template` 加「场景规则索引」段 + 目录树加 agent-skills；② `模板/项目冷启动/README.md` 文件结构 / 职责表 / 使用方式补 agent-skills；③ `积核/项目/CLAUDE.md`（L2）冷启动规则加「复制 agent-skills/ 文件夹并按项目调味」一步。
- **修复双源漂移**：CLAUDE.md（Claude Code 自动加载的权威源）反而过时（还写方案 A / 借 IM / 技术栈未定），AGENTS.md 却是最新。已把 CLAUDE.md 更新到最新（Web App + Node/TS + 骨架已落地），并把 AGENTS.md 从「整份复制规则」改为**重定向 stub**（指向 CLAUDE.md），根除以后再漂移。坑已记入 pitfalls.md。
- **卫生清理**：删除误建的根目录 `openclaw/`（仅空 .git，与 `_reference/openclaw-1` 撞名易混）；确认 `_reference/openclaw-1/openclaw-main/` 参考仓库完整。
- **验证**：tsc --noEmit 通过，骨架健康。
- **下一步**：回到产品主线——git commit / 打磨 Demo 体验 / OpenAI 兼容 SSE 端点。

### [2026-07-04] CC 接通验证 + Web App Demo 打磨

- **ClaudeCodeProvider 实测通过**（OpenAI 兼容 API）：
  - 非流式：`POST /v1/chat/completions` model=claude-code → 返回 `Opus 4.8` 正常回复 ✓
  - 流式：`stream:true` → SSE `data: {chunk}\n\n` + `data: [DONE]` ✓
  - Windows 下 `spawn("claude", args, { shell: true })` 能正确解析 `claude.cmd`
- **Web App Demo 打磨**（10 项体验改进）：
  - 空状态欢迎卡片：首次进入显示 agent 介绍 + 可点击的示例 prompt（按 agent 类型动态生成，含"审批演示""危险操作"等标签）
  - agent 能力标签：选择 agent 后顶部显示 capabilities 标签（shell 标红）
  - 思考中状态：发送后立即显示三点跳动动画，ack 后切换为 cursor 闪烁
  - 工具调用分类样式：Bash(🖥️红)/Read(📄蓝)/Write/Edit(✏️橙)/Grep/Glob(🔍绿)，便于一眼分辨
  - 审批弹窗增强：显示 agent 名 + ⚠️ 危险图标 + toast 提示
  - 代码块复制按钮：hover 显示"复制"，复制成功显示 ✓ 已复制
  - WS 自动重连：非认证失败断线时指数退避重连（最多 30s），状态显示"重连中(N)"
  - 配对码只允许数字 + 满 6 位自动提交
  - 网络错误 toast 提示
  - PWA 支持：manifest.json + icon.svg + apple-touch-icon，手机可"添加到主屏幕"作为独立 App
- **Bug 修复（自审发现）**：配对成功后断线重连仍用已失效的 pair code → 改为 pair 成功后 `lastConnectToken` 切换为 token 模式
- **验证**：tsc --noEmit 通过，32 单元测试全过
- **下一步**：git commit / 写 README / 接 my-agent。

### [2026-07-05] SessionWatcher 抽象重构 + CC 跨项目续接 + EBADF 根因定位

- **SessionWatcher 抽象重构（方案 B）**：把 CCWatcher 重构成通用 `SessionWatcher` + `SessionAdapter` 接口，同时支持 CC 和 Codex。
  - `SessionAdapter` 接口：`getRootDir` / `findLatestFile` / `extractSessionId` / `extractCwd` / `parseLine`
  - `CCAdapter`：扫描 `~/.claude/projects/` 下所有子目录的 `.jsonl`，选 mtime 最新的（跨项目支持）
  - `CodexAdapter`：扫描 `~/.codex/sessions/YYYY/MM/DD/` 下的 `rollout-*.jsonl`
  - 事件统一广播为 `external_session_event`，payload 含 `{ adapterId, data: AgentEvent }`
- **手机续接外部 CC 的 session**：手机发消息时用 `--resume <sessionId>` 续接电脑前跑的对话上下文。
  - `AgentInput` 加 `cwd?` 字段：CC `--resume` 在 spawn cwd 编码的目录里找 session 文件，跨项目必须切到原项目目录跑
  - `extractCwd` 从 session 文件提取 cwd：CC 在 user message 行的 `cwd` 字段，Codex 在 `session_meta.payload.cwd`
  - ws-handler.ts：`sessionWatcher.getCurrentSessionId(adapterId)` + `getCurrentCwd(adapterId)` 取 session id 和 cwd 传给 provider
- **suspend/resume 机制**：手机端主动调 provider 时，provider 写入 session 文件会触发 watcher 重复推送。在 `provider.send` 前 suspend adapter，跑完 resume 时把 size 重置到文件末尾跳过中间写入。
  - fs.watch 回调也检查 suspended 状态（避免并发文件访问冲突）
- **CC 真流式输出**：启用 `--include-partial-messages`，`stream_event.content_block_delta.text_delta` → delta（token-by-token）
- **EBADF 根因定位与修复**（关键坑，详见 pitfalls.md）：
  - 现象：服务器 spawn CC `--resume` 时报 `Failed to resume session: EBADF: bad file descriptor, write`
  - 排查：命令行直接跑同样命令成功 → spawn-test.mjs 独立跑成功 → 服务器跑失败
  - 根因：**`npm start` / `npm run dev` 会用 `cmd /c` 包一层，重定向子进程 stdout**，导致 tsx 进程的 stdout 不是 TTY，spawn 的 CC 子进程继承了无效的 fd，写 session 文件时报 EBADF
  - 修复：`start.bat` 改用 `npx tsx src/index.ts` 直接启动，绕过 npm 的 cmd 包装
- **Codex adapter extractCwd bug 修复**：8KB 缓冲区不够覆盖 codex session_meta 第一行（很长），改用循环读取直到遇到换行符（最多 256KB）
- **验证**：tsc --noEmit 通过，32 单元测试全过，e2e-test.mjs 端到端测试成功（CC 续接 session 流式输出正常）
- **下一步**：多会话独立续接（当前所有手机会话共享同一个 ccSessionId）/ Codex CLI 接入测试。

### [2026-07-06] 退出大赛，转向自用 + Paseo 参考入库

- **战略转向**：不再参加 Trae 大赛，项目改为**个人自用工具**。解除原约束：IP 隔离、必须从零写、Demo 导向。
- **规则更新**：AGENTS.md / CLAUDE.md 同步改写——my-agent 升为首要下游、可参考/集成 openclaw 与 paseo、安全从「亮点」回归「底线」。
- **Paseo 参考入库**：浅克隆 `getpaseo/paseo` 到 `_reference/paseo-main/`（与 openclaw 并列），重点对照 relay 远程访问、多 agent 编排、移动端 UX。
- **下一步**：接 my-agent / 远程穿透 / 日常体验。

### [2026-07-06] 云端 Relay + SQLite 持久化 全链路落地

> 解决「远程访问不稳定、断了看不到历史、审批状态丢失」三大痛点。需求文档：`docs/relay-persistence-spec.md`。

**5 步实施全部完成**（commit `bf935ad` → `3325f0e` → `0ff8e41` → `860e24c`）：

1. **SQLite 持久化层 + relay server 骨架**（`src/relay/timeline-store.ts` + `src/relay/server.ts`）—— `better-sqlite3` WAL 模式，timeline 事件 + agent 状态 + 审批表；relay 接收 agent_event 持久化 + 回 ACK + 转发给在线手机
2. **家里 Gateway outbound 连云端 relay**（`src/relay/agent-client.ts`）—— 穿透 NAT 不走 P2P 打洞；send buffer + ACK 机制，重连补发未确认事件；`ConnectionManager` 事件广播同步推 relay
3. **手机端断连重连拉历史**（`web/index.html`）—— relay mode 标志注入；维护 `lastSeq`，重连后发 `history_since(lastSeq)` 拉增量；`historySince` 去重
4. **审批状态持久化 + 请求上行**（`ConnectionManager` 全局化 `pendingApproval`/`runningController`）—— 手机断连重连后新 ws 也能访问未决审批；`chat.approve`/`reject`/`abort` 通过 relay 上行（`MobileResponse` 协议帧，不持久化只转发）
5. **agent 状态广播 + 部署打磨**—— agent 上下线 EventFrame 推送（`agent_status` 事件，seq=0 不参与 timeline）；手机端 `agentStatusCache` + 上下线标记 + 系统提示；`npm run start:relay` 脚本 + `--relay` 命令行参数；`.env` 自动加载 + `.env.example` 配置模板；`RELAY_PUBLIC_URL` 环境变量

**测试**：9 文件 63 测试全过（含 3 个端到端集成测试：mobile-history / approval-persistence / agent-status-broadcast）。tsc 零错误。

**剩余待办**（依赖真实 VPS）：
- WSS（Caddy 反代 + Let's Encrypt 证书）
- 生产部署文档

**关键协议**：
- Gateway → relay：`agent_event` 信封（带 clientSeq）+ `mobile_response`（res 帧，不持久化）
- relay → Gateway：`agent_event_ack`（带 serverSeq）+ 透传手机 req 帧
- relay → 手机：EventFrame（`type:event`），`agent_status` 事件 seq=0
- 手机 → relay：`history_since` req 拉增量 + `chat.approve`/`reject`/`abort` req 上行
