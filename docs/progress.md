# trae大赛 — 进展记录

> 按时间顺序追加，新内容在下方。AI 在每次实质推进后追加，同时更新"当前状态"。

## 当前状态

**选题已转向**（桌宠方案废弃）：改做 **手机遥控 agent 的「通道」** —— agent 跑在家里的电脑上（有手、能跑 shell、能控文件），人在外面用手机（借现成 IM，方向 A）指挥它干活、看进度、在危险动作前远程批准/否决。定位是「揣在兜里的操作员驾驶舱」，不是又一个聊天 bot。

**为什么转向**：fork my-agent 参赛会把整套引擎 IP 随提交物一起授权给主办方，代价太大。改为**从 0 到 1 独立开发**，比赛包只含这一个干净的通道工具，my-agent 一行源码不进包。

**已定**：自建 Web App 手机端 + Node.js/TS Gateway（不借 IM，方向 A 已被覆盖）。参考项目 openclaw（GitHub `openclaw/openclaw`）拉到 `_reference/openclaw-1/` 当教材，只读不抄，参赛代码从 0 新写。已从 my-agent 搬来自包含 harness（7 份 agent-skills + 自包含 CLAUDE.md）。

**技术栈已定**：Node.js + TypeScript Gateway + Web App（浏览器打开即用），多 agent = 多引擎接入（Gateway 定义 AgentProvider 接口对接多个 agent 后端），通讯协议参考 OpenClaw 的 WS JSON-RPC + 流式事件 + OpenAI 兼容 SSE。

**待办**：① 设计 Gateway 多引擎架构（AgentProvider 接口 + 路由 + 流式协议）② 搭项目骨架 ③ 实现 WS 协议层 + mock provider 验证链路 ④ 搭 Web App 最小页 ⑤ 确认赛程时间节点。

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

### [2026-07-04] Harness 回流模板 + 双源漂移修复 + 卫生清理

> 本次会话为旁路整理，不动产品主线代码，只做规则基建与文档卫生。

- **搬入自包含 harness**：从 my-agent 剥离 7 份通用 agent-skills（writing-style / code-review / debug-guide / git-workflow / security-checklist / typescript-guidelines / methodology-writing），剥掉 my-agent 专属（Electron 分层 / IPC 三同步 / LLM 架构），落到本项目 `docs/agent-skills/`。security-checklist 转向「远程通道安全」（配对鉴权 / 命令分级 / 手机端确认）。
- **回流到冷启动模板**（用户批准）：把 7 份再蒸馏成 **stack 中立 + 领域中立**版，写入 `模板/项目冷启动/docs/agent-skills/`（typescript-guidelines → 改名 coding-guidelines 去语言绑定；security 砍掉远程通道内核只留通用；git 去个人代理端口私货）。以后每个新项目冷启动自带 harness，不用重挖。
- **改动模板骨架 3 处**（L1/L2，已展示 diff 获批）：① `CLAUDE.md.template` 加「场景规则索引」段 + 目录树加 agent-skills；② `模板/项目冷启动/README.md` 文件结构 / 职责表 / 使用方式补 agent-skills；③ `积核/项目/CLAUDE.md`（L2）冷启动规则加「复制 agent-skills/ 文件夹并按项目调味」一步。
- **修复双源漂移**：CLAUDE.md（Claude Code 自动加载的权威源）反而过时（还写方案 A / 借 IM / 技术栈未定），AGENTS.md 却是最新。已把 CLAUDE.md 更新到最新（Web App + Node/TS + 骨架已落地），并把 AGENTS.md 从「整份复制规则」改为**重定向 stub**（指向 CLAUDE.md），根除以后再漂移。坑已记入 pitfalls.md。
- **卫生清理**：删除误建的根目录 `openclaw/`（仅空 .git，与 `_reference/openclaw-1` 撞名易混）；确认 `_reference/openclaw-1/openclaw-main/` 参考仓库完整。
- **验证**：tsc --noEmit 通过，骨架健康。
- **下一步**：回到产品主线——git commit / 打磨 Demo 体验 / OpenAI 兼容 SSE 端点。
