/**
 * SessionWatcher —— 通用外部 agent session 同步器
 *
 * 工作原理：
 *   外部 agent CLI（CC / Codex 等）跑时把会话写到各自根目录的 jsonl 文件里，
 *   SessionWatcher 用 fs.watch + 轮询兜底 tail 这些文件，
 *   通过 SessionAdapter 抽象解析每行 JSON 转 AgentEvent，广播到所有已配对手机。
 *
 * 多 adapter 支持：
 *   每个 adapter 维护独立的 currentFile / size / buffer，
 *   手机端按 provider.info.type 取对应 adapter 的 session id 续接。
 *
 * 事件名：
 *   广播事件统一为 external_session_event，payload 含 { adapterId, data: AgentEvent }
 */

import { watch, type FSWatcher, existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import type { ConnectionManager } from "./connection-manager.js";
import type { SessionAdapter } from "./session-adapter.js";

interface AdapterState {
  file: string | null;
  size: number;
  buffer: string;
  cwd: string | null; // 该 session 对应的项目 cwd，手机端续接时 spawn 用
}

export class SessionWatcher {
  private adapters = new Map<string, SessionAdapter>();
  private states = new Map<string, AdapterState>();
  private watchers: FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  /**
   * 暂停推送的 adapter 集合
   * 手机端主动调 provider 时（如 chat.send 触发 ClaudeCodeProvider spawn claude），
   * provider 写入 session 文件会触发 watcher 推送，造成手机端重复显示。
   * 在 provider.send 前 suspend，跑完 resume，把 size 重置到文件末尾跳过中间写入。
   */
  private suspended = new Set<string>();

  constructor(
    private connections: ConnectionManager,
    adapters: SessionAdapter[] = [],
  ) {
    for (const a of adapters) this.registerAdapter(a);
  }

  /** 注册新 adapter（启动前或运行中都可调用） */
  registerAdapter(a: SessionAdapter): void {
    this.adapters.set(a.id, a);
    if (!this.states.has(a.id)) {
      this.states.set(a.id, { file: null, size: 0, buffer: "", cwd: null });
    }
  }

  /** 启动监听所有已注册 adapter */
  start(): void {
    for (const a of this.adapters.values()) {
      const root = a.getRootDir();
      if (!existsSync(root)) {
        console.warn(`[session-watcher] [${a.id}] 根目录不存在: ${root}（首次跑该 agent 后自动创建）`);
        continue;
      }
      this.scanAndSwitch(a);

      const w = watch(root, { recursive: true }, (event, filename) => {
        if (event === "rename" && filename?.endsWith(".jsonl")) {
          // 暂停期间不切文件 —— provider 正在 spawn CC 写 session 文件，
          // 此时切到新文件 + extractCwd 打开它，可能跟 CC 写文件冲突触发 EBADF
          if (this.suspended.has(a.id)) return;
          this.scanAndSwitch(a);
        }
      });
      this.watchers.push(w);
      console.log(`[session-watcher] [${a.id}] 监听根目录: ${root}`);
    }

    // 轮询兜底（Windows 下 fs.watch 不可靠，每 2 秒检查 size 增量 + 新文件）
    this.pollTimer = setInterval(() => this.pollAll(), 2000);
  }

  stop(): void {
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 获取指定 adapter 当前跟踪的 session id
   * 手机端续接外部 agent 对话时用它做 --resume 参数
   * 返回 null 表示该 adapter 没在跟踪任何 session
   */
  getCurrentSessionId(adapterId: string): string | null {
    const state = this.states.get(adapterId);
    if (!state?.file) return null;
    return this.adapters.get(adapterId)?.extractSessionId(state.file) ?? null;
  }

  /**
   * 获取指定 adapter 当前跟踪 session 对应的项目 cwd
   * 手机端续接 --resume 时，spawn 子进程要用这个 cwd
   * 否则 CC 在 Gateway 当前 cwd 找不到 session 文件（CC 按 cwd 编码找目录）
   * 返回 null 表示读不出 cwd，调用方应回退到 process.cwd()
   */
  getCurrentCwd(adapterId: string): string | null {
    const state = this.states.get(adapterId);
    return state?.cwd ?? null;
  }

  /**
   * 暂停指定 adapter 的推送
   * 手机端主动调 provider（chat.send）时调用，避免 provider 写入 session 文件
   * 触发 watcher 重复推送（provider 已直接通过 stdout 推给手机了）
   * 暂停期间：不读取文件新增内容、不切换文件
   */
  suspend(adapterId: string): void {
    this.suspended.add(adapterId);
  }

  /**
   * 读取当前 session 文件的最近 N 条 user/assistant 消息
   * 用于手机连上后推送 CC 最近历史，让用户知道 CC 在干什么
   */
  getRecentMessages(adapterId: string, maxMessages = 10): { role: "user" | "assistant"; text: string }[] {
    const state = this.states.get(adapterId);
    const adapter = this.adapters.get(adapterId);
    if (!state?.file || !adapter) return [];

    try {
      const content = readFileSync(state.file, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      const messages: { role: "user" | "assistant"; text: string }[] = [];

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const events = adapter.parseLine(obj);
          for (const evt of events) {
            if (evt.type === "delta" && evt.text) {
              // delta 是 assistant 的流式片段，合并到最后一条 assistant 消息
              const last = messages[messages.length - 1];
              if (last && last.role === "assistant") {
                last.text += evt.text;
              } else {
                messages.push({ role: "assistant", text: evt.text });
              }
            } else if (evt.type === "done" && evt.text) {
              // done 是 assistant 的完整回复，替换最后一条 assistant 消息
              const last = messages[messages.length - 1];
              if (last && last.role === "assistant") {
                last.text = evt.text;
              } else {
                messages.push({ role: "assistant", text: evt.text });
              }
            }
          }
          // user message: CC 的 user 行有 message.content[].text
          if (obj.type === "user" && obj.message?.content) {
            const text = Array.isArray(obj.message.content)
              ? obj.message.content.map((c: { text?: string }) => c.text ?? "").join("")
              : String(obj.message.content);
            if (text.trim()) {
              messages.push({ role: "user", text });
            }
          }
        } catch {
          // 跳过无法解析的行
        }
      }

      // 返回最后 N 条
      return messages.slice(-maxMessages);
    } catch (err) {
      console.error(`[session-watcher] [${adapterId}] getRecentMessages 失败:`, err);
      return [];
    }
  }

  /**
   * 恢复指定 adapter 的推送
   * 把当前文件 size 重置到末尾，跳过 suspend 期间写入的内容
   * （这部分内容已经由 provider 直接推给手机了，不再重复）
   */
  resume(adapterId: string): void {
    this.suspended.delete(adapterId);
    const state = this.states.get(adapterId);
    if (state?.file) {
      try {
        state.size = statSync(state.file).size;
        state.buffer = "";
      } catch (err) {
        console.error(`[session-watcher] [${adapterId}] resume 失败:`, err);
      }
    }
  }

  /** 扫描 adapter 的根目录，切到 mtime 最新的 jsonl 文件 */
  private scanAndSwitch(a: SessionAdapter): void {
    try {
      const latest = a.findLatestFile();
      if (!latest) return;
      const state = this.states.get(a.id)!;
      if (latest.path === state.file) return;

      // 切到新文件，重置 size 到末尾（只推送切换后的新内容）
      state.file = latest.path;
      state.size = statSync(latest.path).size;
      state.buffer = "";
      state.cwd = a.extractCwd(latest.path);
      console.log(
        `[session-watcher] [${a.id}] 跟踪: ${latest.path.split(/[\\/]/).pop()}` +
          (state.cwd ? ` (cwd: ${state.cwd})` : ""),
      );
    } catch (err) {
      console.error(`[session-watcher] [${a.id}] 扫描失败:`, err);
    }
  }

  /** 轮询：先看每个 adapter 是否有更新的文件，再读当前文件新增部分 */
  private pollAll(): void {
    for (const a of this.adapters.values()) {
      // 暂停期间跳过（手机端主动调 provider 时，避免重复推送）
      if (this.suspended.has(a.id)) continue;
      this.scanAndSwitch(a);
      this.pollOne(a);
    }
  }

  /** 轮询单个 adapter 的当前文件，读取新增部分并解析 */
  private pollOne(a: SessionAdapter): void {
    const state = this.states.get(a.id);
    if (!state?.file) return;

    try {
      const s = statSync(state.file);
      if (s.size <= state.size) return;

      const fd = openSync(state.file, "r");
      const length = s.size - state.size;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, state.size);
      closeSync(fd);

      state.size = s.size;
      state.buffer += buf.toString("utf-8");

      const lines = state.buffer.split("\n");
      state.buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const events = a.parseLine(obj);
          for (const evt of events) {
            this.connections.broadcast("external_session_event", {
              adapterId: a.id,
              data: evt,
            });
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    } catch (err) {
      console.error(`[session-watcher] [${a.id}] 轮询失败:`, err);
    }
  }
}
