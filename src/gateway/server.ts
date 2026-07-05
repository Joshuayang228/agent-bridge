/**
 * HTTP + WebSocket 单服务器
 * 单端口复用：WebSocket 控制面 + 静态文件托管（Web App）
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { WebSocketServer } from "ws";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AuthManager } from "./auth.js";
import type { SessionManager } from "./session-manager.js";
import type { ConnectionManager } from "./connection-manager.js";
import { createWsHandler } from "./ws-handler.js";
import { handleOpenAIHttp } from "./openai-http.js";
import { SessionWatcher } from "./session-watcher.js";
import { CCAdapter } from "./adapters/cc-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "..", "web");

const DEFAULT_PORT = 18789;

// 获取局域网 IPv4 地址
function getLocalIPs(): string[] {
  const nets = networkInterfaces();
  const tailscale: string[] = []; // 100.64.0.0/10 —— Tailscale/CGNAT 网段，外网可用，优先
  const lan: string[] = [];
  for (const interfaces of Object.values(nets)) {
    if (!interfaces) continue;
    for (const net of interfaces) {
      if (net.family !== "IPv4" || net.internal) continue;
      // 排除 APIPA link-local（169.254.x.x）—— 没有 DHCP 时网卡自分配的，手机访问不了
      if (net.address.startsWith("169.254.")) continue;
      // Tailscale 的 100.64.0.0/10 段：第二段 64~127
      const second = Number(net.address.split(".")[1]);
      if (second >= 64 && second <= 127) {
        tailscale.push(net.address);
      } else {
        lan.push(net.address);
      }
    }
  }
  // Tailscale 优先（外网可用），LAN 次之（同 WiFi 才能用）
  return [...tailscale, ...lan];
}

export function startServer(
  registry: ProviderRegistry,
  auth: AuthManager,
  sessions: SessionManager,
  connections: ConnectionManager,
  port = DEFAULT_PORT,
) {
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);

    // OpenAI 兼容 API 路由
    if (url.pathname.startsWith("/v1/")) {
      const handled = await handleOpenAIHttp(req, res, url, registry, auth);
      if (handled) return;
    }

    // /pair 路由：返回注入配对码 + URL 的 HTML，用于主机端展示二维码给手机扫
    if (url.pathname === "/pair") {
      const localIPs = getLocalIPs();
      const primaryIP = localIPs[0] ?? "localhost";
      const pairUrl = `http://${primaryIP}:${port}/?code=${auth.pairingCodeDisplay}`;
      try {
        const html = await readFile(join(WEB_DIR, "pair.html"), "utf-8");
        const injected = html.replace(
          "</head>",
          `  <script>window.__PAIR__ = ${JSON.stringify({ code: auth.pairingCodeDisplay, url: pairUrl, ips: localIPs })};</script>\n  </head>`,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(injected);
      } catch {
        res.writeHead(500);
        res.end("pair.html not found");
      }
      return;
    }

    let filePath = url.pathname;

    if (filePath === "/") filePath = "/index.html";

    const fullPath = join(WEB_DIR, filePath);

    // 防止路径穿越
    if (!fullPath.startsWith(WEB_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const content = await readFile(fullPath);
      res.writeHead(200, { "Content-Type": getContentType(filePath) });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  // 启动外部 session 监听 —— 同时监听 CC 和 Codex 两个 session 源
  // 用户在终端/IDE 跑外部 agent 时，实时把输出同步到所有已配对手机
  const sessionWatcher = new SessionWatcher(connections, [new CCAdapter(), new CodexAdapter()]);
  sessionWatcher.start();

  wss.on("connection", createWsHandler(registry, auth, sessions, connections, sessionWatcher));

  // 绑定 0.0.0.0 让局域网/远程可访问
  httpServer.listen(port, "0.0.0.0", () => {
    const localIPs = getLocalIPs();

    console.log(`\n┌──────────────────────────────────────────────────────┐`);
    console.log(`│  Agent Bridge 已启动                                   │`);
    console.log(`│  配对码:    ${auth.pairingCodeDisplay}                             │`);
    console.log(`│  扫码页:    http://localhost:${port}/pair                    │`);
    if (localIPs.length > 0) {
      for (const ip of localIPs) {
        console.log(`│  局域网:    http://${ip}:${port}/pair          │`);
      }
    }
    console.log(`│  Agents:    ${registry.list().length} 个已加载                             │`);
    console.log(`│  外部同步:  CC + Codex session 监听中                  │`);
    console.log(`│  远程访问:  Tailscale 或局域网直连                     │`);
    console.log(`└──────────────────────────────────────────────────────┘\n`);
    console.log(`提示：在电脑浏览器打开 http://localhost:${port}/pair 看到二维码，用手机扫码即可配对。\n`);
  });

  return httpServer;
}

function getContentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
