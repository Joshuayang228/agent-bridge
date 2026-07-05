/**
 * 端到端测试：模拟手机端扫码配对 + 发消息续接 CC session
 *
 * 用法：node e2e-test.mjs
 * 流程：
 *   1. WS 连接 ws://localhost:18789/ws
 *   2. 发 connect {pairingCode} → 拿 device token
 *   3. 发 chat.send {agentId, message, sessionId}
 *   4. 收流式 event 帧打印
 */
import { WebSocket } from "ws";

const URL = "ws://localhost:18789/ws";
const PAIRING_CODE = process.argv[2] ?? "563927";

console.log(`[e2e] 连接 ${URL}，配对码 ${PAIRING_CODE}`);

const ws = new WebSocket(URL);
let seq = 0;
let deviceToken = null;
let chatSent = false;

ws.on("open", () => {
  console.log("[e2e] WS 已连接，发送 connect 配对帧");
  ws.send(JSON.stringify({
    type: "req",
    id: "req-1",
    method: "connect",
    params: { pairingCode: PAIRING_CODE },
  }));
});

ws.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  console.log(`[e2e] <-`, JSON.stringify(frame).slice(0, 300));

  // 第一帧：connect 响应
  if (frame.type === "res" && frame.id === "req-1") {
    if (frame.ok) {
      deviceToken = frame.payload.deviceToken;
      console.log(`[e2e] 配对成功，device token: ${deviceToken?.slice(0, 12)}...`);

      // 发 chat.send
      console.log("[e2e] 发送 chat.send");
      ws.send(JSON.stringify({
        type: "req",
        id: "req-2",
        method: "chat.send",
        params: {
          agentId: "claude-code",
          message: "我们刚才聊到哪了？",
          sessionId: "e2e-test-session",
        },
      }));
      chatSent = true;
    } else {
      console.error("[e2e] 配对失败:", frame.error);
      process.exit(1);
    }
    return;
  }

  // chat.send ack
  if (frame.type === "res" && frame.id === "req-2") {
    console.log(`[e2e] chat.send ack:`, frame.payload);
    return;
  }

  // agent 事件
  if (frame.type === "event" && frame.event === "agent") {
    const evt = frame.payload;
    if (evt.type === "delta") {
      process.stdout.write(evt.text);
    } else if (evt.type === "tool_start") {
      console.log(`\n[e2e] 🔧 tool_start: ${evt.tool}`);
    } else if (evt.type === "tool_end") {
      console.log(`\n[e2e] ✅ tool_end: ${evt.tool} → ${evt.result?.slice(0, 80)}`);
    } else if (evt.type === "done") {
      console.log(`\n[e2e] ✅ done: ${evt.text?.slice(0, 200)}`);
      ws.close();
      process.exit(0);
    } else if (evt.type === "error") {
      console.error(`\n[e2e] ❌ error: ${evt.message}`);
      ws.close();
      process.exit(1);
    } else if (evt.type === "approval_required") {
      console.log(`\n[e2e] ⚠️ approval_required: ${evt.action}`);
      // 自动批准
      ws.send(JSON.stringify({
        type: "req",
        id: `req-approve-${++seq}`,
        method: "chat.approve",
        params: {},
      }));
    }
  }

  // 外部 CC 同步事件（手机端主动调 provider 时会被 suspend，应该收不到）
  if (frame.type === "event" && frame.event === "external_session_event") {
    console.log(`[e2e] 📡 external_session_event (应该被 suspend 抑制):`, JSON.stringify(frame.payload).slice(0, 100));
  }
});

ws.on("error", (err) => {
  console.error("[e2e] WS error:", err.message);
  process.exit(1);
});

// 30 秒超时
setTimeout(() => {
  console.error("\n[e2e] 30 秒超时，未收到 done");
  process.exit(2);
}, 30000);
