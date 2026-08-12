# AGENTS.md — agent-bridge 项目权威规则

<!-- RULE_HIERARCHY:START -->
> 规则层级：**L4 · 独立项目规则**
> 规则链（父 → 子）：`L1 <Vault>/AGENTS.md` → `L2 <Vault>/积核/项目/AGENTS.md` → `L3 <Vault>/积核/项目/个人项目/AGENTS.md` → `L4 <Vault>/积核/项目/个人项目/trae大赛/AGENTS.md`
> 加载约定：仅适用于 `<Vault>`（`瓶盖的AI碎碎念`）内部；始终按父 → 子读取。若 Agent 从子目录或独立 Git repo root 启动且未自动加载上层规则，必须主动补读；冲突时近层优先，安全红线不可覆盖。
<!-- RULE_HIERARCHY:END -->

> `AGENTS.md` 是本项目的 L4 canonical source；在「瓶盖的AI碎碎念」Vault 内使用时，必须先叠加 L1～L3 父级规则。
> Claude Code 通过同目录 `CLAUDE.md` 的 `@AGENTS.md` 导入；Codex 等工具直接读取。
> 目录名仍叫 `trae大赛/`（历史命名），产品名为 **agent-bridge**（GitHub: `Joshuayang228/agent-bridge`）。
> 高频强约束写在正文；低频场景规则放 `docs/agent-skills/`。

## 项目定位

**自用工具**：一根「够得着 agent」的通道——agent 跑在家里电脑上（有手、能跑 shell、能控文件），人在外面用手机指挥它干活、看进度、在关键动作上拍板（批准/否决）。

核心不是再造一个 agent，而是做**「揣在兜里的操作员驾驶舱」**：远程操控一个有手的 agent，并在小屏上完成人类监督。

产品方向优先保护：

- **通道是 agent 无关的网关**——极简协议，任何后端 agent 都能挂上来获得手机通道。[my-agent](../my-agent) 是**首要下游**，目标把它真正接进来日常用；Claude Code / Codex 等 CLI 已作为 Provider 接入。
- **安全是底线**——能跑 shell、能控电脑的 agent 一旦开远程口子就是实打实的攻击面。配对鉴权、能力白名单、破坏性操作「手机确认」必须默认开启，自用也不能裸奔。
- **先研究后落地**——`_reference/` 里的 openclaw、paseo 等成熟方案优先对照；能借鉴设计就借鉴，能直接集成就集成，不必为「从零写」而从零写。注意许可证（paseo 为 AGPL-3.0）。

**性质**：个人工具 / 技术探索
**状态**：进行中 —— 骨架已落地（WS JSON-RPC + MockProvider + ClaudeCodeProvider + 审批机制 + Web App + 扫码配对 + 多会话 + 能力白名单 + OpenAI 兼容 API）。下一步：**接 my-agent**、远程穿透打磨、日常自用体验。

## 背景上下文

