/**
 * MockProvider —— 用于验证链路的模拟 agent
 *
 * 逐字流式输出，模拟真实 agent 的流式行为。
 * config.mode === "echo" 时回声用户消息。
 */

import type { AgentConfig, AgentInput, AgentProvider, AgentEvent } from "./types.js";
import type { AgentInfo } from "../protocol/frames.js";

const REPLIES = [
  "你好，我是测试机器人，这条消息是逐字流式输出的。",
  "收到你的消息了，这是一条模拟回复。",
  "我是一个 mock agent，用来验证通讯链路是否通畅。",
];

export class MockProvider implements AgentProvider {
  readonly info: AgentInfo;
  private mode: string;

  constructor(config: AgentConfig) {
    this.info = {
      id: config.id,
      name: config.name,
      type: config.type,
      capabilities: config.capabilities,
    };
    this.mode = (config.config?.mode as string) ?? "reply";
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    // 模拟思考延迟
    await delay(200);

    if (this.mode === "echo") {
      yield* streamText(`回声：${input.message}`);
      yield { type: "done", text: `回声：${input.message}` };
      return;
    }

    // 危险操作审批演示
    if (input.message.includes("删除") || input.message.includes("delete") || input.message.includes("rm")) {
      yield* streamText("检测到删除操作，需要审批。\n\n");
      yield { type: "delta", text: "" }; // 触发前端渲染

      const approved = input.requestApproval
        ? await input.requestApproval("rm -rf /tmp/test", "删除临时目录 /tmp/test")
        : true;

      if (approved) {
        yield* streamText("✅ 已批准，执行删除操作...\n");
        yield { type: "tool_start", tool: "Bash: rm -rf /tmp/test" };
        await delay(500);
        yield { type: "tool_end", tool: "Bash: rm -rf /tmp/test", result: "已删除 /tmp/test" };
        yield* streamText("删除完成。");
        yield { type: "done", text: "✅ 已批准，执行删除操作...\n删除完成。" };
      } else {
        yield* streamText("❌ 已拒绝，取消删除操作。");
        yield { type: "done", text: "❌ 已拒绝，取消删除操作。" };
      }
      return;
    }

    // 默认回复模式
    const reply = pickReply(input.message);
    yield* streamText(reply);
    yield { type: "done", text: reply };
  }
}

// 逐字流式输出
async function* streamText(text: string): AsyncIterable<AgentEvent> {
  for (const char of text) {
    await delay(30 + Math.random() * 40);
    yield { type: "delta", text: char };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickReply(message: string): string {
  if (message.includes("工具") || message.includes("tool")) {
    return "我可以模拟工具调用的流程。";
  }
  return REPLIES[Math.floor(Math.random() * REPLIES.length)];
}
