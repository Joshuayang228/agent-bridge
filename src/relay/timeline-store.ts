/**
 * TimelineStore —— SQLite 持久化层
 *
 * 存储所有 agent 推上来的 timeline 事件 + 审批状态 + agent 状态。
 * relay 重启后数据不丢。
 *
 * 用 better-sqlite3 同步 API：简单可靠，单写者场景无并发问题。
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type {
  StoredTimelineEvent,
  AgentStatusNotice,
} from "./protocol.js";
import { DEFAULT_RETENTION_DAYS, DEFAULT_HISTORY_LIMIT } from "./protocol.js";

// ─── 审批记录 ───
export interface ApprovalRecord {
  id: string;
  agentId: string;
  action: string;
  description: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
}

// ─── agent 记录 ───
export interface AgentRecord {
  id: string;
  name: string;
  type: string;
  capabilities: string; // JSON 序列化
  status: "online" | "offline";
  lastSeen: number;
}

export interface TimelineStoreOptions {
  /** SQLite 文件路径，默认 ~/.agent-bridge/relay.db */
  dbPath?: string;
  /** 保留天数，默认 7 */
  retentionDays?: number;
  /** 是否启用 WAL 模式（推荐本地单进程） */
  wal?: boolean;
}

export class TimelineStore {
  private db: DatabaseType;
  private retentionDays: number;

  constructor(opts: TimelineStoreOptions = {}) {
    const dbPath = opts.dbPath ?? defaultDbPath();
    // 确保目录存在
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;

    if (opts.wal !== false) {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("foreign_keys = ON");

    this.migrate();
  }

  // ─── 初始化 schema ───

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_agent_seq ON timeline_events(agent_id, seq);
      CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline_events(created_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        registered_at INTEGER NOT NULL
      );
    `);
  }

  // ─── timeline 事件 ───

  /** 插入事件，返回分配的 seq */
  insertEvent(input: {
    agentId: string;
    eventType: string;
    eventData: unknown;
  }): number {
    const stmt = this.db.prepare(
      `INSERT INTO timeline_events (agent_id, event_type, event_data, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.agentId,
      input.eventType,
      JSON.stringify(input.eventData),
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  /** 拉取 seq > since 的事件，按 seq 升序 */
  getEventsSince(
    since: number,
    limit: number = DEFAULT_HISTORY_LIMIT,
    agentId?: string,
  ): { events: StoredTimelineEvent[]; hasMore: boolean; nextSeq: number } {
    const sql = agentId
      ? `SELECT seq, agent_id, event_type, event_data, created_at
         FROM timeline_events
         WHERE seq > ? AND agent_id = ?
         ORDER BY seq ASC
         LIMIT ?`
      : `SELECT seq, agent_id, event_type, event_data, created_at
         FROM timeline_events
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`;
    const rows = agentId
      ? this.db.prepare(sql).all(since, agentId, limit + 1) as RawEventRow[]
      : this.db.prepare(sql).all(since, limit + 1) as RawEventRow[];

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const events = slice.map(rowToEvent);
    const nextSeq = events.length > 0 ? events[events.length - 1].seq : since;
    return { events, hasMore, nextSeq };
  }

  /** 获取最新 seq（用于手机初次连接时拿基线） */
  getLatestSeq(): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) as max_seq FROM timeline_events`)
      .get() as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  // ─── 审批 ───

  insertApproval(record: ApprovalRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO approvals (id, agent_id, action, description, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      record.id,
      record.agentId,
      record.action,
      record.description,
      record.status,
      record.createdAt,
      record.resolvedAt,
    );
  }

  updateApprovalStatus(
    id: string,
    status: "approved" | "rejected",
    resolvedAt: number = Date.now(),
  ): boolean {
    const result = this.db
      .prepare(`UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, resolvedAt, id);
    return result.changes > 0;
  }

  getPendingApprovals(agentId?: string): ApprovalRecord[] {
    const sql = agentId
      ? `SELECT * FROM approvals WHERE status = 'pending' AND agent_id = ? ORDER BY created_at ASC`
      : `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`;
    const rows = agentId
      ? this.db.prepare(sql).all(agentId) as RawApprovalRow[]
      : this.db.prepare(sql).all() as RawApprovalRow[];
    return rows.map(rowToApproval);
  }

  // ─── agent 状态 ───

  upsertAgent(agent: {
    id: string;
    name: string;
    type: string;
    capabilities: string[];
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO agents (id, name, type, capabilities, status, last_seen, registered_at)
       VALUES (?, ?, ?, ?, 'online', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         capabilities = excluded.capabilities,
         status = 'online',
         last_seen = excluded.last_seen`,
    );
    const now = Date.now();
    stmt.run(
      agent.id,
      agent.name,
      agent.type,
      JSON.stringify(agent.capabilities),
      now,
      now,
    );
  }

  updateAgentStatus(agentId: string, status: "online" | "offline"): boolean {
    const result = this.db
      .prepare(`UPDATE agents SET status = ?, last_seen = ? WHERE id = ?`)
      .run(status, Date.now(), agentId);
    return result.changes > 0;
  }

  getAgent(agentId: string): AgentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get(agentId) as RawAgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): AgentRecord[] {
    const rows = this.db.prepare(`SELECT * FROM agents`).all() as RawAgentRow[];
    return rows.map(rowToAgent);
  }

  /** 获取 agent 状态通知（用于手机端拉历史时附带） */
  getAgentStatusNotices(): AgentStatusNotice[] {
    const rows = this.db
      .prepare(`SELECT id, status, last_seen FROM agents`)
      .all() as { id: string; status: "online" | "offline"; last_seen: number }[];
    return rows.map((r) => ({
      kind: "agent_status" as const,
      agentId: r.id,
      status: r.status,
      lastSeen: r.last_seen,
    }));
  }

  // ─── 保留策略 ───

  /** 清理超过保留期的 timeline 事件，返回删除条数 */
  cleanOldEvents(): number {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db
      .prepare(`DELETE FROM timeline_events WHERE created_at < ?`)
      .run(cutoff);
    return result.changes;
  }

  // ─── 生命周期 ───

  close(): void {
    this.db.close();
  }
}

// ─── 默认数据库路径 ───

function defaultDbPath(): string {
  const home = homedir();
  return join(home, ".agent-bridge", "relay.db");
}

// ─── 行映射 ───

interface RawEventRow {
  seq: number;
  agent_id: string;
  event_type: string;
  event_data: string;
  created_at: number;
}

interface RawApprovalRow {
  id: string;
  agent_id: string;
  action: string;
  description: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  resolved_at: number | null;
}

interface RawAgentRow {
  id: string;
  name: string;
  type: string;
  capabilities: string;
  status: "online" | "offline";
  last_seen: number;
  registered_at: number;
}

function rowToEvent(row: RawEventRow): StoredTimelineEvent {
  return {
    seq: row.seq,
    agentId: row.agent_id,
    eventType: row.event_type,
    eventData: JSON.parse(row.event_data),
    createdAt: row.created_at,
  };
}

function rowToApproval(row: RawApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    action: row.action,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function rowToAgent(row: RawAgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    capabilities: row.capabilities,
    status: row.status,
    lastSeen: row.last_seen,
  };
}
