/**
 * WebSocket 协议处理器
 *
 * 处理握手、路由请求、流式事件推送。
 * 参考 OpenClaw 的两阶段运行模型：立即 ack + 流式 agent 事件 + 最终完成。
 */

import type { WebSocket } from "ws";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SessionManager } from "./session-manager.js";
import type { ConnectionManager } from "./connection-manager.js";
import type {
  ConnectParams,
  EventFrame,
  Frame,
  HelloOkPayload,
  ReqFrame,
  ResOkFrame,
  ResErrorFrame,
} from "../protocol/frames.js";
import { PROTOCOL_VERSION, SERVER_NAME } from "../protocol/frames.js";
import type { AuthManager } from "./auth.js";

// 每个连接的会话状态
interface SessionState {
  authenticated: boolean;
  seq: number;
  // 当前正在运行的 agent（用于 abort）
  runningController: AbortController | null;
  // 待审批的 resolver（手机端 approve/reject 后调用）
  pendingApproval: ((approved: boolean) => void) | null;
}

export function createWsHandler(
  registry: ProviderRegistry,
  auth: AuthManager,
  sessions: SessionManager,
  connections: ConnectionManager,
) {
  return function handleConnection(ws: WebSocket) {
    const state: SessionState = {
      authenticated: false,
      seq: 0,
      runningController: null,
      pendingApproval: null,
    };

    ws.on("message", async (data: Buffer) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
      } catch {
        send(ws, makeError("parse-error", "无效的 JSON"));
        return;
      }

      // 第一帧必须是 connect
      if (!state.authenticated) {
        if (frame.type !== "req" || frame.method !== "connect") {
          send(ws, makeError("not-connected", "请先发送 connect 请求"));
          return;
        }
        handleConnect(ws, frame, state, registry, auth, connections);
        return;
      }

      if (frame.type === "req") {
        await handleReq(ws, frame, state, registry, sessions);
      }
    });
  };
}

// ─── 握手 ───
function handleConnect(
  ws: WebSocket,
  frame: ReqFrame,
  state: SessionState,
  registry: ProviderRegistry,
  auth: AuthManager,
  connections: ConnectionManager,
) {
  const params = (frame.params ?? {}) as unknown as ConnectParams;

  // 路径 1：配对码首次配对
  if (params.pairingCode) {
    const deviceToken = auth.pair(params.pairingCode);
    if (!deviceToken) {
      send(ws, makeResError(frame.id, "pair-failed", "配对码无效"));
      ws.close(4001, "pair-failed");
      return;
    }
    state.authenticated = true;
    const payload: HelloOkPayload = {
      protocol: PROTOCOL_VERSION,
      server: SERVER_NAME,
      agents: registry.list(),
      deviceToken,
    };
    send(ws, makeResOk(frame.id, payload));
    connections.add(ws);
    console.log("[ws] 设备配对成功，已颁发 device token");
    return;
  }

  // 路径 2：已配对设备带 token 认证
  if (auth.verify(params.token)) {
    state.authenticated = true;
    const payload: HelloOkPayload = {
      protocol: PROTOCOL_VERSION,
      server: SERVER_NAME,
      agents: registry.list(),
    };
    send(ws, makeResOk(frame.id, payload));
    connections.add(ws);
    console.log("[ws] 客户端已认证");
    return;
  }

  // 认证失败
  send(ws, makeResError(frame.id, "auth-failed", "需要配对码或有效 token"));
  ws.close(4001, "auth-failed");
}

