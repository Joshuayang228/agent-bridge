import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TimelineStore } from "../timeline-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TimelineStore", () => {
  let store: TimelineStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    store = new TimelineStore({
      dbPath: join(tmpDir, "test.db"),
      retentionDays: 7,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── timeline 事件 ───

  it("insertEvent 返回递增 seq", () => {
    const seq1 = store.insertEvent({
      agentId: "agent-a",
      eventType: "agent",
      eventData: { text: "hello" },
    });
    const seq2 = store.insertEvent({
      agentId: "agent-a",
      eventType: "agent",
      eventData: { text: "world" },
    });
    expect(seq2).toBeGreaterThan(seq1);
    expect(seq1).toBeGreaterThan(0);
  });

  it("getEventsSince 拉取 seq > since 的事件", () => {
    const seq1 = store.insertEvent({ agentId: "a", eventType: "t", eventData: { n: 1 } });
    const seq2 = store.insertEvent({ agentId: "a", eventType: "t", eventData: { n: 2 } });
    const seq3 = store.insertEvent({ agentId: "a", eventType: "t", eventData: { n: 3 } });

    const result = store.getEventsSince(seq1);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].seq).toBe(seq2);
    expect(result.events[1].seq).toBe(seq3);
    expect(result.events[0].eventData).toEqual({ n: 2 });
    expect(result.hasMore).toBe(false);
    expect(result.nextSeq).toBe(seq3);
  });

  it("getEventsSince 按 agentId 过滤", () => {
    store.insertEvent({ agentId: "a", eventType: "t", eventData: { x: 1 } });
    const seqB = store.insertEvent({ agentId: "b", eventType: "t", eventData: { x: 2 } });

    const result = store.getEventsSince(0, 200, "b");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].agentId).toBe("b");
    expect(result.events[0].seq).toBe(seqB);
  });

  it("getEventsSince hasMore=true 当结果超过 limit", () => {
    for (let i = 0; i < 10; i++) {
      store.insertEvent({ agentId: "a", eventType: "t", eventData: { i } });
    }
    const result = store.getEventsSince(0, 5);
    expect(result.events).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    // nextSeq 应该是第 5 条的 seq
    const nextResult = store.getEventsSince(result.nextSeq, 5);
    expect(nextResult.events).toHaveLength(5);
    expect(nextResult.hasMore).toBe(false);
  });

  it("getEventsSince 无数据返回空数组", () => {
    const result = store.getEventsSince(999);
    expect(result.events).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextSeq).toBe(999);
  });

  it("getLatestSeq 返回最大 seq", () => {
    expect(store.getLatestSeq()).toBe(0);
    const seq = store.insertEvent({ agentId: "a", eventType: "t", eventData: {} });
    expect(store.getLatestSeq()).toBe(seq);
  });

  it("eventData 支持复杂对象", () => {
    const complex = { nested: { arr: [1, 2, { deep: true }], str: "中文测试" } };
    store.insertEvent({ agentId: "a", eventType: "t", eventData: complex });
    const result = store.getEventsSince(0);
    expect(result.events[0].eventData).toEqual(complex);
  });

  // ─── 审批 ───

  it("insertApproval + getPendingApprovals", () => {
    store.insertApproval({
      id: "appr-1",
      agentId: "agent-a",
      action: "Bash",
      description: "rm -rf /",
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    const pending = store.getPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("appr-1");
    expect(pending[0].status).toBe("pending");
  });

  it("updateApprovalStatus 把 pending 改成 approved", () => {
    store.insertApproval({
      id: "appr-2",
      agentId: "agent-a",
      action: "Bash",
      description: "ls",
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    const ok = store.updateApprovalStatus("appr-2", "approved");
    expect(ok).toBe(true);
    expect(store.getPendingApprovals()).toHaveLength(0);
  });

  it("updateApprovalStatus 已 resolved 的审批不能再改", () => {
    store.insertApproval({
      id: "appr-3",
      agentId: "a",
      action: "Bash",
      description: null,
      status: "approved",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
    });
    const ok = store.updateApprovalStatus("appr-3", "rejected");
    expect(ok).toBe(false);
  });

  it("getPendingApprovals 按 agentId 过滤", () => {
    store.insertApproval({
      id: "a1",
      agentId: "agent-a",
      action: "x",
      description: null,
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    store.insertApproval({
      id: "b1",
      agentId: "agent-b",
      action: "x",
      description: null,
      status: "pending",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    expect(store.getPendingApprovals("agent-a")).toHaveLength(1);
    expect(store.getPendingApprovals("agent-b")).toHaveLength(1);
    expect(store.getPendingApprovals()).toHaveLength(2);
  });

  // ─── agent 状态 ───

  it("upsertAgent 新增 agent", () => {
    store.upsertAgent({
      id: "agent-x",
      name: "Test Agent",
      type: "claude-code",
      capabilities: ["shell", "file"],
    });
    const agent = store.getAgent("agent-x");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Test Agent");
    expect(agent!.status).toBe("online");
    expect(JSON.parse(agent!.capabilities)).toEqual(["shell", "file"]);
  });

  it("upsertAgent 重复注册更新信息并设为 online", () => {
    store.upsertAgent({ id: "a", name: "v1", type: "t", capabilities: [] });
    store.updateAgentStatus("a", "offline");
    expect(store.getAgent("a")!.status).toBe("offline");

    store.upsertAgent({ id: "a", name: "v2", type: "t2", capabilities: ["x"] });
    const agent = store.getAgent("a")!;
    expect(agent.name).toBe("v2");
    expect(agent.type).toBe("t2");
    expect(agent.status).toBe("online");
  });

  it("updateAgentStatus 标记离线", () => {
    store.upsertAgent({ id: "a", name: "n", type: "t", capabilities: [] });
    const ok = store.updateAgentStatus("a", "offline");
    expect(ok).toBe(true);
    expect(store.getAgent("a")!.status).toBe("offline");
  });

  it("listAgents 返回所有 agent", () => {
    store.upsertAgent({ id: "a", name: "A", type: "t", capabilities: [] });
    store.upsertAgent({ id: "b", name: "B", type: "t", capabilities: [] });
    expect(store.listAgents()).toHaveLength(2);
  });

  it("getAgentStatusNotices 返回所有 agent 状态", () => {
    store.upsertAgent({ id: "a", name: "A", type: "t", capabilities: [] });
    store.upsertAgent({ id: "b", name: "B", type: "t", capabilities: [] });
    store.updateAgentStatus("b", "offline");
    const notices = store.getAgentStatusNotices();
    expect(notices).toHaveLength(2);
    const aNotice = notices.find((n) => n.agentId === "a");
    const bNotice = notices.find((n) => n.agentId === "b");
    expect(aNotice!.status).toBe("online");
    expect(bNotice!.status).toBe("offline");
  });

  // ─── 保留策略 ───

  it("cleanOldEvents 清理超过保留期的事件", () => {
    // 用 retentionDays=1 的 store
    store.close();
    store = new TimelineStore({
      dbPath: join(tmpDir, "test.db"),
      retentionDays: 1,
    });
    // 插 2 条旧事件 + 1 条新事件
    const oldSeq1 = store.insertEvent({ agentId: "a", eventType: "t", eventData: { old: 1 } });
    const oldSeq2 = store.insertEvent({ agentId: "a", eventType: "t", eventData: { old: 2 } });
    const newSeq = store.insertEvent({ agentId: "a", eventType: "t", eventData: { new: true } });

    // 手动把前两条的 created_at 改成 2 天前
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db;
    db.prepare(`UPDATE timeline_events SET created_at = ? WHERE seq IN (?, ?)`).run(
      twoDaysAgo,
      oldSeq1,
      oldSeq2,
    );

    const deleted = store.cleanOldEvents();
    expect(deleted).toBe(2);

    const result = store.getEventsSince(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].seq).toBe(newSeq);
    expect(result.events[0].eventData).toEqual({ new: true });
  });
});
