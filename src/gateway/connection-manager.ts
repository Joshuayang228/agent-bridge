/**
 * ConnectionManager —— 管理所有已认证的 WebSocket 连接
 *
 * 用于 agent 主动推送（CronScheduler 定时触发 agent，广播通知到所有手机端）。
 */

import type { WebSocket } from "ws";
import type { EventFrame } from "../protocol/frames.js";

export class ConnectionManager {
  private connections = new Set<WebSocket>();
  private seq = 0;

  add(ws: WebSocket) {
    this.connections.add(ws);
    ws.on("close", () => this.connections.delete(ws));
  }

  /** 广播事件到所有已连接客户端 */
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
  }

  get count() {
    return this.connections.size;
  }
}
