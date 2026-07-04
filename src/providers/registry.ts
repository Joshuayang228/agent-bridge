/**
 * Provider 注册表 —— 管理「怎么拿到所有 agent」
 *
 * 启动时加载 agents.config.json，按 type 实例化对应 Provider。
 * 后续加 agent 引擎只需：① 写一个 Provider ② 在 config 加一条。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AgentConfig, AgentProvider } from "./types.js";
import type { AgentInfo } from "../protocol/frames.js";
import { MockProvider } from "./mock-provider.js";
import { ClaudeCodeProvider } from "./claude-code-provider.js";

// type → 工厂函数的映射，新增引擎在这里注册
type ProviderFactory = (config: AgentConfig) => AgentProvider;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  mock: (config) => new MockProvider(config),
  "claude-code": (config) => new ClaudeCodeProvider(config),
  // 后续扩展：
  // "my-agent": (config) => new MyAgentProvider(config),
  // "openclaw": (config) => new OpenClawProvider(config),
};

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  /** 从配置文件加载并实例化所有 provider */
  async loadConfig(configPath: string): Promise<void> {
    if (!existsSync(configPath)) {
      console.warn(`[registry] 配置文件不存在: ${configPath}`);
      return;
    }
    const raw = await readFile(configPath, "utf-8");
    const { agents } = JSON.parse(raw) as { agents: AgentConfig[] };

    for (const cfg of agents) {
      const factory = PROVIDER_FACTORIES[cfg.type];
      if (!factory) {
        console.warn(`[registry] 未知 provider 类型 "${cfg.type}"，跳过 agent "${cfg.id}"`);
        continue;
      }
      this.providers.set(cfg.id, factory(cfg));
      console.log(`[registry] 已加载 agent: ${cfg.id} (${cfg.type})`);
    }
  }

  /** 手动注册 provider（编程方式） */
  register(provider: AgentProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  /** 获取单个 provider */
  get(agentId: string): AgentProvider | undefined {
    return this.providers.get(agentId);
  }

  /** 列出所有 agent 元信息 —— 对应 agents.list 方法 */
  list(): AgentInfo[] {
    return [...this.providers.values()].map((p) => p.info);
  }
}
