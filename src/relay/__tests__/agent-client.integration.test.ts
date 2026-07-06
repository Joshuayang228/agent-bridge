import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startRelayServer, type StartedRelay } from "../server.js";
import { RelayAgentClient } from "../agent-client.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 找一个空闲端口
async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("无法获取端口"));
      }
    });
  });
}

// 等待条件成立，超时抛错
async function waitFor<T>(
  fn: () => T | undefined | null,
  timeoutMs: number = 3000,
  intervalMs: number = 50,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

describe("RelayAgentClient + RelayServer 集成", () => {
  let relay: StartedRelay;
  let port: number;
  let tmpDir: string;
  const RELAY_TOKEN = "test-relay-token-12345";

  beforeAll(async () => {
    port = await findFreePort();
    tmpDir = mkdtempSync(join(tmpdir(), "relay-integration-"));
    relay = startRelayServer({
      port,
      relayToken: RELAY_TOKEN,
      dbPath: join(tmpDir, "integration.db"),
    });
  });

  afterAll(() => {
    relay.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const clients: RelayAgentClient[] = [];

  afterEach(() => {
    for (const c of clients) c.close();
    clients.length = 0;
  });

  it("agent client 连接 relay 并注册成功", async () => {
    const statusLog: string[] = [];
    const client = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "test-agent-1",
      agentInfo: { name: "Test Agent", type: "claude-code", capabilities: ["shell"] },
      onStatusChange: (status) => statusLog.push(status),
    });
    clients.push(client);
    client.connect();

    await waitFor(() => (statusLog.includes("online") ? true : null), 5000);
    expect(client.isOnline).toBe(true);

    // agent 应该在 store 里
    const agent = relay.store.getAgent("test-agent-1");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Test Agent");
    expect(agent!.status).toBe("online");
  });

  it("错误 token 注册失败", async () => {
    const statusLog: string[] = [];
    const client = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: "wrong-token",
      agentId: "bad-agent",
      agentInfo: { name: "Bad", type: "x", capabilities: [] },
      onStatusChange: (status, detail) => statusLog.push(`${status}:${detail ?? ""}`),
    });
    clients.push(client);
    client.connect();

    await waitFor(
      () => (statusLog.some((s) => s.startsWith("error:")) ? true : null),
      5000,
    );
    expect(client.isOnline).toBe(false);
  });

  it("pushEvent 推到 relay 并持久化 + 收到 ACK", async () => {
    const client = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "test-agent-2",
      agentInfo: { name: "Agent 2", type: "claude-code", capabilities: [] },
    });
    clients.push(client);
    client.connect();
    await waitFor(() => (client.isOnline ? true : null), 5000);

    const beforeSeq = relay.store.getLatestSeq();
    client.pushEvent("agent", { type: "delta", text: "hello from agent" });

    // 等 ACK（pendingAcks 清空）
    await waitFor(() => (client.pendingCount === 0 ? true : null), 3000);
    expect(client.pendingCount).toBe(0);

    // store 里应该有新事件
    await waitFor(() => (relay.store.getLatestSeq() > beforeSeq ? true : null), 3000);
    const result = relay.store.getEventsSince(beforeSeq);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe("agent");
    expect(result.events[0].eventData).toEqual({ type: "delta", text: "hello from agent" });
    expect(result.events[0].agentId).toBe("test-agent-2");
  });

  it("连续 pushEvent 都收到 ACK", async () => {
    const client = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "test-agent-3",
      agentInfo: { name: "Agent 3", type: "claude-code", capabilities: [] },
    });
    clients.push(client);
    client.connect();
    await waitFor(() => (client.isOnline ? true : null), 5000);

    for (let i = 0; i < 5; i++) {
      client.pushEvent("agent", { n: i });
    }
    expect(client.pendingCount).toBe(5);

    await waitFor(() => (client.pendingCount === 0 ? true : null), 3000);
    expect(client.pendingCount).toBe(0);
  });

  it("agent 离线后 store 标记 offline", async () => {
    const client = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "test-agent-offline",
      agentInfo: { name: "Offline Test", type: "x", capabilities: [] },
    });
    client.connect();
    await waitFor(() => (client.isOnline ? true : null), 5000);
    expect(relay.store.getAgent("test-agent-offline")!.status).toBe("online");

    client.close();
    // relay 检测到断开后会标记 offline
    await waitFor(
      () => (relay.store.getAgent("test-agent-offline")?.status === "offline" ? true : null),
      3000,
    );
    expect(relay.store.getAgent("test-agent-offline")!.status).toBe("offline");
  });

  it("断连重连后补发未 ACK 的事件", async () => {
    // 这个测试比较复杂，需要模拟断连
    // 简化：先连一次，push 事件但不等 ACK，断开，重连，验证事件补发
    const client = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "test-agent-reconnect",
      agentInfo: { name: "Reconnect", type: "x", capabilities: [] },
      reconnectIntervalMs: 200, // 快速重连
    });
    clients.push(client);
    client.connect();
    await waitFor(() => (client.isOnline ? true : null), 5000);

    // push 事件
    const beforeSeq = relay.store.getLatestSeq();
    client.pushEvent("agent", { test: "reconnect-payload" });

    // 立即关闭连接（不等 ACK）
    // 通过 close 内部 ws 但不设置 closed 标志
    // 这里用 hack：直接访问内部 ws
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).ws?.close(4000, "test-disconnect");

    // 等待重连
    await waitFor(() => (client.isOnline ? true : null), 5000);

    // 等待 ACK（补发后应该收到）
    await waitFor(() => (client.pendingCount === 0 ? true : null), 5000);
    expect(client.pendingCount).toBe(0);

    // 验证事件确实持久化了
    await waitFor(() => (relay.store.getLatestSeq() > beforeSeq ? true : null), 3000);
    const result = relay.store.getEventsSince(beforeSeq);
    expect(result.events.some((e) => e.eventData).valueOf()).toBeTruthy();
  });
});
