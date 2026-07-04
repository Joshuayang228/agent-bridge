/**
 * AgentProvider 接口 —— 所有 agent 引擎的统一抽象
 * 每个 agent 后端实现这个接口，Gateway 通过它对话
 */

import type { AgentInfo } from "../protocol/frames.js";

// ─── 输入：用户发消息给 agent ───
export interface AgentInput {
  sessionId: string;
  agentId: string;
  message: string;
  /**
   * 审批回调：Provider 在执行危险操作前调用。
   * Gateway 会推送 approval_required 事件到手机端，
   * 等手机端批准/否决后 resolve(true/false)。
   */
  requestApproval?: (action: string, description: string) => Promise<boolean>;
}

// ─── 输出：流式事件（参考 OpenClaw 两阶段模型）───
export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string; result: string }
  | { type: "approval_required"; action: string; description: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

// ─── Provider 接口 ───
export interface AgentProvider {
  /** 引擎元信息 */
  readonly info: AgentInfo;

  /**
   * 发起对话，返回流式事件迭代器
   * Gateway 逐个读取事件，转成 WS event 帧推给手机端
   */
  send(input: AgentInput): AsyncIterable<AgentEvent>;
}

// ─── 配置文件中的 agent 条目 ───
export interface AgentConfig {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  /** 允许执行的工具白名单（不在列表的工具被拒绝） */
  allowedTools?: string[];
  /** 需要手机审批的危险工具（必须是 allowedTools 的子集） */
  dangerousTools?: string[];
  config?: Record<string, unknown>;
}
