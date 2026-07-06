/**
 * Relay Server —— 云端中继 + 持久化
 *
 * 两种客户端：
 *   1. agent client（家里 Gateway）：path=/agent，用 RELAY_TOKEN 鉴权
 *      推 agent_event → relay 持久化 + 回 ACK + 转发给所有在线手机
 *   2. mobile client（手机）：path=/mobile，用配对码/device token 鉴权
 *      可发 history_since 拉历史；实时接收 relay 转发的 EventFrame
 *
 * 不做 E2E 加密（云服务器是自己的）。
 */

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TimelineStore } from "./timeline-store.js";
import { AuthManager } from "../gateway/auth.js";
import {
  DEFAULT_RELAY_PORT,
  type RelayClientMessage,
  type RelayServerMessage,
  type AgentEventEnvelope,
  type HistorySinceRequest,
  type StoredTimelineEvent,
} from "./protocol.js";
import type { EventFrame } from "../protocol/frames.js";
import { PROTOCOL_VERSION, SERVER_NAME } from "../protocol/frames.js";

export interface RelayServerOptions {
  port?: number;
  /** agent client 鉴权 token（环境变量 RELAY_TOKEN） */
  relayToken: string;
  /** SQLite 路径，默认 ~/.agent-bridge/relay.db */
  dbPath?: string;
  /** 手机配对用的 AuthManager（如不传则新建） */
  auth?: AuthManager;
  /** 保留天数 */
  retentionDays?: number;
  /** 定时清理间隔（ms），默认 1 小时 */
  cleanupIntervalMs?: number;
}

export interface StartedRelay {
  port: number;
  auth: AuthManager;
  store: TimelineStore;
  close: () => void;
}

