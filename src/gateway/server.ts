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
import { createWsHandler } from "./ws-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "..", "web");

const DEFAULT_PORT = 18789;

// 获取局域网 IPv4 地址
function getLocalIPs(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const interfaces of Object.values(nets)) {
    if (!interfaces) continue;
    for (const net of interfaces) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

export function startServer(
  registry: ProviderRegistry,
  auth: AuthManager,
  port = DEFAULT_PORT,
) {
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);
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
  wss.on("connection", createWsHandler(registry, auth));

  // 绑定 0.0.0.0 让局域网/远程可访问
  httpServer.listen(port, "0.0.0.0", () => {
    const localIPs = getLocalIPs();
    console.log(`\n┌──────────────────────────────────────────────┐`);
    console.log(`│  Agent Bridge 已启动                           │`);
    console.log(`│  配对码:  ${auth.pairingCodeDisplay}                       │`);
    console.log(`│  本机:    http://localhost:${port}               │`);
    if (localIPs.length > 0) {
      for (const ip of localIPs) {
        console.log(`│  局域网:  http://${ip}:${port}          │`);
      }
    }
    console.log(`│  WebSocket: ws://<IP>:${port}/ws                │`);
    console.log(`│  Agents:  ${registry.list().length} 个已加载                       │`);
    if (!auth.hasEnvToken()) {
      console.log(`│  认证模式: 配对码（首次输入 ${auth.pairingCodeDisplay}）        │`);
    } else {
      console.log(`│  认证模式: 固定 token（GATEWAY_TOKEN）          │`);
    }
    console.log(`│  远程访问: Tailscale 或局域网直连              │`);
    console.log(`└──────────────────────────────────────────────┘\n`);
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
