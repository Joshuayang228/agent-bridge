/**
 * Agent Bridge 入口
 * 加载 agent 配置 → 启动 Gateway 服务器
 */

import { ProviderRegistry } from "./providers/registry.js";
import { AuthManager } from "./gateway/auth.js";
import { startServer } from "./gateway/server.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "agents.config.json");

async function main() {
  const registry = new ProviderRegistry();

  // 从配置文件加载所有 agent
  if (existsSync(CONFIG_PATH)) {
    await registry.loadConfig(CONFIG_PATH);
  } else {
    console.warn("[main] 未找到 agents.config.json，无 agent 加载");
  }

  // 初始化认证
  const auth = new AuthManager();

  const port = Number(process.env.PORT) || 18789;
  startServer(registry, auth, port);
}

main().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
