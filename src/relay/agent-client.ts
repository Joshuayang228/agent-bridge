/**
 * RelayAgentClient —— 家里 Gateway 连云端 relay 的 outbound 客户端
 *
 * 职责：
 *   1. outbound WSS 主动连云端 relay（穿透 NAT）
 *   2. 注册 agent 身份（带 AGENT_TOKEN）
 *   3. 把本地产生的事件推给 relay（agent_event + clientSeq）
 *   4. 维护 send buffer：已发出但未 ACK 的事件，重连后补发
 *   5. 接收 relay 转发过来的手机请求（透传给 ws-handler）
 *
 * 不做 E2E 加密。
 */

import WebSocket from "ws";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  AgentRegister,
  AgentEventEnvelope,
  RelayServerMessage,
} from "./protocol.js";

export interface RelayAgentClientOptions {
  /** relay 的 WS URL，如 ws://relay.example.com:18790/agent */
  relayUrl: string;
  /** 鉴权 token（环境变量 AGENT_TOKEN） */
  token: string;
  /** agent 标识，默认 hostname-随机后缀 */
  agentId?: string;
  /** agent 元信息 */
  agentInfo: {
    name: string;
    type: string;
    capabilities: string[];
  };
  /** 收到 relay 转发过来的手机请求时调用 */
  onMobileRequest?: (reqFrame: unknown) => void;
  /** 连接状态变化回调 */
  onStatusChange?: (status: "connecting" | "online" | "offline" | "error", detail?: string) => void;
  /** 重连间隔（ms），默认 5 秒 */
  reconnectIntervalMs?: number;
  /** 注册超时（ms），默认 10 秒 */
  registerTimeoutMs?: number;
}

export class RelayAgentClient {
  private ws: WebSocket | null = null;
  private clientSeq = 0;
  /** 已发出但未 ACK 的事件缓冲，重连后补发 */
  private pendingAcks = new Map<number, AgentEventEnvelope>();
  /** 已注册成功 */
  private registered = false;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private registerTimer: NodeJS.Timeout | null = null;

  constructor(private opts: RelayAgentClientOptions) {}

  /** 启动客户端，开始连接 relay */
  connect(): void {
    if (this.closed) return;
    this.opts.onStatusChange?.("connecting");
    this.doConnect();
  }

  private doConnect() {
    if (this.closed) return;
    console.log(`[relay-client] 连接 ${this.opts.relayUrl} ...`);
    const ws = new WebSocket(this.opts.relayUrl);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[relay-client] 连接已建立，发送注册`);
      this.sendRegister();
      // 注册超时检测
      this.registerTimer = setTimeout(() => {
        if (!this.registered) {
          console.warn(`[relay-client] 注册超时，关闭重连`);
          ws.close(4004, "register-timeout");
        }
      }, this.opts.registerTimeoutMs ?? 10000);
    });

    ws.on("message", (raw) => {
      let msg: RelayServerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn(`[relay-client] 收到无效 JSON`);
        return;
      }
      this.handleServerMessage(msg);
    });

    ws.on("close", (code, reason) => {
      console.warn(`[relay-client] 连接关闭 code=${code} reason=${reason.toString()}`);
      this.handleDisconnect(`closed: ${code}`);
    });

    ws.on("error", (err) => {
      console.error(`[relay-client] 连接错误:`, err.message);
      this.opts.onStatusChange?.("error", err.message);
      // error 后通常会 close，不在这里触发重连
    });
  }

  private sendRegister() {
    const agentId = this.opts.agentId ?? this.defaultAgentId();
    const msg: AgentRegister = {
      kind: "agent_register",
      agentId,
      token: this.opts.token,
      info: this.opts.agentInfo,
    };
    this.ws?.send(JSON.stringify(msg));
  }

  private handleServerMessage(msg: RelayServerMessage) {
    switch (msg.kind) {
      case "agent_register_result":
        if (msg.ok) {
          this.registered = true;
          if (this.registerTimer) {
            clearTimeout(this.registerTimer);
            this.registerTimer = null;
          }
          console.log(`[relay-client] 注册成功`);
          this.opts.onStatusChange?.("online");
          // 补发未 ACK 的事件
          this.resendPending();
        } else {
          console.error(`[relay-client] 注册失败: ${msg.error}`);
          this.opts.onStatusChange?.("error", `register failed: ${msg.error}`);
          this.ws?.close(4003, "register-failed");
        }
        break;

      case "agent_event_ack":
        this.pendingAcks.delete(msg.clientSeq);
        break;

      case "history_batch":
        // agent client 一般不处理 history_batch（手机端才需要）
        // 但保留接口，未来可能用
        break;

      case "agent_status":
        // 其他 agent 的状态变化，agent client 一般不关心
        break;
    }

    // 如果是 relay 转发过来的手机请求帧（type: "req"），透传给上层
    // 注意：RelayServerMessage 联合类型里没有 req 帧，但实际会收到
    const maybeReq = msg as unknown as { type?: string; method?: string };
    if (maybeReq.type === "req" && maybeReq.method) {
      this.opts.onMobileRequest?.(msg);
    }
  }

  private handleDisconnect(reason: string) {
    this.registered = false;
    this.ws = null;
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    this.opts.onStatusChange?.("offline", reason);
    if (this.closed) return;
    // 重连
    const interval = this.opts.reconnectIntervalMs ?? 5000;
    console.log(`[relay-client] ${interval}ms 后重连...`);
    this.reconnectTimer = setTimeout(() => this.doConnect(), interval);
  }

  /** 推事件给 relay，relay 持久化后回 ACK */
  pushEvent(eventType: string, eventData: unknown): void {
    if (this.closed) return;
    this.clientSeq++;
    const env: AgentEventEnvelope = {
      kind: "agent_event",
      agentId: this.opts.agentId ?? this.defaultAgentId(),
      eventType,
      eventData,
      clientSeq: this.clientSeq,
    };
    this.pendingAcks.set(this.clientSeq, env);
    this.sendEnvelope(env);
  }

  /**
   * 推手机请求的响应给 relay（不持久化，只转发给在线手机）
   * 用于手机通过 relay 发 req 后，Gateway 处理完把 res 推回 relay 转发给手机。
   */
  pushResponse(resFrame: unknown): void {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN && this.registered) {
      this.ws.send(JSON.stringify({ kind: "mobile_response", response: resFrame }));
    }
    // 未连接/未注册时丢弃（res 是一次性的，不重传）
  }

  private sendEnvelope(env: AgentEventEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN && this.registered) {
      this.ws.send(JSON.stringify(env));
    }
    // 未连接/未注册时事件留在 pendingAcks，等重连后补发
  }

  /** 重连成功后补发未 ACK 的事件 */
  private resendPending() {
    if (this.pendingAcks.size === 0) return;
    console.log(`[relay-client] 补发 ${this.pendingAcks.size} 条未 ACK 事件`);
    for (const env of this.pendingAcks.values()) {
      this.sendEnvelope(env);
    }
  }

  /** 是否已连上 relay 并注册成功 */
  get isOnline(): boolean {
    return this.registered && this.ws?.readyState === WebSocket.OPEN;
  }

  /** 当前未 ACK 的事件数（用于监控） */
  get pendingCount(): number {
    return this.pendingAcks.size;
  }

  /** 关闭客户端，停止重连 */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "client-closed");
      this.ws = null;
    }
  }

  private defaultAgentId(): string {
    const host = hostname();
    const suffix = randomBytes(3).toString("hex");
    return `${host}-${suffix}`;
  }
}
