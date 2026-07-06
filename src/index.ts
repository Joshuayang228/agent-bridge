/**
 * Agent Bridge 入口
 * 加载 agent 配置 → 启动 Gateway 服务器
 *
 * 环境变量（可选，可写在 .env 文件里自动加载）：
 *   RELAY_URL         —— 云端 relay 的 WS URL，如 ws://relay.example.com:18790/agent
 *   AGENT_TOKEN       —— 连 relay 的鉴权 token（需与 relay 端 RELAY_TOKEN 一致）
 *   AGENT_ID          —— Gateway 标识，默认 hostname-随机
 *   RELAY_MODE        —— =relay 时启动云端 relay 服务（也可用 --relay 参数）
 *   RELAY_TOKEN       —— relay 模式下的鉴权 token
 *   RELAY_PORT        —— relay 监听端口，默认 18790
 *   RELAY_PUBLIC_URL  —— relay 公网 URL（用于生成扫码配对 URL，如 https://relay.example.com）
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
import { hostname } from "node:os";
import { RelayAgentClient } from "./relay/agent-client.js";
import { startRelayServer } from "./relay/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "agents.config.json");
const ENV_PATH = join(__dirname, "..", ".env");

/** 简易 .env 加载器：KEY=VALUE 行写入 process.env，跳过注释和空行 */
function loadEnvFile(): void {
  if (!existsSync(ENV_PATH)) return;
  const content = readFileSync(ENV_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去掉首尾引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 不覆盖已存在的环境变量（命令行/系统设置优先）
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  console.log("[main] 已加载 .env 配置");
}

loadEnvFile();

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

  // 根据模式启动（支持命令行 --relay 或环境变量 RELAY_MODE=relay）
  const args = process.argv.slice(2);
  const isRelayMode = args.includes("--relay") || process.env.RELAY_MODE === "relay";
  if (isRelayMode) {
    // 云端 relay 模式
    const relayToken = process.env.RELAY_TOKEN;
    if (!relayToken) {
      console.error("[main] relay 模式需要 RELAY_TOKEN 环境变量");
      process.exit(1);
    }
    startRelayServer({
      relayToken,
      port: Number(process.env.RELAY_PORT) || undefined,
      auth,
    });
    return;
  }

  // Gateway 模式（默认）
  const port = Number(process.env.PORT) || 18789;
  startServer(registry, auth, sessions, connections, port);

  // 如果配置了 RELAY_URL，启动 relay client（家里 Gateway 连云端）
  const relayUrl = process.env.RELAY_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (relayUrl && agentToken) {
    const agents = registry.list();
    const primaryAgent = agents[0];
    const relayClient = new RelayAgentClient({
      relayUrl,
      token: agentToken,
      agentId: process.env.AGENT_ID,
      agentInfo: {
        name: primaryAgent?.name ?? hostname(),
        type: primaryAgent?.type ?? "gateway",
        capabilities: primaryAgent?.capabilities ?? [],
      },
      onStatusChange: (status, detail) => {
        console.log(`[relay] 状态: ${status}${detail ? ` (${detail})` : ""}`);
      },
      onMobileRequest: (reqFrame) => {
        handleMobileRequest(reqFrame, connections, relayClient);
      },
    });
    connections.setRelayClient(relayClient);
    relayClient.connect();
    console.log(`[main] relay client 已启动，连接 ${relayUrl}`);
  } else {
    console.log("[main] 未配置 RELAY_URL/AGENT_TOKEN，仅 LAN/Tailscale 模式");
  }
}

/**
 * 处理通过 relay 转发过来的手机请求（chat.approve / chat.reject / chat.abort）
 * 把 res 帧推回 relay，relay 转发给在线手机。
 * chat.send 等复杂请求暂不支持通过 relay 上行（需要 sessionWatcher 等，留待后续）。
 */
function handleMobileRequest(
  reqFrame: unknown,
  connections: ConnectionManager,
  relayClient: RelayAgentClient,
): void {
  const frame = reqFrame as { type?: string; id?: string; method?: string };
  if (frame?.type !== "req" || !frame.id || !frame.method) return;

  let resPayload: unknown = null;
  let ok = true;

  switch (frame.method) {
    case "chat.approve": {
      const approved = connections.resolveApproval(true);
      resPayload = { status: approved ? "approved" : "no-pending" };
      break;
    }
    case "chat.reject": {
      const rejected = connections.resolveApproval(false);
      resPayload = { status: rejected ? "rejected" : "no-pending" };
      break;
    }
    case "chat.abort": {
      const aborted = connections.abortRunning();
      resPayload = { status: aborted ? "aborted" : "idle" };
      break;
    }
    default:
      ok = false;
      resPayload = { code: "unsupported-via-relay", message: `方法 ${frame.method} 暂不支持通过 relay 上行` };
  }

  const resFrame = ok
    ? { type: "res", id: frame.id, ok: true, payload: resPayload }
    : { type: "res", id: frame.id, ok: false, error: resPayload };
  relayClient.pushResponse(resFrame);
}

main().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
