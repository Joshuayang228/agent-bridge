/**
 * 端到端测试脚本 —— 模拟手机端连 relay，跑全流程
 *
 * 用法：npx tsx scripts/e2e-test.ts [pairingCode]
 *
 * 测试场景：
 *   1. connect 配对码认证 → 应返回 agents 列表 + deviceToken
 *   2. sessions.list → 应返回 "CC 当前会话 (xxx)" + 最近消息（Q3）
 *   3. 选 "CC 当前会话" → 发消息 → 应续接 CC session（Q3 续接）
 *   4. sessions.create + chat.send → 应开新 CC session（Q4 新建）
 *   5. 第二条消息 → 应续接上一轮新建的 CC session（Q4 续接）
 */

import WebSocket from "ws";

const RELAY_URL = "ws://1.12.224.119:18790/mobile";
const PAIRING_CODE = process.argv[2] ?? "200530";

let reqId = 0;
let ws: WebSocket;
let deviceToken: string | null = null;
const pendingResolvers = new Map<string, (payload: unknown) => void>();

function log(label: string, data: unknown): void {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  console.log(`[test] ${label}: ${text.length > 300 ? text.slice(0, 300) + "..." : text}`);
}

function sendReq(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = `test-${++reqId}`;
  return new Promise((resolve) => {
    pendingResolvers.set(id, resolve);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    log(`→ ${method}`, params);
  });
}

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(RELAY_URL);
    ws.on("open", () => resolve());
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      handleFrame(frame);
    });
    ws.on("close", (code, reason) => {
      log(`ws close`, { code, reason: reason.toString() });
    });
  });
}

function handleFrame(frame: unknown): void {
  const f = frame as { type?: string; id?: string; method?: string; ok?: boolean; payload?: unknown; error?: unknown; event?: string; seq?: number };
  // res 帧
  if (f.type === "res" && f.id) {
    const resolver = pendingResolvers.get(f.id);
    if (resolver) {
      pendingResolvers.delete(f.id);
      resolver(f.ok ? f.payload : { __error: f.error });
    }
    return;
  }
  // event 帧
  if (f.type === "event") {
    const event = f.event;
    const payload = f.payload;
    if (event === "agent_status") {
      log(`← event[agent_status]`, payload);
    } else if (event === "agent") {
      const p = payload as { type?: string; text?: string; tool?: string };
      if (p.type === "delta") {
        process.stdout.write(p.text ?? "");
      } else if (p.type === "tool_start") {
        console.log(`\n[test] ← event[agent] tool_start: ${p.tool}`);
      } else if (p.type === "tool_end") {
        console.log(`\n[test] ← event[agent] tool_end: ${p.tool}`);
      } else if (p.type === "done") {
        console.log(`\n[test] ← event[agent] done`);
      } else if (p.type === "approval_required") {
        console.log(`\n[test] ← event[agent] approval_required: ${p.tool ?? ""}`);
      } else if (p.type === "error") {
        console.log(`\n[test] ← event[agent] error: ${(payload as { message?: string }).message ?? ""}`);
      } else {
        log(`← event[agent]`, payload);
      }
    } else {
      log(`← event[${event}]`, payload);
    }
  }
}

async function waitForEvent(predicate: (frame: unknown) => boolean, timeoutMs = 60000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待事件超时")), timeoutMs);
    const handler = (raw: { toString: () => string }) => {
      const frame = JSON.parse(raw.toString());
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.off("message", handler as never);
        resolve(frame);
      }
    };
    ws.on("message", handler as never);
  });
}

