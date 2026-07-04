import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  it("create 创建会话并返回完整对象", () => {
    const session = sm.create("mock", "测试标题");
    expect(session.id).toBeTruthy();
    expect(session.agentId).toBe("mock");
    expect(session.title).toBe("测试标题");
    expect(session.messages).toHaveLength(0);
  });

  it("create 不传标题时用默认标题", () => {
    const session = sm.create("mock");
    expect(session.title).toContain("会话");
  });

  it("get 返回已创建的会话", () => {
    const session = sm.create("mock");
    const found = sm.get(session.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(session.id);
  });

  it("get 不存在的 id 返回 undefined", () => {
    expect(sm.get("nonexistent")).toBeUndefined();
  });

  it("list 返回会话摘要列表", () => {
    sm.create("mock", "会话1");
    sm.create("claude-code", "会话2");
    const list = sm.list();
    expect(list).toHaveLength(2);
    expect(list[0].agentId).toBeTruthy();
    expect(list[0].messageCount).toBe(0);
  });

  it("list 按 updatedAt 倒序排列", async () => {
    const s1 = sm.create("mock", "第一个");
    sm.addUserMessage(s1.id, "hello");
    // 等待一点时间确保 updatedAt 不同
    await new Promise((r) => setTimeout(r, 10));
    const s2 = sm.create("mock", "第二个");
    sm.addUserMessage(s2.id, "world");
    const list = sm.list();
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });

  it("addUserMessage 添加消息并更新时间", () => {
    const session = sm.create("mock");
    sm.addUserMessage(session.id, "你好");
    const history = sm.history(session.id);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(history[0].text).toBe("你好");
  });

  it("addUserMessage 第一条消息更新标题", () => {
    const session = sm.create("mock");
    sm.addUserMessage(session.id, "这是一条很长的消息内容");
    const updated = sm.get(session.id);
    expect(updated?.title).toContain("这是一条很长的消息");
  });

  it("addAssistantMessage 添加 assistant 消息", () => {
    const session = sm.create("mock");
    sm.addAssistantMessage(session.id, "你好，我是机器人");
    const history = sm.history(session.id);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("assistant");
    expect(history[0].text).toBe("你好，我是机器人");
  });

  it("history 不存在的会话返回空数组", () => {
    expect(sm.history("nonexistent")).toEqual([]);
  });

  it("delete 删除会话返回 true", () => {
    const session = sm.create("mock");
    expect(sm.delete(session.id)).toBe(true);
    expect(sm.get(session.id)).toBeUndefined();
  });

  it("delete 不存在的会话返回 false", () => {
    expect(sm.delete("nonexistent")).toBe(false);
  });
});
