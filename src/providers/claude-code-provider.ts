/**
 * ClaudeCodeProvider —— 接入 Claude Code CLI
 *
 * 通过 spawn `claude -p <message> --output-format stream-json --verbose`
 * 拿到逐行 JSON 输出，解析后转成 AgentEvent 流式推送。
 *
 * 事件映射：
 *   assistant.content[].type === "text"      → delta
 *   assistant.content[].type === "tool_use"  → tool_start
 *   tool_result                              → tool_end
 *   result                                   → done
 */

import { spawn } from "node:child_process";
import type { AgentConfig, AgentInput, AgentProvider, AgentEvent } from "./types.js";
import type { AgentInfo } from "../protocol/frames.js";

// Claude Code stream-json 的行类型
interface CCLine {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >;
  };
  // tool_result 行
  content?: string | Array<{ type: "text"; text: string }>;
  tool_use_id?: string;
  // result 行
  result?: string;
  is_error?: boolean;
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly info: AgentInfo;
  private allowedTools: string[];
  private dangerousTools: Set<string>;

  constructor(config: AgentConfig) {
    this.info = {
      id: config.id,
      name: config.name,
      type: config.type,
      capabilities: config.capabilities,
    };
    this.allowedTools = config.allowedTools ?? [];
    this.dangerousTools = new Set(config.dangerousTools ?? []);
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const args = ["-p", input.message, "--output-format", "stream-json", "--verbose"];

    // 能力白名单：传给 CLI 的 --allowedTools 参数
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.allowedTools);
    }

    const child = spawn("claude", args, {
      shell: true,
      cwd: process.cwd(),
      env: process.env,
    });

    let fullText = "";
    let buffer = "";

    try {
      for await (const chunk of child.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: CCLine;
          try {
            parsed = JSON.parse(trimmed) as CCLine;
          } catch {
            continue;
          }

          const events = parseCCLine(parsed);

          // 危险工具审批拦截
          for (const evt of events) {
            if (evt.type === "tool_start" && this.isDangerous(evt.tool)) {
              yield evt; // 先推送 tool_start 事件让手机端看到

              // 触发手机审批
              const approved = input.requestApproval
                ? await input.requestApproval(evt.tool, `危险工具调用：${evt.tool}`)
                : true;

              if (!approved) {
                child.kill();
                yield { type: "error", message: `用户拒绝了工具调用：${evt.tool}` };
                return;
              }
            } else {
              if (evt.type === "delta") fullText += evt.text;
              if (evt.type === "done" && evt.text) fullText = evt.text;
              yield evt;
            }
          }
        }
      }

      // 处理剩余 buffer
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as CCLine;
          const events = parseCCLine(parsed);
          for (const evt of events) {
            if (evt.type === "delta") fullText += evt.text;
            if (evt.type === "done" && evt.text) fullText = evt.text;
            yield evt;
          }
        } catch {
          // 忽略
        }
      }

      // 如果没有 done 事件，补一个
      if (fullText) {
        yield { type: "done", text: fullText };
      }
    } finally {
      child.kill();
    }
  }

  /** 检查工具是否危险（tool 字段格式 "Bash: rm -rf xxx"） */
  private isDangerous(tool: string): boolean {
    const toolName = tool.split(":")[0].trim();
    return this.dangerousTools.has(toolName);
  }
}

// 解析单行 JSON，转成 AgentEvent 列表
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
      // 截断过长的结果
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
      return String(input.pattern ?? "");
    case "Glob":
      return String(input.pattern ?? "");
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}
