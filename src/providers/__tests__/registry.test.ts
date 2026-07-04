import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderRegistry } from "../registry.js";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_CONFIG = join(tmpdir(), "test-agents.config.json");

describe("ProviderRegistry", () => {
  beforeEach(() => {
    if (existsSync(TMP_CONFIG)) unlinkSync(TMP_CONFIG);
  });

  afterEach(() => {
    if (existsSync(TMP_CONFIG)) unlinkSync(TMP_CONFIG);
  });

  it("list 初始为空", () => {
    const registry = new ProviderRegistry();
    expect(registry.list()).toHaveLength(0);
  });

  it("get 不存在的 id 返回 undefined", () => {
    const registry = new ProviderRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("loadConfig 加载 mock agent", async () => {
    writeFileSync(TMP_CONFIG, JSON.stringify({
      agents: [
        {
          id: "test-mock",
          name: "测试",
          type: "mock",
          capabilities: ["chat"],
        },
      ],
    }));
    const registry = new ProviderRegistry();
    await registry.loadConfig(TMP_CONFIG);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe("test-mock");
  });

  it("loadConfig 加载多个 agent", async () => {
    writeFileSync(TMP_CONFIG, JSON.stringify({
      agents: [
        { id: "mock1", name: "机器人1", type: "mock", capabilities: ["chat"] },
        { id: "mock2", name: "机器人2", type: "mock", capabilities: ["chat"], config: { mode: "echo" } },
      ],
    }));
    const registry = new ProviderRegistry();
    await registry.loadConfig(TMP_CONFIG);
    expect(registry.list()).toHaveLength(2);
  });

  it("loadConfig 加载 allowedTools 和 dangerousTools", async () => {
    writeFileSync(TMP_CONFIG, JSON.stringify({
      agents: [
        {
          id: "claude-code",
          name: "Claude Code",
          type: "claude-code",
          capabilities: ["chat", "shell"],
          allowedTools: ["Read", "Bash"],
          dangerousTools: ["Bash"],
        },
      ],
    }));
    const registry = new ProviderRegistry();
    await registry.loadConfig(TMP_CONFIG);
    const provider = registry.get("claude-code");
    expect(provider).toBeDefined();
    expect(provider?.info.capabilities).toContain("shell");
  });

  it("loadConfig 文件不存在时不崩溃", async () => {
    const registry = new ProviderRegistry();
    await registry.loadConfig(join(tmpdir(), "nonexistent-config.json"));
    expect(registry.list()).toHaveLength(0);
  });

  it("loadConfig 未知 type 跳过该 agent", async () => {
    writeFileSync(TMP_CONFIG, JSON.stringify({
      agents: [
        { id: "unknown", name: "未知", type: "nonexistent-type", capabilities: [] },
        { id: "mock1", name: "测试", type: "mock", capabilities: ["chat"] },
      ],
    }));
    const registry = new ProviderRegistry();
    await registry.loadConfig(TMP_CONFIG);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe("mock1");
  });
});