export function startRelayServer(opts: RelayServerOptions): StartedRelay {
  const port = opts.port ?? Number(process.env.RELAY_PORT) ?? DEFAULT_RELAY_PORT;
  const auth = opts.auth ?? new AuthManager();
  const store = new TimelineStore({
    dbPath: opts.dbPath,
    retentionDays: opts.retentionDays,
  });

  // 关闭中标志：close() 触发后，ws close handler 不再操作 store / 不再 log
  // 避免 vitest worker teardown 时 console.log 还在 pending 导致 EnvironmentTeardownError
  let closing = false;

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${SERVER_NAME} relay\n`);
  });

  // 两个 WS endpoint：/agent 给家里 Gateway，/mobile 给手机
  const agentWss = new WebSocketServer({ noServer: true });
  const mobileWss = new WebSocketServer({ noServer: true });

  // 路由 upgrade
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === "/agent") {
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit("connection", ws, req);
      });
    } else if (url.pathname === "/mobile") {
      mobileWss.handleUpgrade(req, socket, head, (ws) => {
        mobileWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // ─── agent client 处理 ───

  // agentId → WebSocket 映射，用于转发事件时区分来源
  const agentSockets = new Map<string, WebSocket>();

  agentWss.on("connection", (ws: WebSocket) => {
    let registered = false;
    let agentId: string | null = null;

    ws.on("message", (raw) => {
      let msg: RelayClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { kind: "agent_register_result", ok: false, error: "invalid-json" });
        return;
      }

      // 未注册阶段：只接受 agent_register
      if (!registered) {
        if (msg.kind !== "agent_register") {
          send(ws, { kind: "agent_register_result", ok: false, error: "must-register-first" });
          ws.close(4001, "must-register-first");
          return;
        }
        if (msg.token !== opts.relayToken) {
          send(ws, { kind: "agent_register_result", ok: false, error: "invalid-token" });
          ws.close(4003, "invalid-token");
          return;
        }
        registered = true;
        agentId = msg.agentId;
        agentSockets.set(agentId, ws);
        store.upsertAgent({
          id: msg.agentId,
          name: msg.info.name,
          type: msg.info.type,
          capabilities: msg.info.capabilities,
        });
        send(ws, { kind: "agent_register_result", ok: true });
        // 广播 agent 上线给所有手机
        broadcastAgentStatus(mobileWss, msg.agentId, "online");
        console.log(`[relay] agent 上线: ${msg.agentId} (${msg.info.name})`);
        return;
      }

      // 已注册：处理 agent_event
      if (msg.kind === "agent_event") {
        handleAgentEvent(ws, msg, agentId!);
        return;
      }

      // agent client 不应该发 history_since
      console.warn(`[relay] agent client 发了未识别消息: ${(msg as { kind: string }).kind}`);
    });

    ws.on("close", () => {
      if (agentId) {
        agentSockets.delete(agentId);
        if (closing) return; // relay 关闭中，不再操作 store / 不再 log
        try {
          store.updateAgentStatus(agentId, "offline");
          broadcastAgentStatus(mobileWss, agentId, "offline");
        } catch (err) {
          // store 可能已关闭（进程退出时），忽略
          console.warn(`[relay] agent 离线时 store 操作失败:`, err);
        }
        console.log(`[relay] agent 离线: ${agentId}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`[relay] agent socket error:`, err);
    });
  });

  function handleAgentEvent(_ws: WebSocket, msg: AgentEventEnvelope, agentId: string) {
    // 持久化
    const serverSeq = store.insertEvent({
      agentId,
      eventType: msg.eventType,
      eventData: msg.eventData,
    });
    // 回 ACK
    send(_ws, {
      kind: "agent_event_ack",
      clientSeq: msg.clientSeq,
      serverSeq,
    });
    // 转发给所有在线手机（转成 EventFrame 格式）
    const frame: EventFrame = {
      type: "event",
      event: msg.eventType,
      seq: serverSeq,
      payload: msg.eventData,
    };
    const data = JSON.stringify(frame);
    for (const client of mobileWss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // ─── mobile client 处理 ───

  mobileWss.on("connection", (ws: WebSocket) => {
    let authenticated = false;
    let lastSeq = store.getLatestSeq();

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // 未认证阶段：接受现有 connect 帧（兼容手机端）或 history_since
      if (!authenticated) {
        // 兼容现有 connect 请求帧
        if (isConnectReq(msg)) {
          const params = msg.params ?? {};
          const ok = authenticateMobile(params, auth);
          if (!ok.ok) {
            sendResError(ws, msg.id, ok.error!);
            ws.close(4003, "auth-failed");
            return;
          }
          authenticated = true;
          // 返回 helloOk + 当前 agent 列表 + 当前最新 seq
          const agents = store.listAgents().map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            capabilities: JSON.parse(a.capabilities) as string[],
          }));
          const payload = {
            protocol: PROTOCOL_VERSION,
            server: SERVER_NAME,
            agents,
            latestSeq: lastSeq,
            ...(ok.deviceToken ? { deviceToken: ok.deviceToken } : {}),
          };
          sendResOk(ws, msg.id, payload);
          // 推送当前所有 agent 状态
          for (const notice of store.getAgentStatusNotices()) {
            send(ws, notice);
          }
          return;
        }
        // 其他未认证消息直接拒绝
        if (isReqFrame(msg)) {
          sendResError(ws, msg.id, "not-connected");
        }
        return;
      }

      // 已认证：处理 history_since 或其他请求
      if (isHistorySinceReq(msg)) {
        handleHistorySince(ws, msg);
        return;
      }

      // 其他请求帧透传给 agent client（如果有）
      // 比如手机发 chat.send，需要转发给家里 Gateway
      if (isReqFrame(msg)) {
        forwardToAgent(msg);
        return;
      }
    });

    ws.on("close", () => {
      // 手机断开无需特殊处理，事件继续持久化
    });

    ws.on("error", (err) => {
      console.error(`[relay] mobile socket error:`, err);
    });
  });

  function handleHistorySince(ws: WebSocket, msg: HistorySinceRequest & { id?: string }) {
    const result = store.getEventsSince(msg.since, msg.limit, msg.agentId);
    const batch: StoredTimelineEvent[] = result.events;
    // 批量返回
    if (msg.id) {
      // 作为 res 返回（兼容手机端的 req/res 协议）
      sendResOk(ws, msg.id, {
        events: batch,
        hasMore: result.hasMore,
        nextSeq: result.nextSeq,
      });
    } else {
      // 作为 history_batch 事件返回
      send(ws, {
        kind: "history_batch",
        events: batch,
        hasMore: result.hasMore,
        nextSeq: result.nextSeq,
      });
    }
  }

  function forwardToAgent(reqFrame: unknown) {
    // 简单策略：广播给所有在线 agent client
    // 后续可以解析 reqFrame.params.agentId 精确路由
    const data = JSON.stringify(reqFrame);
    for (const ws of agentSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  // ─── 定时清理 ───

  const cleanupTimer = setInterval(
    () => {
      const deleted = store.cleanOldEvents();
      if (deleted > 0) {
        console.log(`[relay] 清理过期事件 ${deleted} 条`);
      }
    },
    opts.cleanupIntervalMs ?? 60 * 60 * 1000,
  );

  // ─── 启动 ───

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`\n┌──────────────────────────────────────────────────────┐`);
    console.log(`│  Agent Bridge Relay 已启动                            │`);
    console.log(`│  端口:      ${port}                                      │`);
    console.log(`│  配对码:    ${auth.pairingCodeDisplay}                             │`);
    console.log(`│  Agent 入口: ws://localhost:${port}/agent                  │`);
    console.log(`│  手机入口:  ws://localhost:${port}/mobile                  │`);
    console.log(`│  持久化:    SQLite (WAL)                              │`);
    console.log(`└──────────────────────────────────────────────────────┘\n`);
  });

  return {
    port,
    auth,
    store,
    close: () => {
      closing = true; // 标记关闭中，ws close handler 检查后直接 return
      clearInterval(cleanupTimer);
      // 主动关闭所有已建立的 ws 连接（WebSocketServer.close 只关 server 不关 clients）
      for (const ws of agentWss.clients) {
        try {
          ws.close(1001, "going-away");
        } catch {
          // ignore
        }
      }
      for (const ws of mobileWss.clients) {
        try {
          ws.close(1001, "going-away");
        } catch {
          // ignore
        }
      }
      agentWss.close();
      mobileWss.close();
      httpServer.close();
      store.close();
    },
  };
}

