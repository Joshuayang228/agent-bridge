/**
 * 端到端测试：agent 上下线状态广播
 *
 * 场景：
 * 1. agent client 连 relay → mobile 收到 agent_status(online) 事件
 * 2. agent client 断开 → mobile 收到 agent_status(offline) 事件
 * 3. mobile 重连时收到当前所有 agent 的状态（初始 online + 已离线的）
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startRelayServer, type StartedRelay } from "../server.js";
import { RelayAgentClient } from "../agent-client.js";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

class MobileClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  public receivedFrames: any[] = [];

  constructor(private url: string) {}

  connect(token?: string, pairingCode?: string): Promise<void> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.ws!.send(
          JSON.stringify({
            type: "req",
            id: `m${++this.msgId}`,
            method: "connect",
            params: { protocol: 1, token, pairingCode },
          }),
        );
        resolve();
      });
      this.ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        this.receivedFrames.push(frame);
      });
      this.ws.on("error", () => {});
      setTimeout(() => resolve(), 2000);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  async waitForFrame(predicate: (frame: any) => boolean, timeoutMs = 3000): Promise<any> {
    return waitFor(() => this.receivedFrames.find(predicate) ?? null, timeoutMs);
  }
}

describe("agent 上下线状态广播 端到端", () => {
  let relay: StartedRelay;
  let port: number;
  let tmpDir: string;
  let pairingCode: string;
  const RELAY_TOKEN = "test-relay-token-status";
  const agentClients: RelayAgentClient[] = [];
  const mobileClients: MobileClient[] = [];

  beforeAll(async () => {
    port = await findFreePort();
    tmpDir = mkdtempSync(join(tmpdir(), "relay-status-"));
    relay = startRelayServer({
      port,
      relayToken: RELAY_TOKEN,
      dbPath: join(tmpDir, "status.db"),
    });
    pairingCode = relay.auth.pairingCodeDisplay;
  });

  afterAll(() => {
    for (const c of agentClients) c.close();
    for (const m of mobileClients) m.close();
    relay.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const c of agentClients) c.close();
    agentClients.length = 0;
    for (const m of mobileClients) m.close();
    mobileClients.length = 0;
  });

  it("agent 上线时 mobile 收到 agent_status(online) 事件", async () => {
    // 1. mobile 先连 relay
    const mobile = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile);
    await mobile.connect(undefined, pairingCode);
    await mobile.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents);

    // 2. agent client 连 relay（触发 online 广播）
    const agent = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "status-agent-1",
      agentInfo: { name: "Status Agent 1", type: "claude-code", capabilities: ["shell"] },
    });
    agentClients.push(agent);
    agent.connect();
    await waitFor(() => (agent.isOnline ? true : null), 5000);

    // 3. mobile 应收到 agent_status(online) 事件
    const statusFrame = await mobile.waitForFrame(
      (f) => f.type === "event" && f.event === "agent_status" && f.payload?.agentId === "status-agent-1",
      3000,
    );
    expect(statusFrame.payload.status).toBe("online");
    expect(typeof statusFrame.payload.lastSeen).toBe("number");
  });

  it("agent 断开时 mobile 收到 agent_status(offline) 事件", async () => {
    // 1. agent 先连 relay
    const agent = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "status-agent-2",
      agentInfo: { name: "Status Agent 2", type: "claude-code", capabilities: ["shell"] },
    });
    agentClients.push(agent);
    agent.connect();
    await waitFor(() => (agent.isOnline ? true : null), 5000);

    // 2. mobile 连 relay（会立即收到 agent_status(online) 推送）
    const mobile = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile);
    await mobile.connect(undefined, pairingCode);
    await mobile.waitForFrame(
      (f) => f.type === "event" && f.event === "agent_status" && f.payload?.agentId === "status-agent-2" && f.payload?.status === "online",
      3000,
    );

    // 3. agent 断开 → mobile 收到 offline 事件
    agent.close();
    const offlineFrame = await mobile.waitForFrame(
      (f) => f.type === "event" && f.event === "agent_status" && f.payload?.agentId === "status-agent-2" && f.payload?.status === "offline",
      3000,
    );
    expect(offlineFrame).toBeDefined();
  });

  it("mobile 重连时收到当前所有 agent 状态（含已离线的）", async () => {
    // 1. agent1 连 relay → 在线
    const agent1 = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "status-agent-3",
      agentInfo: { name: "Status Agent 3", type: "claude-code", capabilities: ["shell"] },
    });
    agentClients.push(agent1);
    agent1.connect();
    await waitFor(() => (agent1.isOnline ? true : null), 5000);

    // 2. agent2 连后断开 → 离线
    const agent2 = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "status-agent-4",
      agentInfo: { name: "Status Agent 4", type: "claude-code", capabilities: ["shell"] },
    });
    agent2.connect();
    await waitFor(() => (agent2.isOnline ? true : null), 5000);
    agent2.close();
    // 等待 relay 处理完 offline
    await new Promise((r) => setTimeout(r, 300));

    // 3. mobile 连 relay，应立即收到两个 agent 的状态（agent3 online, agent4 offline）
    const mobile = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile);
    await mobile.connect(undefined, pairingCode);
    await mobile.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents, 3000);

    // 等收到两个 agent 的状态推送
    await waitFor(() => {
      const notices = mobile.receivedFrames.filter(
        (f) => f.type === "event" && f.event === "agent_status",
      );
      return notices.length >= 2 ? notices : null;
    }, 3000);

    const notices = mobile.receivedFrames.filter(
      (f) => f.type === "event" && f.event === "agent_status",
    );
    const agent3Notice = notices.find((n) => n.payload.agentId === "status-agent-3");
    const agent4Notice = notices.find((n) => n.payload.agentId === "status-agent-4");
    expect(agent3Notice).toBeDefined();
    expect(agent3Notice.payload.status).toBe("online");
    expect(agent4Notice).toBeDefined();
    expect(agent4Notice.payload.status).toBe("offline");
  });
});
