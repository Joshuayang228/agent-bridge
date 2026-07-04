/**
 * Agent Bridge 入口
 * 加载 agent 配置 → 启动 Gateway 服务器
 */

import { ProviderRegistry } from "./providers/registry.js";
import { AuthManager } from "./gateway/auth.js";
import { SessionManager } from "./gateway/session-manager.js";
import { ConnectionManager } from "./gateway/connection-manager.js";
import { CronScheduler, type ScheduleConfig } from "./gateway/cron-scheduler.js";
import { startServer } from "./gateway/server.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "agents.config.json");

async function main() {
  const registry = new ProviderRegistry();

  // 从配置文件加载所有 agent
  let schedules: ScheduleConfig[] = [];
  if (existsSync(CONFIG_PATH)) {
    await registry.loadConfig(CONFIG_PATH);

    // 读取定时触发配置
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    for (const agent of raw.agents ?? []) {
      if (agent.schedule) {
        schedules.push({
          agentId: agent.id,
          intervalMs: agent.schedule.intervalMs ?? 60000,
          prompt: agent.schedule.prompt,
        });
      }
    }
  } else {
    console.warn("[main] 未找到 agents.config.json，无 agent 加载");
  }

  // 初始化认证 + 会话管理 + 连接管理
  const auth = new AuthManager();
  const sessions = new SessionManager();
  const connections = new ConnectionManager();

  // 启动定时触发
  if (schedules.length > 0) {
    const cron = new CronScheduler(registry, connections);
    cron.start(schedules);
  }

  const port = Number(process.env.PORT) || 18789;
  startServer(registry, auth, sessions, connections, port);
}

main().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