async function main() {
  console.log(`\n========== 端到端测试开始 ==========`);
  console.log(`[test] relay URL: ${RELAY_URL}`);
  console.log(`[test] 配对码: ${PAIRING_CODE}`);

  // ─── 步骤 1: 连接 + 配对码认证 ───
  console.log(`\n--- 步骤 1: connect 配对码认证 ---`);
  await connect();
  log("ws open", RELAY_URL);

  const connectRes = await sendReq("connect", { protocol: 1, pairingCode: PAIRING_CODE }) as {
    agents?: Array<{ id: string; name: string }>;
    deviceToken?: string;
    latestSeq?: number;
  };
  log("← connect 响应", connectRes);

  if (!connectRes.deviceToken) {
    throw new Error(`配对失败，未返回 deviceToken: ${JSON.stringify(connectRes)}`);
  }
  deviceToken = connectRes.deviceToken;
  console.log(`[test] ✅ 配对成功，deviceToken=${deviceToken.slice(0, 8)}...`);
  console.log(`[test] agents: ${JSON.stringify(connectRes.agents)}`);

  // ─── 步骤 2: sessions.list（Q3：应返回 CC 当前会话 + 最近消息） ───
  console.log(`\n--- 步骤 2: sessions.list（Q3：CC 当前会话） ---`);
  const listRes = await sendReq("sessions.list") as { sessions?: Array<{ id: string; title: string; agentId: string; isExternal?: boolean; recentMessages?: unknown[]; ccSessionId?: string }> };
  log("← sessions.list 响应", listRes);

  if (!listRes.sessions) {
    throw new Error(`sessions.list 未返回 sessions`);
  }
  console.log(`[test] 会话数: ${listRes.sessions.length}`);
  for (const s of listRes.sessions) {
    console.log(`[test]   - id=${s.id} title="${s.title}" agent=${s.agentId} external=${s.isExternal ?? false} msgs=${s.recentMessages?.length ?? 0}`);
  }

  const externalSession = listRes.sessions.find((s) => s.isExternal);
  if (!externalSession) {
    console.log(`[test] ⚠️  未找到外部 CC session（Q3 未生效？）`);
  } else {
    console.log(`[test] ✅ Q3 外部 CC session 存在: ${externalSession.id} (ccSessionId=${externalSession.ccSessionId})`);
    console.log(`[test]   最近消息数: ${externalSession.recentMessages?.length ?? 0}`);
    if (externalSession.recentMessages?.length) {
      for (const m of externalSession.recentMessages.slice(-3)) {
        const msg = m as { role: string; text: string };
        console.log(`[test]     [${msg.role}] ${msg.text.slice(0, 80)}${msg.text.length > 80 ? "..." : ""}`);
      }
    }
  }

  // ─── 步骤 3: 选 "CC 当前会话" 发消息（Q3 续接） ───
  if (externalSession) {
    console.log(`\n--- 步骤 3: 选 CC 当前会话发消息（Q3 续接） ---`);
    const sendRes = await sendReq("chat.send", {
      agentId: "claude-code",
      sessionId: externalSession.id,
      message: "你好，这是端到端测试，简短回复一句话即可",
    }) as { status?: string; sessionId?: string };
    log("← chat.send ack", sendRes);

    console.log(`[test] 等待 agent 响应（最多 60s）...`);
    try {
      await waitForEvent(
        (f) => {
          const frame = f as { type?: string; event?: string; payload?: { type?: string } };
          return frame.type === "event" && frame.event === "agent" && frame.payload?.type === "done";
        },
        60000,
      );
      console.log(`[test] ✅ 收到 done 事件`);
    } catch (err) {
      console.log(`[test] ⚠️  ${(err as Error).message}`);
    }
  }

  // ─── 步骤 4: 新建会话 + 发消息（Q4 新建） ───
  console.log(`\n--- 步骤 4: 新建会话 + 发消息（Q4 新建） ---`);
  const createRes = await sendReq("sessions.create", { agentId: "claude-code", title: "E2E 测试新建" }) as { session?: { id: string } };
  log("← sessions.create 响应", createRes);

  if (!createRes.session?.id) {
    throw new Error(`sessions.create 未返回 session`);
  }
  const newSessionId = createRes.session.id;
  console.log(`[test] ✅ 新建会话: ${newSessionId}`);

  const sendRes2 = await sendReq("chat.send", {
    agentId: "claude-code",
    sessionId: newSessionId,
    message: "这是新建会话的第一条消息，简短回复即可",
  }) as { status?: string };
  log("← chat.send ack", sendRes2);

  console.log(`[test] 等待 agent 响应（最多 60s）...`);
  try {
    await waitForEvent(
      (f) => {
        const frame = f as { type?: string; event?: string; payload?: { type?: string } };
        return frame.type === "event" && frame.event === "agent" && frame.payload?.type === "done";
      },
      60000,
    );
    console.log(`[test] ✅ 收到 done 事件（新建会话首次对话）`);
  } catch (err) {
    console.log(`[test] ⚠️  ${(err as Error).message}`);
  }

  // ─── 步骤 5: 同会话发第二条消息（Q4 续接） ───
  console.log(`\n--- 步骤 5: 同会话发第二条消息（Q4 续接） ---`);
  const sendRes3 = await sendReq("chat.send", {
    agentId: "claude-code",
    sessionId: newSessionId,
    message: "我刚说了什么？简短回复",
  }) as { status?: string };
  log("← chat.send ack", sendRes3);

  console.log(`[test] 等待 agent 响应（最多 60s）...`);
  try {
    await waitForEvent(
      (f) => {
        const frame = f as { type?: string; event?: string; payload?: { type?: string } };
        return frame.type === "event" && frame.event === "agent" && frame.payload?.type === "done";
      },
      60000,
    );
    console.log(`[test] ✅ 收到 done 事件（续接会话）`);
  } catch (err) {
    console.log(`[test] ⚠️  ${(err as Error).message}`);
  }

  console.log(`\n========== 端到端测试结束 ==========`);
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[test] ❌ 测试失败:`, err);
  process.exit(1);
});
