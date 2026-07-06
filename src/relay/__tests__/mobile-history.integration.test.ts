/**
 * 端到端测试：手机端断连重连后从 relay 拉历史
 *
 * 场景：
 * 1. agent client 连上 relay，推几个事件
 * 2. mobile client 连上 relay，收到 connect 响应（含 latestSeq）
 * 3. mobile client 断开
 * 4. agent client 再推几个事件（持久化到 SQLite）
 * 5. mobile client 重连，发 history_since，收到历史事件
 * 6. 验证历史事件正确
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startRelayServer, type StartedRelay } from "../server.js";
import { RelayAgentClient } from "../agent-client.js";
import WebSocket from "ws";
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

// 等待条件成立
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

// 简单的手机客户端封装
class MobileClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  public receivedFrames: any[] = [];
  public latestSeq = 0;

  constructor(private url: string) {}

  connect(token?: string, pairingCode?: string): Promise<void> {
    return new Promise((resolve, reject) => {
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
      });
      this.ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        this.receivedFrames.push(frame);
        // 记录 connect 响应里的 latestSeq
        if (frame.type === "res" && frame.ok && frame.payload?.latestSeq !== undefined) {
          this.latestSeq = frame.payload.latestSeq;
        }
        // 实时事件更新 latestSeq
        if (frame.type === "event" && typeof frame.seq === "number") {
          this.latestSeq = Math.max(this.latestSeq, frame.seq);
        }
      });
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      // 超时保护
      setTimeout(() => resolve(), 2000);
    });
  }

  sendHistorySince(since: number, limit = 200): void {
    this.ws!.send(
      JSON.stringify({
        type: "req",
        id: `m${++this.msgId}`,
        method: "history_since",
        params: { since, limit },
      }),
    );
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // 等待指定类型的帧
  async waitForFrame(
    predicate: (frame: any) => boolean,
    timeoutMs = 3000,
  ): Promise<any> {
    return waitFor(() => {
      const found = this.receivedFrames.find(predicate);
      return found ?? null;
    }, timeoutMs);
  }
}

describe("手机端拉历史 端到端", () => {
  let relay: StartedRelay;
  let port: number;
  let tmpDir: string;
  let pairingCode: string;
  const RELAY_TOKEN = "test-relay-token-history";
  const agentClients: RelayAgentClient[] = [];
  const mobileClients: MobileClient[] = [];

  beforeAll(async () => {
    port = await findFreePort();
    tmpDir = mkdtempSync(join(tmpdir(), "relay-history-"));
    relay = startRelayServer({
      port,
      relayToken: RELAY_TOKEN,
      dbPath: join(tmpDir, "history.db"),
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

  it("手机断连重连后拉到断连期间的历史事件", async () => {
    // 1. agent client 连上 relay
    const agent = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "history-agent",
      agentInfo: { name: "History Agent", type: "claude-code", capabilities: [] },
    });
    agentClients.push(agent);
    agent.connect();
    await waitFor(() => (agent.isOnline ? true : null), 5000);

    // 2. agent 推几个事件（这些手机会实时收到）
    agent.pushEvent("agent", { type: "delta", text: "历史前的实时消息" });
    await waitFor(() => (agent.pendingCount === 0 ? true : null), 3000);

    // 3. mobile client 连上 relay（配对码）
    const mobile = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile);
    await mobile.connect(undefined, pairingCode);

    // 等 mobile 收到 connect 响应 + 实时事件
    await mobile.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents);
    expect(mobile.latestSeq).toBeGreaterThan(0);

    // 4. mobile 断开
    mobile.close();
    await new Promise((r) => setTimeout(r, 200));

    // 5. agent 继续推几个事件（mobile 断连期间）
    agent.pushEvent("agent", { type: "delta", text: "断连期间的消息1" });
    agent.pushEvent("agent", { type: "delta", text: "断连期间的消息2" });
    agent.pushEvent("agent", { type: "done", text: "断连期间完成" });
    await waitFor(() => (agent.pendingCount === 0 ? true : null), 3000);

    const seqBeforeReconnect = relay.store.getLatestSeq();
    expect(seqBeforeReconnect).toBeGreaterThan(mobile.latestSeq);

    // 6. mobile 重连，发 history_since
    const mobile2 = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile2);
    await mobile2.connect(undefined, pairingCode);
    await mobile2.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents);

    // 用 mobile 断开前的 latestSeq 作为 since 拉历史
    mobile2.sendHistorySince(mobile.latestSeq);

    // 7. 等 history_since 响应
    const historyRes = await mobile2.waitForFrame(
      (f) => f.type === "res" && f.ok && f.payload?.events !== undefined && f.payload?.nextSeq !== undefined,
      5000,
    );

    // 8. 验证历史事件
    expect(historyRes.payload.events).toBeDefined();
    expect(historyRes.payload.events.length).toBeGreaterThanOrEqual(3);
    // 验证事件内容
    const texts = historyRes.payload.events.map(
      (e: any) => e.eventData?.text ?? "",
    );
    expect(texts).toContain("断连期间的消息1");
    expect(texts).toContain("断连期间的消息2");
    expect(texts).toContain("断连期间完成");
    // nextSeq 应该是当前最新 seq
    expect(historyRes.payload.nextSeq).toBe(seqBeforeReconnect);
  });

  it("首次连接不拉历史（lastSeq=0）", async () => {
    // 这个测试验证：mobile 首次连上时 latestSeq>0 但不主动发 history_since
    // relay server 不会主动推历史，需要 mobile 主动发 req
    const agent = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "no-history-agent",
      agentInfo: { name: "No History", type: "x", capabilities: [] },
    });
    agentClients.push(agent);
    agent.connect();
    await waitFor(() => (agent.isOnline ? true : null), 5000);
    agent.pushEvent("agent", { type: "delta", text: "before mobile" });
    await waitFor(() => (agent.pendingCount === 0 ? true : null), 3000);

    const mobile = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile);
    await mobile.connect(undefined, pairingCode);
    await mobile.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents);

    // 首次连接，relay 返回 latestSeq，但 mobile 不会自动收到历史事件
    // 等 500ms 确认没有 history_batch 主动推送
    await new Promise((r) => setTimeout(r, 500));
    const historyBatch = mobile.receivedFrames.find(
      (f) => f.kind === "history_batch" || (f.payload?.events && f.payload?.nextSeq && f.payload?.hasMore !== undefined),
    );
    expect(historyBatch).toBeUndefined();
  });
});
