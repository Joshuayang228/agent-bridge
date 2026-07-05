/**
 * CCAdapter —— Claude Code 的 session 适配器
 *
 * CC 在终端/IDE 跑时，把每次会话写到
 * ~/.claude/projects/<cwd-encoded>/<session-uuid>.jsonl（append-only）
 * cwd 编码规则：每个非 [a-zA-Z0-9] 字符替换为 '-'
 *
 * 跟踪策略：扫描 ~/.claude/projects/ 下所有子目录的 .jsonl 文件，
 * 选 mtime 最新的那个 —— 用户在任意 cwd 跑 CC 都能同步。
 *
 * JSONL 行类型映射：
 *   assistant.content[].type === "text"      → delta
 *   assistant.content[].type === "tool_use"  → tool_start
 *   tool_result                              → tool_end
 *   result                                   → done / error
 *   user / queue-operation / attachment 等    → 忽略
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionAdapter, SessionFile } from "../session-adapter.js";
import type { AgentEvent } from "../../providers/types.js";

interface CCLine {
  type: string;
  message?: {
    role?: string;
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >;
  };
  content?: string | Array<{ type: "text"; text: string }>;
  tool_use_id?: string;
  result?: string;
  is_error?: boolean;
  sessionId?: string;
}

export class CCAdapter implements SessionAdapter {
  readonly id = "claude-code";

  getRootDir(): string {
    return join(homedir(), ".claude", "projects");
  }

  findLatestFile(): SessionFile | null {
    const root = this.getRootDir();
    if (!existsSync(root)) return null;

    let latest: SessionFile | null = null;
    const subdirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));

    for (const dir of subdirs) {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const fullPath = join(dir, f);
        const s = statSync(fullPath);
        if (!latest || s.mtimeMs > latest.mtime) {
          latest = { path: fullPath, mtime: s.mtimeMs };
        }
      }
    }
    return latest;
  }

  extractSessionId(filePath: string): string | null {
    const basename = filePath.split(/[\\/]/).pop() ?? "";
    return basename.replace(/\.jsonl$/, "") || null;
  }

  /**
   * 读 session 文件前 N 行，找 user / assistant 行的 cwd 字段
   * CC 把 cwd 写在每条 message 的 cwd 字段（queue-operation 行没有）
   */
  extractCwd(filePath: string): string | null {
    let fd: number | undefined;
    try {
      // 读前 8KB 足够覆盖前几条消息（cwd 字段在第一条 user message 里）
      const buf = Buffer.alloc(8192);
      fd = openSync(filePath, "r");
      const bytesRead = readSync(fd, buf, 0, 8192, 0);
      const content = buf.toString("utf-8", 0, bytesRead);
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as { cwd?: string };
          if (obj.cwd) return obj.cwd;
        } catch {
          // 继续找下一行
        }
      }
    } catch (err) {
      console.error(`[cc-adapter] extractCwd 失败:`, err);
    } finally {
      // 确保 fd 一定被关闭 —— 没关闭会导致 CC 写 session 文件时报 EBADF
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (err) {
          console.error(`[cc-adapter] extractCwd closeSync 失败 fd=${fd}:`, err);
        }
      }
    }
    return null;
  }

  parseLine(line: unknown): AgentEvent[] {
    return parseCCLine(line as CCLine);
  }
}

/** 解析 CC jsonl 一行 → AgentEvent 列表 */
function parseCCLine(line: CCLine): AgentEvent[] {
  const events: AgentEvent[] = [];

  switch (line.type) {
    case "assistant": {
      const contents = line.message?.content ?? [];
      for (const c of contents) {
        if (c.type === "text" && c.text) {
          events.push({ type: "delta", text: c.text });
        } else if (c.type === "tool_use") {
          const desc = formatToolDesc(c.name, c.input);
          events.push({ type: "tool_start", tool: `${c.name}: ${desc}` });
        }
      }
      break;
    }

    case "tool_result": {
      let result = "";
      if (typeof line.content === "string") {
        result = line.content;
      } else if (Array.isArray(line.content)) {
        result = line.content.map((c) => c.text).join("");
      }
      if (result.length > 200) result = result.slice(0, 200) + "...";
      events.push({ type: "tool_end", tool: line.tool_use_id ?? "unknown", result });
      break;
    }

    case "result": {
      if (line.is_error) {
        events.push({ type: "error", message: line.result ?? "未知错误" });
      } else {
        events.push({ type: "done", text: line.result ?? "" });
      }
      break;
    }

    // user / queue-operation / attachment / last-prompt / summary 等忽略
  }

  return events;
}

function formatToolDesc(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "");
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? "");
    case "Grep":
    case "Glob":
      return String(input.pattern ?? "");
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}
