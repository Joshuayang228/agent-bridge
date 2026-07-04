/**
 * CronScheduler —— 定时触发 agent，推送通知到手机
 *
 * 场景：agent 主动搭话（定时检查、定时提醒、主动汇报）。
 * 配置在 agents.config.json 的 schedule 字段。
 */

import type { ProviderRegistry } from "../providers/registry.js";
import type { ConnectionManager } from "./connection-manager.js";

export interface ScheduleConfig {
  agentId: string;
  /** 触发间隔（毫秒） */
  intervalMs: number;
  /** 触发时发给 agent 的 prompt */
  prompt?: string;
}

export class CronScheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private registry: ProviderRegistry,
    private connections: ConnectionManager,
  ) {}

  start(schedules: ScheduleConfig[]) {
    for (const s of schedules) {
      const timer = setInterval(() => {
        this.trigger(s).catch(() => {});
      }, s.intervalMs);
      this.timers.push(timer);
      console.log(`[cron] agent "${s.agentId}" 定时触发已启动 (每 ${s.intervalMs / 1000}s)`);
    }
  }

  private async trigger(s: ScheduleConfig) {
    const provider = this.registry.get(s.agentId);
    if (!provider) return;

    // 推送「正在思考」通知
    this.connections.broadcast("notification", {
      type: "thinking",
      agentId: s.agentId,
      agentName: provider.info.name,
    });

    try {
      const events = provider.send({
        sessionId: `cron-${Date.now()}`,
        agentId: s.agentId,
        message: s.prompt ?? "主动打个招呼，简短地说一句",
        requestApproval: async () => true,
      });

      let fullText = "";
      for await (const evt of events) {
        if (evt.type === "delta") fullText += evt.text;
        if (evt.type === "done" && evt.text) fullText = evt.text;
      }

      if (fullText) {
        // 推送 agent 回复到所有手机端
        this.connections.broadcast("notification", {
          type: "agent_message",
          agentId: s.agentId,
          agentName: provider.info.name,
          text: fullText,
        });
      }
    } catch (err) {
      console.error(`[cron] agent "${s.agentId}" 触发失败:`, err instanceof Error ? err.message : err);
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
