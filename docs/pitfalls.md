# 踩坑记录

> 开发/执行过程中遇到的坑和解决方案。避免重复踩坑。

## 格式

```
## 坑的标题（简短描述问题）

**问题**：具体发生了什么
**原因**：为什么会这样
**解决**：怎么解决的
```

---

## 踩坑记录

## AGENTS.md 与 CLAUDE.md 双源漂移（规则各存一份，迟早不一致）

**问题**：AGENTS.md 把整份 CLAUDE.md 规则正文复制了一遍，两个文件都自称"唯一权威规则源"。结果 Claude Code 自动加载的 CLAUDE.md 反而停在过时版本（还写着方案 A / 借 IM / 技术栈未定），AGENTS.md 却是最新的（Web App / Node+TS / 骨架已落地）——权威源漂成了旧的那个。
**原因**：同一套规则维护两份全文拷贝，任何一次更新只改了其中一份，另一份就滞后。多源必然漂移，这是结构问题不是手误。
**解决**：CLAUDE.md 作为唯一真源保持最新；AGENTS.md 改成**重定向 stub**——只写一句"本项目规则唯一来源是 CLAUDE.md，请先读它"，不再复制正文。以后新增其他工具入口（如 .cursor/rules）一律用同样的 stub 方式重定向，禁止再复制全文。

## npm start / npm run dev 导致 spawn 子进程报 EBADF

**问题**：服务器 spawn `claude -p ... --resume <sessionId>` 时，CC 报 `Failed to resume session: EBADF: bad file descriptor, write`，但同样的命令在命令行直接跑成功，独立 Node 进程 spawn 也成功。
**原因**：`npm start` / `npm run dev` 会用 `cmd /c "tsx ..."` 包一层启动子进程，**重定向了 tsx 进程的 stdout**（`process.stdout.isTTY === undefined`，而直接跑 `npx tsx` 时是 `true`）。spawn 的 CC 子进程继承了无效的 fd，写 session 文件时报 EBADF。
**排查路径**（耗时长，记下来避免再踩）：
1. 命令行直接跑 `claude -p ... --resume` 成功 → 排除 CC 本身问题
2. 写 spawn-test.mjs 独立 spawn 成功 → 排除 spawn 配置问题
3. 服务器 spawn 失败，对比发现 `process.stdout.isTTY` 在服务器是 `undefined`，独立跑是 `true`
4. 改用 `npx tsx src/index.ts` 启动服务器（绕过 npm 的 cmd 包装）→ 成功
**解决**：`start.bat` / 部署脚本必须用 `npx tsx src/index.ts` 直接启动，**不能用 `npm start` / `npm run dev`**。在 `claude-code-provider.ts` 的 spawn 处加了注释说明。开发时也用 `npx tsx src/index.ts` 或 `npx tsx watch src/index.ts`。

## Codex session_meta 行过长，固定 8KB 缓冲读不全

**问题**：Codex adapter 的 `extractCwd` 用 8KB 缓冲区读 session 文件第一行，报 `Unterminated string in JSON at position 8152`。
**原因**：Codex 的 `session_meta` 第一行包含 model、tools、slash_commands、skills、plugins 等大量元信息，单行长度经常超过 8KB。固定缓冲区读不完一行，JSON.parse 解析截断的字符串失败。
**解决**：改用循环读取直到遇到换行符（`\n`，最多读 256KB 兜底），确保拿到完整第一行再解析。CC 的 session 文件每行较短，8KB 够用，但 Codex 不行——不同 agent CLI 的 session 文件格式差异很大，不能假设统一缓冲区大小。
