/**
 * CodexProvider —— 接入 OpenAI Codex CLI
 *
 * 通过 spawn `codex exec "<message>" --json --sandbox workspace-write` 拿到 JSONL 输出，
 * 解析后转成 AgentEvent 流式推送。
 *
 * 续接用 `codex exec resume <session-id> "<message>" --json --sandbox workspace-write`，
 * session-id 从首次执行的 thread.started 行 thread_id 捕获，存到 SessionManager。
 *
 * 工作目录用 `-C <path>` 参数传给 codex（默认用 input.cwd）。
 *
 * codex exec --json 输出格式（实测 v0.142.5）：
 *   { type: "thread.started", thread_id }                → done 事件的 sessionId
 *   { type: "turn.started" }                             → 忽略
 *   { type: "item.completed", item: {
 *       id, type: "agent_message", text } }              → delta
 *   { type: "item.started", item: {
 *       id, type: "command_execution",                   → tool_start
 *       command, status: "in_progress" } }
 *   { type: "item.completed", item: {
 *       id, type: "command_execution",                   → tool_end
 *       command, aggregated_output, exit_code, status: "completed" } }
 *   { type: "turn.completed", usage: {...} }             → done
 *
 * 注意：codex 的工具调用是自动执行的（--sandbox workspace-write），dangerousTools 审批
 * 是 post-execution（假审批），与 CC -p 模式同样问题。所以 dangerousTools=[] 时不触发审批，
 * 避免误导用户。要实现真正的 pre-execution 审批需要 codex 的 hook 机制（待研究）。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentInput, AgentProvider, AgentEvent, ToolApprovalResult } from "./types.js";
import type { AgentInfo } from "../protocol/frames.js";

// codex exec --json 输出的行类型
interface CodexExecLine {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    // agent_message
    text?: string;
    // command_execution
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
  };
}

export class CodexProvider implements AgentProvider {
  readonly info: AgentInfo;
  private dangerousTools: Set<string>;
  // 会话级已批准的工具
  private sessionApprovedTools = new Set<string>();

  constructor(config: AgentConfig) {
    this.info = {
      id: config.id,
      name: config.name,
      type: config.type,
      capabilities: config.capabilities,
    };
    this.dangerousTools = new Set(config.dangerousTools ?? []);
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const args = ["exec", "--json", "--sandbox", "workspace-write"];

    // 工作目录：续接外部 session 时必须设为该 session 的 cwd，
    // 否则 codex 在 Gateway 当前 cwd 找不到上下文相关文件
    const spawnCwd = input.cwd ?? process.cwd();
    args.push("-C", spawnCwd);

    // 续接 codex session（input.resumeSessionId 在 index.ts 里由 codexSessionId 传入）
    // 注意：resume 子命令必须放在 options 之后、prompt 之前
    if (input.resumeSessionId) {
      args.push("resume", input.resumeSessionId);
    }

    args.push(input.message);

    console.log(`[codex] spawn codex exec ${input.resumeSessionId ? "resume ... " : ""}"${input.message.slice(0, 30)}" (cwd: ${spawnCwd})`);

    const child = spawn("codex", args, {
      shell: true,
      cwd: spawnCwd,
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
      // codex 的 INFO/WARN 日志都走 stderr，只记 debug 级别，不刷屏
      if (text.includes("ERROR") || text.includes("error")) {
        console.error(`[codex] stderr: ${text.trim().split("\n")[0]}`);
      }
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

          let parsed: CodexExecLine;
          try {
            parsed = JSON.parse(trimmed) as CodexExecLine;
          } catch {
            continue;
          }

          // 捕获 thread_id（= session_id）
          if (parsed.type === "thread.started" && parsed.thread_id) {
            capturedSessionId = parsed.thread_id;
            console.log(`[codex] 捕获 thread_id: ${capturedSessionId}`);
          }

          for (const evt of this.parseLine(parsed)) {
            if (evt.type === "tool_start" && evt.toolName && this.isDangerous(evt.toolName)) {
              // 会话级白名单
              if (this.sessionApprovedTools.has(evt.toolName)) {
                yield evt;
                continue;
              }
              yield evt;
              let result: ToolApprovalResult;
              if (input.requestApproval && evt.toolName && evt.input) {
                result = await input.requestApproval({
                  id: evt.toolId ?? randomUUID(),
                  toolName: evt.toolName,
                  input: evt.input,
                  description: evt.tool,
                });
              } else {
                result = { decision: "approved" };
              }
              if (result.decision === "approved" || result.decision === "approved_for_session") {
                if (result.decision === "approved_for_session") {
                  this.sessionApprovedTools.add(evt.toolName);
                }
              } else if (result.decision === "denied") {
                child.kill();
                yield { type: "error", message: result.reason || `用户拒绝了工具调用：${evt.toolName}` };
                return;
              } else if (result.decision === "aborted") {
                child.kill();
                yield { type: "error", message: "操作已中止" };
                return;
              }
            } else {
              if (evt.type === "delta") fullText += evt.text;
              if (evt.type === "done") {
                doneEmitted = true;
                yield { type: "done", text: fullText, sessionId: capturedSessionId };
                continue;
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
          const parsed = JSON.parse(trimmed) as CodexExecLine;
          if (parsed.type === "thread.started" && parsed.thread_id) {
            capturedSessionId = parsed.thread_id;
          }
          for (const evt of this.parseLine(parsed)) {
            if (evt.type === "tool_start" && evt.toolName && this.isDangerous(evt.toolName)) {
              if (this.sessionApprovedTools.has(evt.toolName)) {
                yield evt;
                continue;
              }
              yield evt;
              let result: ToolApprovalResult;
              if (input.requestApproval && evt.toolName && evt.input) {
                result = await input.requestApproval({
                  id: evt.toolId ?? randomUUID(),
                  toolName: evt.toolName,
                  input: evt.input,
                  description: evt.tool,
                });
              } else {
                result = { decision: "approved" };
              }
              if (result.decision === "approved" || result.decision === "approved_for_session") {
                if (result.decision === "approved_for_session") {
                  this.sessionApprovedTools.add(evt.toolName);
                }
              } else if (result.decision === "denied") {
                child.kill();
                yield { type: "error", message: result.reason || `用户拒绝了工具调用：${evt.toolName}` };
                return;
              } else if (result.decision === "aborted") {
                child.kill();
                yield { type: "error", message: "操作已中止" };
                return;
              }
            } else {
              if (evt.type === "delta") fullText += evt.text;
              if (evt.type === "done") {
                doneEmitted = true;
                yield { type: "done", text: fullText, sessionId: capturedSessionId };
                continue;
              }
              if (evt.type === "error") doneEmitted = true;
              yield evt;
            }
          }
        } catch {
          // 忽略
        }
      }

      // 兜底：codex 没发 turn.completed 时补 done
      if (!doneEmitted) {
        if (capturedSessionId) {
          yield { type: "done", text: fullText, sessionId: capturedSessionId };
        } else if (stderrText) {
          const msg = stderrText.trim().split("\n").slice(-3).join(" | ");
          yield { type: "error", message: `codex 错误: ${msg}` };
        } else if (fullText) {
          yield { type: "done", text: fullText };
        } else {
          yield { type: "error", message: "codex 无任何输出" };
        }
      }
    } finally {
      child.kill();
    }
  }

  private parseLine(line: CodexExecLine): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (line.type) {
      case "thread.started":
        // 只捕获 thread_id，不发事件（由外层处理 sessionId）
        break;

      case "item.started": {
        const item = line.item;
        if (item?.type === "command_execution" && item.command) {
          const cmdShort = item.command.length > 100 ? item.command.slice(0, 100) + "..." : item.command;
          events.push({
            type: "tool_start",
            tool: cmdShort,
            toolId: item.id,
            toolName: "Bash",
            input: { command: item.command },
          });
        }
        break;
      }

      case "item.completed": {
        const item = line.item;
        if (!item) break;

        if (item.type === "agent_message" && item.text) {
          events.push({ type: "delta", text: item.text });
        } else if (item.type === "command_execution") {
          const cmdShort = item.command
            ? (item.command.length > 100 ? item.command.slice(0, 100) + "..." : item.command)
            : "command_execution";
          let result = item.aggregated_output ?? "";
          if (result.length > 200) result = result.slice(0, 200) + "...";
          events.push({ type: "tool_end", tool: cmdShort, result });
        }
        break;
      }

      case "turn.completed":
        events.push({ type: "done", text: "" });
        break;
    }

    return events;
  }

  /** 检查工具是否危险 */
  private isDangerous(toolName: string): boolean {
    return this.dangerousTools.has(toolName);
  }
}
