/**
 * 端到端测试：审批状态持久化 + 请求上行
 *
 * 场景：
 * 1. agent client 连 relay，模拟一个审批请求（推 approval_required 事件）
 * 2. Gateway 设置 pendingApproval
 * 3. mobile client 断连
 * 4. mobile client 重连，拉历史，看到 approval_required 事件
 * 5. mobile client 发 chat.approve（通过 relay 上行到 Gateway）
 * 6. Gateway resolveApproval，推 res 回 relay
 * 7. mobile client 收到 res，验证审批成功
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startRelayServer, type StartedRelay } from "../server.js";
import { RelayAgentClient } from "../agent-client.js";
import { ConnectionManager } from "../../gateway/connection-manager.js";
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

// 手机客户端封装
class MobileClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  public receivedFrames: any[] = [];
  public latestSeq = 0;
  private pendingResolvers = new Map<string, (frame: any) => void>();

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
        if (frame.type === "event" && typeof frame.seq === "number") {
          this.latestSeq = Math.max(this.latestSeq, frame.seq);
        }
        // res 帧匹配 pending resolver
        if (frame.type === "res" && this.pendingResolvers.has(frame.id)) {
          this.pendingResolvers.get(frame.id)!(frame);
          this.pendingResolvers.delete(frame.id);
        }
      });
      this.ws.on("error", () => {});
      setTimeout(() => resolve(), 2000);
    });
  }

  sendReq(method: string, params?: any): Promise<any> {
    const id = `m${++this.msgId}`;
    return new Promise((resolve) => {
      this.pendingResolvers.set(id, resolve);
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
      // 超时保护
      setTimeout(() => {
        if (this.pendingResolvers.has(id)) {
          this.pendingResolvers.delete(id);
          resolve(null);
        }
      }, 3000);
    });
  }

  sendHistorySince(since: number): void {
    this.ws!.send(
      JSON.stringify({
        type: "req",
        id: `m${++this.msgId}`,
        method: "history_since",
        params: { since, limit: 200 },
      }),
    );
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  async waitForFrame(predicate: (frame: any) => boolean, timeoutMs = 3000): Promise<any> {
    return waitFor(() => this.receivedFrames.find(predicate) ?? null, timeoutMs);
  }
}

describe("审批状态持久化 + 请求上行 端到端", () => {
  let relay: StartedRelay;
  let port: number;
  let tmpDir: string;
  let pairingCode: string;
  let connections: ConnectionManager;
  const RELAY_TOKEN = "test-relay-token-approval";
  const agentClients: RelayAgentClient[] = [];
  const mobileClients: MobileClient[] = [];

  beforeAll(async () => {
    port = await findFreePort();
    tmpDir = mkdtempSync(join(tmpdir(), "relay-approval-"));
    relay = startRelayServer({
      port,
      relayToken: RELAY_TOKEN,
      dbPath: join(tmpDir, "approval.db"),
    });
    pairingCode = relay.auth.pairingCodeDisplay;
    connections = new ConnectionManager();
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

  it("手机断连期间产生审批请求，重连后拉历史看到并批准", async () => {
    // 1. agent client 连 relay，设置 onMobileRequest 处理 chat.approve
    let approvalResolved = false;
    let approvalResult = false;
    connections.setPendingApproval((approved: boolean) => {
      approvalResolved = true;
      approvalResult = approved;
    });

    const agent = new RelayAgentClient({
      relayUrl: `ws://127.0.0.1:${port}/agent`,
      token: RELAY_TOKEN,
      agentId: "approval-agent",
      agentInfo: { name: "Approval Agent", type: "claude-code", capabilities: ["shell"] },
      onMobileRequest: (reqFrame) => {
        const frame = reqFrame as { type?: string; id?: string; method?: string };
        if (frame?.type === "req" && frame.method === "chat.approve") {
          const ok = connections.resolveApproval(true);
          agent.pushResponse({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { status: ok ? "approved" : "no-pending" },
          });
        }
      },
    });
    agentClients.push(agent);
    agent.connect();
    await waitFor(() => (agent.isOnline ? true : null), 5000);

    // 2. mobile client 连 relay（此时无事件，latestSeq=0）
    const mobile = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile);
    await mobile.connect(undefined, pairingCode);
    await mobile.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents);
    const mobileLastSeq = mobile.latestSeq;

    // 3. mobile 断连
    mobile.close();
    await new Promise((r) => setTimeout(r, 200));

    // 4. agent 推 approval_required 事件（断连期间产生，持久化到 relay）
    agent.pushEvent("agent", {
      type: "approval_required",
      action: "rm -rf /tmp/test",
      description: "删除测试目录",
    });
    await waitFor(() => (agent.pendingCount === 0 ? true : null), 3000);

    // 5. mobile2 重连，拉历史（since=mobileLastSeq）
    const mobile2 = new MobileClient(`ws://127.0.0.1:${port}/mobile`);
    mobileClients.push(mobile2);
    await mobile2.connect(undefined, pairingCode);
    await mobile2.waitForFrame((f) => f.type === "res" && f.ok && f.payload?.agents);

    mobile2.sendHistorySince(mobileLastSeq);
    const historyRes = await mobile2.waitForFrame(
      (f) => f.type === "res" && f.payload?.events !== undefined && f.payload?.nextSeq !== undefined,
      5000,
    );
    expect(historyRes.payload.events.length).toBeGreaterThanOrEqual(1);
    const approvalHistory = historyRes.payload.events.find(
      (e: any) => e.eventData?.type === "approval_required",
    );
    expect(approvalHistory).toBeDefined();
    expect(approvalHistory.eventData.action).toBe("rm -rf /tmp/test");

    // 6. mobile2 发 chat.approve（通过 relay 上行到 Gateway）
    const approveRes = await mobile2.sendReq("chat.approve", {});
    expect(approveRes).not.toBeNull();
    expect(approveRes.ok).toBe(true);
    expect(approveRes.payload.status).toBe("approved");

    // 7. 验证 connections.resolveApproval 被调用
    await waitFor(() => (approvalResolved ? true : null), 1000);
    expect(approvalResolved).toBe(true);
    expect(approvalResult).toBe(true);
  });

  it("无未决审批时 resolveApproval 返回 false", async () => {
    connections.setPendingApproval(null);
    expect(connections.resolveApproval(true)).toBe(false);
    expect(connections.resolveApproval(false)).toBe(false);
  });

  it("abortRunning 全局生效", async () => {
    const controller = new AbortController();
    connections.setRunningController(controller);
    expect(connections.abortRunning()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(connections.abortRunning()).toBe(false); // 已清空
  });
});
