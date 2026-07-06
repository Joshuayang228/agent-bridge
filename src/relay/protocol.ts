/**
 * Relay 内部协议 —— 家里 Gateway 与云端 relay 之间的通信帧
 *
 * 设计原则：
 * - 复用现有 EventFrame 的事件结构，封装一层 agent_event 信封
 * - Gateway → relay：agent_event（带 clientSeq，等 ACK）
 * - relay → Gateway：agent_event_ack（带 serverSeq，确认持久化成功）
 * - 手机端协议不变，relay 透传事件帧给手机
 */

// ─── Gateway → relay（agent client 方向）───

/** 家里 Gateway 推事件给 relay */
export interface AgentEventEnvelope {
  kind: "agent_event";
  agentId: string;
  /** 事件类型（对应 EventFrame.event，比如 "agent" / "external_session_event"） */
  eventType: string;
  /** 事件 payload（对应 EventFrame.payload） */
  eventData: unknown;
  /** Gateway 本地递增序列号，用于 ACK 对账 */
  clientSeq: number;
}

/** 家里 Gateway 注册自己（连接建立后第一帧） */
export interface AgentRegister {
  kind: "agent_register";
  agentId: string;
  /** 鉴权 token（环境变量 AGENT_TOKEN） */
  token: string;
  /** agent 元信息 */
  info: {
    name: string;
    type: string;
    capabilities: string[];
  };
}

/** 手机端 → relay：拉历史 */
export interface HistorySinceRequest {
  kind: "history_since";
  /** 上次收到的最大 seq，拉大于此值的事件 */
  since: number;
  /** 单次拉取上限，默认 200 */
  limit?: number;
  /** 可选：只拉某个 agent */
  agentId?: string;
}

// ─── relay → Gateway / 手机端方向 ───

/** relay 确认事件已持久化 */
export interface AgentEventAck {
  kind: "agent_event_ack";
  /** 对应 AgentEventEnvelope.clientSeq */
  clientSeq: number;
  /** relay 分配的全局 seq（用于手机端 since 拉历史） */
  serverSeq: number;
}

/** relay → 手机端：历史批量返回 */
export interface HistoryBatch {
  kind: "history_batch";
  events: StoredTimelineEvent[];
  /** 是否还有更多历史可拉 */
  hasMore: boolean;
  /** 下次拉取的 since 起始值 */
  nextSeq: number;
}

/** relay → 手机端：agent 上下线状态 */
export interface AgentStatusNotice {
  kind: "agent_status";
  agentId: string;
  status: "online" | "offline";
  lastSeen: number;
}

/** relay → Gateway：注册结果 */
export interface AgentRegisterResult {
  kind: "agent_register_result";
  ok: boolean;
  error?: string;
}

// ─── 持久化的事件结构（对应 SQLite 一行）───

export interface StoredTimelineEvent {
  /** 全局递增 seq（relay 分配） */
  seq: number;
  agentId: string;
  eventType: string;
  eventData: unknown;
  /** 时间戳（ms） */
  createdAt: number;
}

// ─── 联合类型 ───

export type RelayClientMessage =
  | AgentRegister
  | AgentEventEnvelope
  | HistorySinceRequest;

export type RelayServerMessage =
  | AgentRegisterResult
  | AgentEventAck
  | HistoryBatch
  | AgentStatusNotice;

// ─── 鉴权与配置常量 ───

/** relay 监听端口（默认 18790，gateway 是 18789） */
export const DEFAULT_RELAY_PORT = 18790;

/** 默认历史拉取批量大小 */
export const DEFAULT_HISTORY_LIMIT = 200;

/** timeline 保留天数（定时清理） */
export const DEFAULT_RETENTION_DAYS = 7;
