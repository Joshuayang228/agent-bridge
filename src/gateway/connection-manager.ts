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
  private relayClients = new Map<string, RelayAgentClient>();
  // 全局审批状态：手机断连重连后，新 ws 也能访问到未决审批
  // 由 chat.send 的 requestApproval 回调设置，chat.approve/reject 调用 resolve
  private pendingApproval: ((approved: boolean) => void) | null = null;
  // 全局运行控制：手机断连重连后能 abort 正在跑的 agent
  private runningController: AbortController | null = null;

  add(ws: WebSocket) {
    this.connections.add(ws);
    ws.on("close", () => this.connections.delete(ws));
  }

  /** 注入 relay client（家里 Gateway 启动时连云端 relay），按 agentId 管理多个 */
  addRelayClient(agentId: string, client: RelayAgentClient) {
    this.relayClients.set(agentId, client);
  }

  /** 按 agentId 获取 relay client */
  getRelayClient(agentId: string): RelayAgentClient | undefined {
    return this.relayClients.get(agentId);
  }

  /** 获取所有 relay client（用于广播场景） */
  getAllRelayClients(): RelayAgentClient[] {
    return [...this.relayClients.values()];
  }

  /** 设置当前未决审批的 resolver（agent 调 requestApproval 时设） */
  setPendingApproval(resolver: ((approved: boolean) => void) | null) {
    this.pendingApproval = resolver;
  }

  /** 解决审批：手机发 chat.approve/reject 时调用，返回是否成功 */
  resolveApproval(approved: boolean): boolean {
    if (!this.pendingApproval) return false;
    this.pendingApproval(approved);
    this.pendingApproval = null;
    return true;
  }

  get hasPendingApproval(): boolean {
    return this.pendingApproval !== null;
  }

  /** 是否有 agent 正在运行 */
  get isRunning(): boolean {
    return this.runningController !== null;
  }

  /** 设置当前运行的 AbortController（chat.send 开始时设，结束清空） */
  setRunningController(controller: AbortController | null) {
    this.runningController = controller;
  }

  /** 中止当前运行的 agent，返回是否成功 */
  abortRunning(): boolean {
    if (!this.runningController) return false;
    this.runningController.abort();
    this.runningController = null;
    return true;
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

  /** 只推到 relay（不影响直连手机）。默认推所有 agent 的 relay，可指定 agentId 只推对应 relay */
  emitToRelay(eventType: string, eventData: unknown, agentId?: string) {
    if (agentId) {
      this.relayClients.get(agentId)?.pushEvent(eventType, eventData);
    } else {
      for (const client of this.relayClients.values()) {
        client.pushEvent(eventType, eventData);
      }
    }
  }

  /** 推手机请求的响应到 relay（不持久化，只转发给在线手机）。指定 agentId 推对应 relay */
  emitResponseToRelay(resFrame: unknown, agentId?: string) {
    if (agentId) {
      this.relayClients.get(agentId)?.pushResponse(resFrame);
    } else {
      for (const client of this.relayClients.values()) {
        client.pushResponse(resFrame);
      }
    }
  }

  get count() {
    return this.connections.size;
  }

  get relayOnline(): boolean {
    return [...this.relayClients.values()].some((c) => c.isOnline);
  }
}
