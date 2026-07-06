/**
 * ConnectionManager —— 管理所有已认证的 WebSocket 连接 + relay 上行
 *
 * 用于 agent 主动推送（CronScheduler 定时触发 agent，广播通知到所有手机端）。
 * 如果配置了 relay client，所有事件会同步推到云端 relay（持久化 + 转发给远程手机）。
 */

import type { WebSocket } from "ws";
import type { EventFrame } from "../protocol/frames.js";
import type { RelayAgentClient } from "../relay/agent-client.js";

export class ConnectionManager {
  private connections = new Set<WebSocket>();
  private seq = 0;
  private relayClient: RelayAgentClient | null = null;

  add(ws: WebSocket) {
    this.connections.add(ws);
    ws.on("close", () => this.connections.delete(ws));
  }

  /** 注入 relay client（家里 Gateway 启动时连云端 relay） */
  setRelayClient(client: RelayAgentClient | null) {
    this.relayClient = client;
  }

  /** 广播事件到所有已连接客户端（直连手机）+ 推到 relay */
  broadcast(event: string, payload: unknown) {
    const frame: EventFrame = {
      type: "event",
      event,
      payload,
      seq: ++this.seq,
    };
    const data = JSON.stringify(frame);
    for (const ws of this.connections) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
    // 同步推到 relay（远程手机 + 持久化）
    this.emitToRelay(event, payload);
  }

  /**
   * 单播事件给当前 ws（发起请求的手机）+ 推到 relay
   * 用于 chat.send 的流式回复——其他直连手机不会收到，但 relay 会持久化
   * 并转发给所有通过 relay 连接的手机。
   */
  deliver(ws: WebSocket, frame: EventFrame) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
    this.emitToRelay(frame.event, frame.payload);
  }

  /** 只推到 relay（不影响直连手机） */
  emitToRelay(eventType: string, eventData: unknown) {
    this.relayClient?.pushEvent(eventType, eventData);
  }

  get count() {
    return this.connections.size;
  }

  get relayOnline(): boolean {
    return this.relayClient?.isOnline ?? false;
  }
}