// ─── 工具函数 ───

function send(ws: WebSocket, msg: RelayServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendResOk(ws: WebSocket, id: string, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
  }
}

function sendResError(ws: WebSocket, id: string, error: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "res", id, ok: false, error: { code: error, message: error } }));
  }
}

function broadcastAgentStatus(mobileWss: WebSocketServer, agentId: string, status: "online" | "offline"): void {
  const notice = {
    kind: "agent_status" as const,
    agentId,
    status,
    lastSeen: Date.now(),
  };
  const data = JSON.stringify(notice);
  for (const client of mobileWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── 类型守卫 ───

interface ConnectReq {
  type: "req";
  id: string;
  method: "connect";
  params?: { token?: string; pairingCode?: string; protocol?: number };
}

function isConnectReq(msg: unknown): msg is ConnectReq {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "req" &&
    (msg as { method?: string }).method === "connect"
  );
}

interface ReqFrameLike {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

function isReqFrame(msg: unknown): msg is ReqFrameLike {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "req"
  );
}

function isHistorySinceReq(msg: unknown): msg is HistorySinceRequest & { id?: string } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { kind?: string }).kind === "history_since"
  );
}

// ─── 手机鉴权 ───

function authenticateMobile(
  params: { token?: string; pairingCode?: string },
  auth: AuthManager,
): { ok: true; deviceToken?: string } | { ok: false; error: string } {
  // 1. 已有 device token
  if (params.token && auth.verify(params.token)) {
    return { ok: true };
  }
  // 2. 配对码
  if (params.pairingCode) {
    const token = auth.pair(params.pairingCode);
    if (token) {
      return { ok: true, deviceToken: token };
    }
    return { ok: false, error: "pair-failed" };
  }
  return { ok: false, error: "not-connected" };
}
