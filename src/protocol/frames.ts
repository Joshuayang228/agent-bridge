/**
 * WebSocket JSON-RPC 协议帧定义
 * 参考 OpenClaw 的三帧模型：req / res / event
 */

// ─── 请求帧（手机端 → Gateway）───
export interface ReqFrame {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

// ─── 响应帧（Gateway → 手机端）───
export interface ResOkFrame {
  type: "res";
  id: string;
  ok: true;
  payload?: unknown;
}

export interface ResErrorFrame {
  type: "res";
  id: string;
  ok: false;
  error: { code: string; message: string };
}

export type ResFrame = ResOkFrame | ResErrorFrame;

// ─── 事件帧（Gateway → 手机端，流式推送）───
export interface EventFrame {
  type: "event";
  event: string;
  seq: number;
  payload: unknown;
}

export type Frame = ReqFrame | ResFrame | EventFrame;

// ─── 握手帧 ───
export interface ConnectParams {
  protocol: number;
  /** 已配对设备携带的 device token */
  token?: string;
  /** 首次配对时携带的 6 位配对码 */
  pairingCode?: string;
  client?: string;
}

export interface HelloOkPayload {
  protocol: number;
  server: string;
  agents: AgentInfo[];
  /** 首次配对成功时返回的 device token，后续连接用它认证 */
  deviceToken?: string;
}

// ─── Agent 元信息 ───
export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
}

// ─── 协议常量 ───
export const PROTOCOL_VERSION = 1;
export const SERVER_NAME = "agent-bridge";
