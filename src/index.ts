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
import { SessionWatcher } from "./gateway/session-watcher.js";
import { CCAdapter } from "./gateway/adapters/cc-adapter.js";
import { CodexAdapter } from "./gateway/adapters/codex-adapter.js";
import { CronScheduler, type ScheduleConfig } from "./gateway/cron-scheduler.js";
import { startServer } from "./gateway/server.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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
  // 启动外部 session 监听 —— 同时监听 CC 和 Codex 两个 session 源
  // 用户在终端/IDE 跑外部 agent 时，实时把输出同步到所有已配对手机
  const sessionWatcher = new SessionWatcher(connections, [new CCAdapter(), new CodexAdapter()]);
  sessionWatcher.start();
  startServer(registry, auth, sessions, connections, port, sessionWatcher);

  // 如果配置了 RELAY_URL，启动 relay client（家里 Gateway 连云端）
  const relayUrl = process.env.RELAY_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (relayUrl && agentToken) {
    const agents = registry.list();
    const primaryAgent = agents[0];
    if (!primaryAgent) {
      console.warn("[main] registry 无 agent，跳过 relay client 启动");
    } else {
      // 用 registry 里的 agent id 注册到 relay（不是 AGENT_ID hostname），
      // 这样手机端看到的 agent id 和 registry 一致，chat.send 能直接命中
      const relayAgentId = process.env.AGENT_ID ?? primaryAgent.id;
      const relayClient = new RelayAgentClient({
        relayUrl,
        token: agentToken,
        agentId: relayAgentId,
        agentInfo: {
          name: primaryAgent.name,
          type: primaryAgent.type,
          capabilities: primaryAgent.capabilities,
        },
        onStatusChange: (status, detail) => {
          console.log(`[relay] 状态: ${status}${detail ? ` (${detail})` : ""}`);
        },
        onMobileRequest: (reqFrame) => {
          handleMobileRequest(reqFrame, connections, relayClient, registry, sessions, sessionWatcher);
        },
      });
      connections.setRelayClient(relayClient);
      relayClient.connect();
      console.log(`[main] relay client 已启动，连接 ${relayUrl} (agentId: ${relayAgentId})`);
    }
  } else {
    console.log("[main] 未配置 RELAY_URL/AGENT_TOKEN，仅 LAN/Tailscale 模式");
  }
}

/**
 * 处理通过 relay 转发过来的手机请求
 * 支持全部 ws 方法：sessions.list/create/delete、chat.history、chat.send、chat.approve/reject/abort、agents.list
 * res 帧通过 pushResponse（不持久化），流式 agent 事件通过 pushEvent（持久化 + 转发在线手机）。
 */
async function handleMobileRequest(
  reqFrame: unknown,
  connections: ConnectionManager,
  relayClient: RelayAgentClient,
  registry: ProviderRegistry,
  sessions: SessionManager,
  sessionWatcher: SessionWatcher,
): Promise<void> {
  const frame = reqFrame as { type?: string; id?: string; method?: string; params?: unknown };
  if (frame?.type !== "req" || !frame.id || !frame.method) {
    console.log(`[relay-up] 收到非 req 消息: ${JSON.stringify(reqFrame).slice(0, 200)}`);
    return;
  }
  console.log(`[relay-up] 收到手机请求: ${frame.method} (id=${frame.id})`);

  const res = (ok: boolean, payload: unknown) => {
    relayClient.pushResponse(
      ok
        ? { type: "res", id: frame.id, ok: true, payload }
        : { type: "res", id: frame.id, ok: false, error: payload },
    );
  };

  switch (frame.method) {
    case "agents.list":
      res(true, { agents: registry.list() });
      return;

    case "sessions.list": {
      const phoneSessions = sessions.list();
      // 附带当前外部 CC session 的最近消息，让手机端能看到 CC 最近在干什么
      const ccSessionId = sessionWatcher.getCurrentSessionId("claude-code");
      const ccCwd = sessionWatcher.getCurrentCwd("claude-code");
      const recentMessages = ccSessionId ? sessionWatcher.getRecentMessages("claude-code", 10) : [];
      const externalSession = ccSessionId ? [{
        id: `external-${ccSessionId}`,
        agentId: "claude-code",
        title: `CC 当前会话${ccCwd ? ` (${ccCwd.split(/[\\/]/).pop()})` : ""}`,
        messageCount: recentMessages.length,
        createdAt: 0,
        updatedAt: Date.now(),
        ccSessionId: ccSessionId,
        isExternal: true,
        recentMessages,
      }] : [];
      res(true, { sessions: [...externalSession, ...phoneSessions] });
      return;
    }

    case "sessions.create": {
      const params = (frame.params ?? {}) as { agentId: string; title?: string };
      const session = sessions.create(params.agentId, params.title);
      res(true, { session });
      return;
    }

    case "sessions.delete": {
      const params = (frame.params ?? {}) as { sessionId: string };
      const ok = sessions.delete(params.sessionId);
      res(true, { status: ok ? "deleted" : "not-found" });
      return;
    }

    case "chat.history": {
      const params = (frame.params ?? {}) as { sessionId: string };
      res(true, { messages: sessions.history(params.sessionId) });
      return;
    }

    case "chat.approve": {
      const approved = connections.resolveApproval(true);
      res(true, { status: approved ? "approved" : "no-pending" });
      return;
    }

    case "chat.reject": {
      const rejected = connections.resolveApproval(false);
      res(true, { status: rejected ? "rejected" : "no-pending" });
      return;
    }

    case "chat.abort": {
      const aborted = connections.abortRunning();
      res(true, { status: aborted ? "aborted" : "idle" });
      return;
    }

    case "chat.send":
      await handleChatSendViaRelay(frame as { id: string; params?: unknown }, connections, relayClient, registry, sessions, sessionWatcher);
      return;

    default:
      res(false, { code: "unsupported-via-relay", message: `方法 ${frame.method} 暂不支持通过 relay 上行` });
  }
}

