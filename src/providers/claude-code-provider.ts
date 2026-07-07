/**
 * ClaudeCodeProvider —— 接入 Claude Code CLI
 *
 * 通过 spawn `claude -p <message> --output-format stream-json --verbose --include-partial-messages`
 * 拿到逐行 JSON 输出，解析后转成 AgentEvent 流式推送。
 *
 * 事件映射（启用 --include-partial-messages 后，stream_event 是真正的 token 流）：
 *   stream_event.content_block_delta.text_delta → delta（token-by-token）
 *   assistant.content[].type === "tool_use"     → tool_start（带完整参数描述）
 *   assistant.content[].type === "text"         → delta（仅在未启用 stream_event 时推送，避免重复）
 *   tool_result                                 → tool_end
 *   result                                      → done
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
  session_id?: string;
  // stream_event 行（--include-partial-messages 时）
  event?: {
    type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
    delta?: {
      type: string; // text_delta, input_json_delta
      text?: string;
      partial_json?: string;
    };
    content_block?: {
      type: string; // text, tool_use
      id?: string;
      name?: string;
      text?: string;
    };
  };
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly info: AgentInfo;
  private allowedTools: string[];
  private dangerousTools: Set<string>;
  // 标记是否已收到 stream_event（启用 --include-partial-messages 后会变成 true）
  // 一旦为 true，assistant 事件的 text delta 就跳过（已被 stream_event 流式推送过）
  private streamEventSeen = false;

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
    // 每次调用前重置状态
    this.streamEventSeen = false;

    const args = [
      "-p", input.message,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages", // 启用真正的 token 流式输出
    ];

    // 续接外部 CC 的 session（电脑前跑的对话上下文）
    if (input.resumeSessionId) {
      args.push("--resume", input.resumeSessionId);
    }

    // 能力白名单：传给 CLI 的 --allowedTools 参数
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.allowedTools);
    }

    const spawnCwd = input.cwd ?? process.cwd();
    console.log(`[cc] spawn claude ${args.join(" ")} (cwd: ${spawnCwd})`);

    // stdin 设为 ignore —— CC 在 -p 模式下不期望 stdin 输入，
    // 默认 pipe 但不关闭会让 CC 等 3 秒后触发 EBADF 写文件错误
    // 注意：服务器必须用 npx tsx 直接启动，不能用 npm start / npm run dev
    // （npm 会用 cmd /c 包一层重定向 stdout，导致 CC 子进程继承无效 fd 报 EBADF）
    const child = spawn("claude", args, {
      shell: true,
      cwd: spawnCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let fullText = "";
    let buffer = "";
    let doneEmitted = false; // 标记是否已推送过 done/error（避免重复）
    let stderrText = ""; // 收集 stderr，出错时返回给手机端

    // 监听 stderr —— CC 报错（参数错、session 不存在、命令找不到）走 stderr，不读会被吞掉
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText += text;
      console.error(`[cc] stderr: ${text}`);
    });

    // 监听 spawn 错误（如 claude 命令不存在）
    child.on("error", (err: Error) => {
      console.error(`[cc] spawn 错误:`, err);
      stderrText += `\nspawn 错误: ${err.message}`;
    });

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

          const events = this.parseLine(parsed);

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
              if (evt.type === "done") {
                fullText = evt.text;
                doneEmitted = true;
              }
              if (evt.type === "error") doneEmitted = true;
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
          const events = this.parseLine(parsed);
          for (const evt of events) {
            if (evt.type === "delta") fullText += evt.text;
            if (evt.type === "done") {
              fullText = evt.text;
              doneEmitted = true;
            }
            if (evt.type === "error") doneEmitted = true;
            yield evt;
          }
        } catch {
          // 忽略
        }
      }

      // 如果没有 done/error 事件，补一个 done（CC 异常退出时的兜底）
      if (!doneEmitted) {
        if (fullText) {
          yield { type: "done", text: fullText };
        } else if (stderrText) {
          // stdout 空 + stderr 有内容 → CC 启动失败或运行报错
          const msg = stderrText.trim().split("\n").slice(-3).join(" | ");
          yield { type: "error", message: `CC 错误: ${msg}` };
        } else {
          yield { type: "error", message: "CC 无任何输出" };
        }
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

  /** 解析单行 JSON，转成 AgentEvent 列表（method 以访问 streamEventSeen 状态） */
  private parseLine(line: CCLine): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (line.type) {
      // 真正的 token 流式事件（--include-partial-messages 启用后）
      case "stream_event": {
        this.streamEventSeen = true;
        const evt = line.event;
        if (!evt) break;

        if (evt.type === "content_block_delta") {
          const delta = evt.delta;
          // 文本 token → 推送 delta
          if (delta?.type === "text_delta" && delta.text) {
            events.push({ type: "delta", text: delta.text });
          }
          // 工具调用的 input JSON 增量暂不处理（让 assistant 事件带完整 input 推送）
        }
        // content_block_start / content_block_stop / message_* 不直接推送，由 assistant 事件统一处理 tool_use
        break;
      }

      case "assistant": {
        const contents = line.message?.content ?? [];
        for (const c of contents) {
          if (c.type === "text" && c.text) {
            // 仅在未启用 stream_event 时推送完整 text delta（避免和 stream_event 重复）
            if (!this.streamEventSeen) {
              events.push({ type: "delta", text: c.text });
            }
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
        console.log(`[cc] result line: is_error=${line.is_error}, session_id=${line.session_id ?? "无"}, result=${JSON.stringify(line.result)?.slice(0, 100)}`);
        if (line.is_error) {
          events.push({ type: "error", message: line.result ?? "未知错误" });
        } else {
          events.push({ type: "done", text: line.result ?? "", sessionId: line.session_id });
        }
        break;
      }
    }

    return events;
  }
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
