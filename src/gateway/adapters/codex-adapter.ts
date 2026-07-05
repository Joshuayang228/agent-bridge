/**
 * CodexAdapter —— OpenAI Codex CLI 的 session 适配器
 *
 * Codex CLI 把每次会话写到日期分层的目录：
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO 时间>-<UUID前8位>.jsonl
 * 不像 CC 那样按 cwd 编码子目录 —— cwd 信息在文件内 session_meta.payload.cwd 里。
 *
 * JSONL 行格式：{ timestamp, type, payload }
 * 主要事件类型：
 *   session_meta                     → 元信息（含 session_id, cwd）—— 忽略
 *   turn_context                     → 每轮模型/sandbox 配置 —— 忽略
 *   response_item:
 *     payload.type === "message"             + content[].output_text → delta
 *     payload.type === "function_call"                              → tool_start
 *     payload.type === "function_call_output"                       → tool_end
 *   event_msg:
 *     payload.type === "agent_message" + message                    → delta
 *     payload.type === "task_complete"                              → done
 *     payload.type === "error"                                      → error
 *     payload.type === "user_message" 等                            → 忽略
 *   compacted                        → /compact 总结 —— 忽略
 *
 * session id 提取：从文件名提取 UUID 前 8 位（如 rollout-...-a1b2c3d4.jsonl → a1b2c3d4）
 *   给 `codex resume <session_id>` 使用。如果 CLI 不接受短前缀，改为从 session_meta 行
 *   读完整 UUID。
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionAdapter, SessionFile } from "../session-adapter.js";
import type { AgentEvent } from "../../providers/types.js";

interface CodexLine {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    // message
    content?: Array<{ type: string; text?: string }>;
    // function_call
    name?: string;
    arguments?: string;
    call_id?: string;
    // function_call_output
    output?: string | object;
    // event_msg.agent_message
    message?: string;
  };
  session_id?: string; // session_meta 里也有
}

export class CodexAdapter implements SessionAdapter {
  readonly id = "codex";

  getRootDir(): string {
    return join(homedir(), ".codex", "sessions");
  }

  findLatestFile(): SessionFile | null {
    const root = this.getRootDir();
    if (!existsSync(root)) return null;

    let latest: SessionFile | null = null;
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile() && e.name.endsWith(".jsonl")) {
          try {
            const s = statSync(full);
            if (!latest || s.mtimeMs > latest.mtime) {
              latest = { path: full, mtime: s.mtimeMs };
            }
          } catch {
            // 跳过读不了的文件
          }
        }
      }
    };
    walk(root);
    return latest;
  }

  extractSessionId(filePath: string): string | null {
    // rollout-2026-04-29T08-14-22-a1b2c3d4.jsonl → a1b2c3d4
    const basename = filePath.split(/[\\/]/).pop() ?? "";
    const m = basename.match(/rollout-[\dTZ: +-]+-([a-f0-9]+)\.jsonl$/i);
    if (m) return m[1];
    // 退化方案：去掉 .jsonl 后整段返回
    return basename.replace(/\.jsonl$/, "") || null;
  }

  /**
   * Codex session 文件第一行就是 session_meta，cwd 在 payload.cwd
   * session_meta 行可能很长（含 model、tools 等元信息），8KB 不够覆盖，
   * 改用循环读取直到遇到换行符，确保拿到完整第一行
   */
  extractCwd(filePath: string): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const chunks: Buffer[] = [];
      const chunkSize = 16384;
      let buf = Buffer.alloc(chunkSize);
      let totalLen = 0;
      // 最多读 256KB（session_meta 理论上不会超过这个大小）
      while (totalLen < 256 * 1024) {
        const bytesRead = readSync(fd, buf, 0, chunkSize, totalLen);
        if (bytesRead === 0) break;
        const nlIdx = buf.indexOf(0x0a, 0, "utf-8");
        if (nlIdx >= 0) {
          // 找到换行符，只取到换行符位置
          chunks.push(Buffer.from(buf.subarray(0, nlIdx)));
          totalLen += nlIdx;
          break;
        }
        chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
        totalLen += bytesRead;
      }
      const firstLine = Buffer.concat(chunks).toString("utf-8");
      const obj = JSON.parse(firstLine) as {
        type?: string;
        payload?: { cwd?: string };
      };
      if (obj.type === "session_meta" && obj.payload?.cwd) {
        return obj.payload.cwd;
      }
    } catch (err) {
      console.error(`[codex-adapter] extractCwd 失败:`, err);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (err) {
          console.error(`[codex-adapter] extractCwd closeSync 失败 fd=${fd}:`, err);
        }
      }
    }
    return null;
  }

  parseLine(line: unknown): AgentEvent[] {
    const obj = line as CodexLine;
    const events: AgentEvent[] = [];
    const payload = obj.payload ?? {};

    switch (obj.type) {
      case "response_item": {
        if (payload.type === "function_call") {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(payload.arguments || "{}");
          } catch {
            // 忽略参数解析失败
          }
          const desc = formatToolDesc(payload.name ?? "unknown", args);
          events.push({ type: "tool_start", tool: `${payload.name}: ${desc}` });
        } else if (payload.type === "function_call_output") {
          let result = payload.output ?? "";
          if (typeof result !== "string") result = JSON.stringify(result);
          if (result.length > 200) result = result.slice(0, 200) + "...";
          events.push({ type: "tool_end", tool: payload.call_id ?? "unknown", result });
        } else if (payload.type === "message" && Array.isArray(payload.content)) {
          for (const c of payload.content) {
            if (c.type === "output_text" && c.text) {
              events.push({ type: "delta", text: c.text });
            }
          }
        }
        break;
      }

      case "event_msg": {
        if (payload.type === "agent_message" && payload.message) {
          events.push({ type: "delta", text: payload.message });
        } else if (payload.type === "task_complete") {
          events.push({ type: "done", text: "" });
        } else if (payload.type === "error") {
          events.push({ type: "error", message: payload.message ?? "未知错误" });
        }
        break;
      }

      // session_meta / turn_context / compacted 等忽略
    }

    return events;
  }
}

function formatToolDesc(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "exec_command":
      return String(input.command ?? "");
    case "apply_patch":
      return String(input.path ?? input.target ?? "");
    case "web_search":
      return String(input.query ?? "");
    case "mcp_tool_call":
      return String(input.tool_name ?? "");
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}