/**
 * chat.send 通过 relay 上行：立即 ack → 流式 pushEvent → 审批回调
 * 手机发 chat.send → relay 转发 → Gateway 处理 → res(pushResponse) + 事件(pushEvent 持久化)
 */
async function handleChatSendViaRelay(
  frame: { id: string; params?: unknown },
  connections: ConnectionManager,
  relayClient: RelayAgentClient,
  registry: ProviderRegistry,
  sessions: SessionManager,
  sessionWatcher: SessionWatcher,
): Promise<void> {
  const params = (frame.params ?? {}) as { agentId: string; message: string; sessionId: string };
  console.log(`[relay-up] chat.send: agent=${params.agentId} session=${params.sessionId} msg="${params.message.slice(0, 50)}"`);

  // 处理外部 CC session：手机选了 "CC 当前会话" 时，sessionId 是 external-{ccSessionId}
  // 创建一个真实的 SessionManager 会话，设置 ccSessionId，加载最近消息
  let sessionId = params.sessionId;
  if (params.sessionId.startsWith("external-")) {
    const externalCcId = params.sessionId.slice("external-".length);
    const newSession = sessions.create(params.agentId, "CC 续接会话");
    sessions.setCcSessionId(newSession.id, externalCcId);
    // 加载最近消息到会话历史
    const recent = sessionWatcher.getRecentMessages("claude-code", 10);
    for (const msg of recent) {
      if (msg.role === "user") sessions.addUserMessage(newSession.id, msg.text);
      else sessions.addAssistantMessage(newSession.id, msg.text);
    }
    sessionId = newSession.id;
    console.log(`[relay-up] 外部 session 转换: ${params.sessionId} → ${sessionId} (ccSessionId=${externalCcId}, ${recent.length} 条历史)`);
    // 通知手机端 session 已创建
    relayClient.pushResponse({
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "accepted", sessionId: sessionId, redirected: true },
    });
  }

  const provider = registry.get(params.agentId);
  if (!provider) {
    console.warn(`[relay-up] agent 未找到: ${params.agentId}`);
    relayClient.pushResponse({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: "agent-not-found", message: `找不到 agent: ${params.agentId}` },
    });
    return;
  }

  // 存用户消息
  sessions.addUserMessage(sessionId, params.message);

  // 阶段 1：立即 ack（外部 session 转换时已在上面发过 ack，跳过）
  if (!params.sessionId.startsWith("external-")) {
    console.log(`[relay-up] chat.send ack → pushResponse`);
    relayClient.pushResponse({ type: "res", id: frame.id, ok: true, payload: { status: "accepted" } });
  }

  // 阶段 2：流式运行 agent
  const controller = new AbortController();
  connections.setRunningController(controller);

  let fullResponse = "";

  // session 续接逻辑：
  // - 手机会话已有 ccSessionId → 续接该 CC session
  // - 手机会话没有 ccSessionId（新建会话）→ 不带 --resume，CC 开新 session
  // - 外部 CC session（SessionWatcher 检测到的）→ 仅用于 cwd，不自动续接
  const adapterId = provider.info.type;
  const sessionCcId = sessions.getCcSessionId(sessionId);
  const resumeSessionId = sessionCcId; // 手机会话关联的 CC session ID
  const cwd = sessionWatcher.getCurrentCwd(adapterId) ?? undefined;
  console.log(`[relay-up] session: phone=${sessionId} ccSessionId=${sessionCcId ?? "无(新建)"} cwd=${cwd ?? "无"}`);

  // 暂停 session watcher：provider 写入 session 文件时 watcher 会监听到，
  // 但这些内容 provider 已经通过 stdout 直接推给手机了，不重复推。
  sessionWatcher.suspend(adapterId);

  try {
    const events = provider.send({
      sessionId,
      agentId: params.agentId,
      message: params.message,
      resumeSessionId,
      cwd,
      requestApproval: (action, description) => {
        return new Promise<boolean>((resolve) => {
          console.log(`[relay-up] 审批请求: ${action} — ${description}`);
          relayClient.pushEvent("agent", { type: "approval_required", action, description });
          connections.setPendingApproval(resolve);
        });
      },
    });

    let eventCount = 0;
    for await (const evt of events) {
      if (controller.signal.aborted) break;
      if (evt.type === "delta") fullResponse += evt.text;
      if (evt.type === "done") {
        if (evt.text) fullResponse = evt.text;
        // 捕获 CC 返回的 session_id，存到手机会话里（后续消息续接用）
        if (evt.sessionId) {
          console.log(`[relay-up] 捕获 CC session_id: ${evt.sessionId}`);
          sessions.setCcSessionId(sessionId, evt.sessionId);
        }
      }
      relayClient.pushEvent("agent", evt);
      eventCount++;
    }
    console.log(`[relay-up] chat.send 完成: ${eventCount} 个事件, 回复 ${fullResponse.length} 字`);

    // 存 assistant 回复
    if (fullResponse) {
      sessions.addAssistantMessage(sessionId, fullResponse);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    relayClient.pushEvent("agent", { type: "error", message });
  } finally {
    sessionWatcher.resume(adapterId);
    connections.setRunningController(null);
    connections.setPendingApproval(null);
  }
}

main().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
