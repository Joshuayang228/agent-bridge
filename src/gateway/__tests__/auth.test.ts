import { describe, it, expect, beforeEach } from "vitest";
import { AuthManager } from "../auth.js";

describe("AuthManager", () => {
  let auth: AuthManager;

  beforeEach(() => {
    delete process.env.GATEWAY_TOKEN;
    auth = new AuthManager();
  });

  it("配对码是 6 位数字", () => {
    expect(auth.pairingCodeDisplay).toMatch(/^\d{6}$/);
  });

  it("pair 正确配对码返回 device token", () => {
    const token = auth.pair(auth.pairingCodeDisplay);
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
  });

  it("pair 错误配对码返回 null", () => {
    const token = auth.pair("000000");
    expect(token).toBeNull();
  });

  it("verify 有效 token 返回 true", () => {
    const token = auth.pair(auth.pairingCodeDisplay);
    expect(auth.verify(token!)).toBe(true);
  });

  it("verify 无效 token 返回 false", () => {
    expect(auth.verify("fake-token")).toBe(false);
  });

  it("verify null 返回 false", () => {
    expect(auth.verify(null as unknown as string)).toBe(false);
  });

  it("hasEnvToken 无环境变量时返回 false", () => {
    expect(auth.hasEnvToken()).toBe(false);
  });

  it("hasEnvToken 有环境变量时返回 true", () => {
    process.env.GATEWAY_TOKEN = "test-token";
    const authWithEnv = new AuthManager();
    expect(authWithEnv.hasEnvToken()).toBe(true);
    expect(authWithEnv.verify("test-token")).toBe(true);
  });
});
