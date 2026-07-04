import { describe, it, expect } from "vitest";
import { MockProvider } from "../mock-provider.js";
import type { AgentConfig, AgentInput } from "../types.js";

function makeInput(message: string, requestApproval?: AgentInput["requestApproval"]): AgentInput {
  return {
    sessionId: "test-session",
    agentId: "mock",
    message,
    requestApproval: requestApproval ?? (async () => true),
  };
}

describe("MockProvider", () => {
  it("info 返回正确的 agent 信息", () => {
    const config: AgentConfig = {
      id: "mock",
      name: "测试机器人",
      type: "mock",
      capabilities: ["chat"],
    };
    const provider = new MockProvider(config);
    expect(provider.info.id).toBe("mock");
    expect(provider.info.name).toBe("测试机器人");
    expect(provider.info.type).toBe("mock");
  });

  it("send 返回流式 delta 事件", async () => {
    const provider = new MockProvider({
      id: "mock",
      name: "测试",
      type: "mock",
      capabilities: ["chat"],
    });
    const events = [];
    for await (const evt of provider.send(makeInput("你好"))) {
      events.push(evt);
    }
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.some((e) => e.text.length > 0)).toBe(true);
  });

  it("send 最后返回 done 事件", async () => {
    const provider = new MockProvider({
      id: "mock",
      name: "测试",
      type: "mock",
      capabilities: ["chat"],
    });
    const events = [];
    for await (const evt of provider.send(makeInput("你好"))) {
      events.push(evt);
    }
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(done.text.length).toBeGreaterThan(0);
    }
  });

  it("echo 模式回声消息", async () => {
    const provider = new MockProvider({
      id: "mock-echo",
      name: "回声",
      type: "mock",
      capabilities: ["chat"],
      config: { mode: "echo" },
    });
    const events = [];
    for await (const evt of provider.send(makeInput("你好世界"))) {
      events.push(evt);
    }
    const done = events.find((e) => e.type === "done");
    if (done && done.type === "done") {
      expect(done.text).toContain("你好世界");
    }
  });

  it("包含「删除」的消息触发审批", async () => {
    let approvalCalled = false;
    const provider = new MockProvider({
      id: "mock",
      name: "测试",
      type: "mock",
      capabilities: ["chat"],
    });
    const events = [];
    for await (const evt of provider.send(
      makeInput("帮我删除文件", async () => {
        approvalCalled = true;
        return true;
      }),
    )) {
      events.push(evt);
    }
    // 审批回调被调用
    expect(approvalCalled).toBe(true);
    // 审批通过后有执行结果
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(done.text).toContain("已批准");
    }
  });
});