// ─── 请求路由 ───
async function handleReq(
  ws: WebSocket,
  frame: ReqFrame,
  state: SessionState,
  registry: ProviderRegistry,
  sessions: SessionManager,
) {
  switch (frame.method) {
    case "agents.list":
      send(ws, makeResOk(frame.id, { agents: registry.list() }));
      break;

    case "sessions.list":
      send(ws, makeResOk(frame.id, { sessions: sessions.list() }));
      break;

    case "sessions.create": {
      const params = (frame.params ?? {}) as { agentId: string; title?: string };
      const session = sessions.create(params.agentId, params.title);
      send(ws, makeResOk(frame.id, { session }));
      break;
    }

    case "sessions.delete": {
      const params = (frame.params ?? {}) as { sessionId: string };
      const ok = sessions.delete(params.sessionId);
      send(ws, makeResOk(frame.id, { status: ok ? "deleted" : "not-found" }));
      break;
    }

    case "chat.history": {
      const params = (frame.params ?? {}) as { sessionId: string };
      send(ws, makeResOk(frame.id, { messages: sessions.history(params.sessionId) }));
      break;
    }

    case "chat.send": {
      await handleChatSend(ws, frame, state, registry, sessions);
      break;
    }

    case "chat.abort": {
      if (state.runningController) {
        state.runningController.abort();
        send(ws, makeResOk(frame.id, { status: "aborted" }));
      } else {
        send(ws, makeResOk(frame.id, { status: "idle" }));
      }
      break;
    }

    case "chat.approve": {
      if (state.pendingApproval) {
        state.pendingApproval(true);
        state.pendingApproval = null;
        send(ws, makeResOk(frame.id, { status: "approved" }));
      } else {
        send(ws, makeResOk(frame.id, { status: "no-pending" }));
      }
      break;
    }

    case "chat.reject": {
      if (state.pendingApproval) {
        state.pendingApproval(false);
        state.pendingApproval = null;
        send(ws, makeResOk(frame.id, { status: "rejected" }));
      } else {
        send(ws, makeResOk(frame.id, { status: "no-pending" }));
      }
      break;
    }

    default:
      send(ws, makeResError(frame.id, "unknown-method", `未知方法: ${frame.method}`));
  }
}

// ─── chat.send：两阶段运行模型 ───
async function handleChatSend(
  ws: WebSocket,
  frame: ReqFrame,
  state: SessionState,
  registry: ProviderRegistry,
  sessions: SessionManager,
) {
  const params = (frame.params ?? {}) as {
    agentId: string;
    message: string;
    sessionId: string;
  };

  const provider = registry.get(params.agentId);
  if (!provider) {
    send(ws, makeResError(frame.id, "agent-not-found", `找不到 agent: ${params.agentId}`));
    return;
  }

  // 存用户消息
  sessions.addUserMessage(params.sessionId, params.message);

  // 阶段 1：立即 ack
  send(ws, makeResOk(frame.id, { status: "accepted" }));

  // 阶段 2：流式运行 agent
  const controller = new AbortController();
  state.runningController = controller;

  let fullResponse = "";

  try {
    const events = provider.send({
      sessionId: params.sessionId,
      agentId: params.agentId,
      message: params.message,
      requestApproval: (action, description) => {
        return new Promise<boolean>((resolve) => {
          send(ws, makeEvent(state, "agent", { type: "approval_required", action, description }));
          state.pendingApproval = resolve;
        });
      },
    });

    for await (const evt of events) {
      if (controller.signal.aborted) break;
      if (evt.type === "delta") fullResponse += evt.text;
      if (evt.type === "done" && evt.text) fullResponse = evt.text;
      send(ws, makeEvent(state, "agent", evt));
    }

    // 存 assistant 回复
    if (fullResponse) {
      sessions.addAssistantMessage(params.sessionId, fullResponse);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(ws, makeEvent(state, "agent", { type: "error", message }));
  } finally {
    state.runningController = null;
  }
}

// ─── 帧构造工具 ───
function makeResOk(id: string, payload?: unknown): ResOkFrame {
  return { type: "res", id, ok: true, payload };
}

function makeResError(id: string, code: string, message: string): ResErrorFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function makeEvent(state: SessionState, event: string, payload: unknown): EventFrame {
  return { type: "event", event, seq: ++state.seq, payload };
}

function makeError(code: string, message: string): ResErrorFrame {
  return { type: "res", id: "", ok: false, error: { code, message } };
}

function send(ws: WebSocket, frame: Frame): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}