- **不再参赛**（2026-07-06 决定）：原 Trae 大赛约束（IP 隔离、从零写、Demo 导向）全部解除，以「自己天天用得上」为优先级。
- **手机端形态**：自建 Web App（浏览器打开即用，Gateway 托管静态页 + WebSocket）。零安装、跨平台、扫码即用。PWA 可添加到主屏幕。
- **技术栈**：Node.js + TypeScript Gateway，单进程单端口复用 WS + HTTP + 静态托管，通讯协议参考 OpenClaw 的 WS JSON-RPC + 流式事件。
- **参考项目**（均在 `_reference/`，按需深读）：
  - [openclaw/openclaw](https://github.com/openclaw/openclaw) — 手机 ↔ 家里 agent 的连接方式（穿透 + 鉴权 + 实时性）
  - [getpaseo/paseo](https://github.com/getpaseo/paseo) — 多 agent 编排 + 跨设备 + relay 远程访问（与本品高度重合，重点对照）

## 启动上下文

开始较大的代码任务前，先读：

1. `docs/progress.md` — 当前项目状态与下一步
2. `docs/decisions.md` — 已定的关键决策（避免推翻已对齐的结论）
3. 与任务直接相关的其他 `docs/*.md`

小任务（typo、注释、单文件少量改动）只读相关文件即可。若从上一轮 summary 恢复且信息完整可跳过；但 summary 可能过时（如跨天恢复）时仍应读文件确认。

## 规则冲突优先级

规则冲突时按此裁决：

1. **安全红线** — 密钥泄露、权限绕过、数据破坏、远程通道被滥用
2. **用户显式指令** — 用户明确说"这样做"
3. **开发流程规范** — 本文档和 agent-skills 的流程约束
4. **代码风格标准** — 命名、格式、注释
5. **建议性规则** — 性能优化、可读性建议

示例：用户明确要求"暂时硬编码 token 测试"时，不以安全红线拒绝（用户知情授权）；但"提交时保留硬编码 token"应拒绝并给替代方案。

---

## 硬约束（常驻，必须默认执行）

以下规则「漏了就出事」，不下沉 skill，每次都生效。

### 安全红线（本项目尤其吃重——远程通道 + 有手的 agent）

- 禁止硬编码 API Key、密码、token 或任何凭据；一律走环境变量或系统安全存储。
- `.env` 必须在 `.gitignore` 中。
- **远程通道必须鉴权**：任何能触达 agent 的入口（IM bot、webhook、网关端点）都必须有配对/令牌鉴权，禁止裸奔的开放端点。
- **破坏性 / 高权限操作必须人类确认**：agent 执行 shell、删改文件、外发数据等动作前，通过手机侧「批准/否决」交互确认，禁止静默执行。
- **能力白名单**：agent 可执行的动作走白名单而非黑名单，默认拒绝未知动作。
- 对外错误信息只暴露用户友好内容，不暴露堆栈、内部路径、命令细节。
- 文件路径操作做防穿越检查；数据库查询参数化，禁止拼接用户输入；shell 命令对用户输入做转义/参数化，防命令注入。
- 不把项目代码、密钥、用户数据发往第三方端点，除非用户显式要求。

> 沙箱分级、命令安全分级、权限规则引擎、审批记录等详情见 `docs/agent-skills/security-checklist.md`。

### 质量底线

- 修 bug 先定位根因，禁止猜测式修改。
- 同一方法失败两次必须换路径，禁止第三次盲试。
- 禁止 Mock 真实 AI 调用（测试场景除外）。
- **禁止分期实现或临时方案**——每次给出完整可用实现，不留"TODO 后续补""先用简化版"。功能确实复杂需分步时，在需求文档里明确拆分边界，每步独立可验证。
- 编辑文件前先 Read 最新版本；删代码前说明原因，大段删除先获用户确认；改依赖（package.json 等）声明新增/移除了什么。
- 不确定的假设用 **[待确认]** 标记并告知用户，禁止默默假设后往下走。
- 文件 >500 行时优先读目录/关键章节，不全量读浪费 token。

### Git 提交与推送门控

功能开发完成且测试通过后**必须**立即 commit + push：

- commit 前必须通过单元测试和类型检查（如 `npx tsc --noEmit`），确保提交的不是破损代码。
- 严禁本地积压大量未提交修改；严禁只 commit 不 push。
- **提交前 diff 安全检查**：确认不含密钥、token、调试代码、临时文件。
- 遇 `Failed to connect to 127.0.0.1` 类代理报错，检查代理端口（Clash 常见 7890 / 7897），更新或 `git config --global --unset http.proxy` 尝试直连，直至推送成功。

> commit 规范、分支命名、PR 流程详见 `docs/agent-skills/git-workflow.md`。

---

## 需求文档规范

**适用场景**：跨 3 个以上文件的新功能、架构变更、复杂功能模块。这类任务**必须先写需求文档，用户确认后再动手**。

必须包含：需求背景（Why）、功能目标（What）、技术方案（How：架构/数据流/关键接口/依赖）、影响范围评估（破坏性/测试/文档）、实施步骤（按逻辑顺序、每步可验证）、风险与权衡。

---

## 开发流程闸（防偷懒，必须默认执行）

以下三道闸是自循环时最容易被跳过的，缺了它 agent 会「没确认就写、没研究就造、没验证就说完成」。

### 闸 1：接需求分三态

- **逃生口**（可跳过确认直接改）：单行 typo / 格式 / 注释修正；单文件 <10 行且用户意图明确；用户明说"直接改""帮我改一下"。
- **新需求**（首次提出）：严格按 **思考 → 提问 → 复述 → 方案 → 等许可** 五步，用户确认后才编码。**"复述确认"和"等许可"两步不可省。**
- **已批准方案的子任务**：简化为"一句话汇报当前要做什么 → 直接执行"，无需重走五步。

### 闸 2：先研究后协作（硬门）

接到需求先查参考，再搜外部，不要直接自己实现。搜索优先级：
1. 项目 `_reference/` 内的参考项目（openclaw、paseo 等）
2. 关联项目 [my-agent](../my-agent) 的已有实现
3. GitHub / npm / 社区成熟方案
4. 最后才自研

自己实现前必须说明：**搜了什么、为什么现有方案不适用（或为何选择集成而非自研）**。
**豁免**（一句话说明理由即可）：行业标准库常规集成、纯 UI 或 <3 文件小改动、已批准方案指定了实现方式的子任务。

> 自用模式下优先交付可用性：成熟模块可集成或移植，但须注明许可证约束，并保持 Gateway 协议层清晰可维护。

### 闸 3：完成前按序验证

声称"已完成 / 已修复"前**必须按顺序**执行，即使用户一直说"继续"也不能跳过第 1 步：
1. **自审**（对照 `docs/agent-skills/code-review.md` 清单）
2. 运行测试并展示通过结果
3. 确认 build / 类型检查通过
4. 确认无新增 linter 报错

禁止未经验证就说"已完成""已修复"。

---

## 场景规则索引（按需读取 `docs/agent-skills/`）

遇到以下场景，先读对应文件再动手：

| 场景 | 读取文件 |
|------|----------|
| TypeScript / 后端 / 工具系统开发 | `docs/agent-skills/typescript-guidelines.md` |
| Bug 修复 / 调试 | `docs/agent-skills/debug-guide.md` |
| 代码审查 / 自审 | `docs/agent-skills/code-review.md` |
| Git / commit / push / PR | `docs/agent-skills/git-workflow.md` |
| 安全 / 密钥 / 权限 / 沙箱 / 远程通道鉴权 | `docs/agent-skills/security-checklist.md` |
| 写文档 / 文章 / README | `docs/agent-skills/writing-style.md` |
| 方法论沉淀（学→审→沉淀） | `docs/agent-skills/methodology-writing.md` |

> 索引指向的是「查阅型」详细规则；正文的「硬约束」始终生效，无需等索引触发。
> 前端 / 部署打包 / LLM Provider 配置等场景规则待技术栈定型后按需补建（当前未搬入，因与具体技术栈强绑定）。

## 工作方式

- 用户明确要求修改时直接推进；需求含糊或风险较高时先问清楚。
- 新增功能前搜索项目内已有实现，避免重复造轮子（冗余搜索策略见 `docs/agent-skills/typescript-guidelines.md`）。
- 复杂功能优先查 `_reference/` 参考项目与项目 `docs/`，再考虑 GitHub/npm 或自研。
- 所有响应用**简体中文**，技术术语保留英文原文；重要信息可加粗。
- 长对话（>10 轮）关键操作前先复述当前目标；发现自己重复、偷懒或模糊化时主动建议开新会话。

## 收尾沉淀

功能完成后按实际影响范围更新文档（不机械全更，也不遗漏）：

- `docs/progress.md` — 当前进度时间线（状态变化必更新）
- `docs/decisions.md` — 技术决策时
- `docs/pitfalls.md` — 踩坑和修复经验
- `docs/rules-feedback.md` — 规则不合理或冲突时

（`changelog.md` / `architecture.md` / `features.md` / `api-contracts.md` 等按项目成熟度需要时再建。）

## 规则自进化

遇到规则不合理、冲突、缺失或过时时：

1. 立即记录到 `docs/rules-feedback.md`（一行描述 + 建议改动）
2. 累计 3 条反馈后主动建议修订规则
3. 用户确认后批量更新本文档和相关 agent-skills 文件

## 目录结构

```
trae大赛/
├── AGENTS.md              ← 本文件（L4 项目权威规则）
├── _reference/            ← 参考项目（openclaw、paseo 等）
└── docs/
    ├── progress.md        ← 进展追踪
    ├── decisions.md       ← 关键决策记录
    ├── pitfalls.md        ← 踩坑记录
    ├── rules-feedback.md  ← 规则反馈
    └── agent-skills/      ← 场景化详细规则（按需读取）
        ├── typescript-guidelines.md
        ├── debug-guide.md
        ├── code-review.md
        ├── git-workflow.md
        ├── security-checklist.md
        ├── writing-style.md
        └── methodology-writing.md
```
