/**
 * CodexProvider —— 接入 OpenAI Codex CLI
 *
 * 通过 spawn `codex exec "<message>" --json --full-auto` 拿到 JSONL 输出，
 * 用 parseCodexLine（与 CodexAdapter 共用）解析后转成 AgentEvent 流式推送。
 *
 * 续接用 `codex exec resume <session-id> "<message>" --json --full-auto`，
 * session-id 从首次执行的 session_meta 行 payload.session_id 捕获，存到 SessionManager。
 *
 * 工作目录用 `-C <path>` 参数传给 codex（默认用 input.cwd）。
 *
 * 事件映射（详见 codex-adapter.ts 的 parseCodexLine）：
 *   response_item.payload.type === "message"            → delta
 *   response_item.payload.type === "function_call"      → tool_start
 *   response_item.payload.type === "function_call_output" → tool_end
 *   event_msg.payload.type === "agent_message"          → delta
 *   event_msg.payload.type === "task_complete"          → done
 *   event_msg.payload.type === "error"                  → error
 *
 * 注意：codex --full-auto 模式下工具调用是自动执行的，dangerousTools 审批是
 * post-execution（假审批），与 CC -p 模式同样问题。所以 dangerousTools=[] 时不触发审批，
 * 避免误导用户。要实现真正的 pre-execution 审批需要 codex 的 hook 机制（待研究）。
 */

import { spawn } from "node:child_process";
import type { AgentConfig, AgentInput, AgentProvider, AgentEvent } from "./types.js";
import type { AgentInfo } from "../protocol/frames.js";
import { parseCodexLine } from "../gateway/adapters/codex-adapter.js";

// codex JSONL 行类型（与 codex-adapter.ts 的 CodexLine 保持一致，独立声明避免循环依赖）
interface CodexLine {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    content?: Array<{ type: string; text?: string }>;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string | object;
    message?: string;
    session_id?: string;
    cwd?: string;
  };
  session_id?: string;
}

export class CodexProvider implements AgentProvider {
  readonly info: AgentInfo;

  constructor(config: AgentConfig) {
    this.info = {
      id: config.id,
      name: config.name,
      type: config.type,
      capabilities: config.capabilities,
    };
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const args = ["exec"];

    // 续接 codex session（input.resumeSessionId 在 index.ts 里由 codexSessionId 传入）
    if (input.resumeSessionId) {
      args.push("resume", input.resumeSessionId);
    }

    args.push(input.message, "--json", "--full-auto");

    // 工作目录：续接外部 session 时必须设为该 session 的 cwd，
    // 否则 codex 在 Gateway 当前 cwd 找不到上下文相关文件
    const spawnCwd = input.cwd ?? process.cwd();
    args.push("-C", spawnCwd);

    console.log(`[codex] spawn codex ${args.join(" ")}`);

    const child = spawn("codex", args, {
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let fullText = "";
    let buffer = "";
    let doneEmitted = false;
    let stderrText = "";
    let capturedSessionId: string | undefined;

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText += text;
      console.error(`[codex] stderr: ${text}`);
    });

    child.on("error", (err: Error) => {
      console.error(`[codex] spawn 错误:`, err);
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

          let parsed: CodexLine;
          try {
            parsed = JSON.parse(trimmed) as CodexLine;
          } catch {
            continue;
          }

          // 捕获 session_id（session_meta 行）
          if (parsed.type === "session_meta") {
            const sid = parsed.payload?.session_id ?? parsed.session_id;
            if (sid) {
              capturedSessionId = sid;
              console.log(`[codex] 捕获 session_id: ${sid}`);
            }
          }

          const events = parseCodexLine(parsed);
          for (const evt of events) {
            if (evt.type === "delta") fullText += evt.text;
            if (evt.type === "done") {
              doneEmitted = true;
              // 附加 capturedSessionId 到 done 事件（parseCodexLine 的 done 不带 sessionId）
              if (capturedSessionId && !evt.sessionId) {
                yield { type: "done", text: evt.text, sessionId: capturedSessionId };
                continue;
              }
            }
            if (evt.type === "error") doneEmitted = true;
            yield evt;
          }
        }
      }

      // 处理剩余 buffer
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as CodexLine;
          if (parsed.type === "session_meta") {
            const sid = parsed.payload?.session_id ?? parsed.session_id;
            if (sid) capturedSessionId = sid;
          }
          const events = parseCodexLine(parsed);
          for (const evt of events) {
            if (evt.type === "delta") fullText += evt.text;
            if (evt.type === "done") {
              doneEmitted = true;
              if (capturedSessionId && !evt.sessionId) {
                yield { type: "done", text: evt.text, sessionId: capturedSessionId };
                continue;
              }
            }
            if (evt.type === "error") doneEmitted = true;
            yield evt;
          }
        } catch {
          // 忽略
        }
      }

      // 兜底：codex 没发 task_complete 时补 done
      if (!doneEmitted) {
        if (capturedSessionId) {
          yield { type: "done", text: fullText, sessionId: capturedSessionId };
        } else if (stderrText) {
          const msg = stderrText.trim().split("\n").slice(-3).join(" | ");
          yield { type: "error", message: `codex 错误: ${msg}` };
        } else if (fullText) {
          yield { type: "done", text: fullText };
        } else {
          yield { type: "error", message: "codex 无任何输出（确认 @openai/codex 已安装）" };
        }
      }
    } finally {
      child.kill();
    }
  }
}
