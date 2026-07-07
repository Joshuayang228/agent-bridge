/**
 * SessionManager —— 会话管理
 *
 * 内存存储（参赛 Demo 够用，后续可换持久化）。
 * 每个会话绑定一个 agent，存消息历史。
 */

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface Session {
  id: string;
  agentId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** 关联的 CC session ID。undefined = 新会话（首条消息不带 --resume），set = 续接该 CC session */
  ccSessionId?: string;
  /** 关联的 Codex session ID。undefined = 新会话，set = 续接该 Codex session（codex exec resume <id>） */
  codexSessionId?: string;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  ccSessionId?: string;
  codexSessionId?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private counter = 0;

  /** 创建新会话 */
  create(agentId: string, title?: string): Session {
    const id = `s${++this.counter}`;
    const now = Date.now();
    const session: Session = {
      id,
      agentId,
      title: title ?? `会话 ${this.counter}`,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** 获取会话 */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** 列出所有会话摘要 */
  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        agentId: s.agentId,
        title: s.title,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        ccSessionId: s.ccSessionId,
        codexSessionId: s.codexSessionId,
      }));
  }

  /** 获取会话消息历史 */
  history(sessionId: string): ChatMessage[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /** 添加用户消息 */
  addUserMessage(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push({ role: "user", text, timestamp: Date.now() });
    session.updatedAt = Date.now();
    // 用第一条用户消息作为标题
    if (session.messages.length === 1) {
      session.title = text.slice(0, 20) + (text.length > 20 ? "..." : "");
    }
  }

  /** 添加 assistant 消息 */
  addAssistantMessage(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push({ role: "assistant", text, timestamp: Date.now() });
    session.updatedAt = Date.now();
  }

  /** 设置会话关联的 CC session ID（首次对话后 CC 返回 session_id 时调用） */
  setCcSessionId(sessionId: string, ccSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ccSessionId = ccSessionId;
  }

  /** 获取会话的 CC session ID */
  getCcSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.ccSessionId;
  }

  /** 设置会话关联的 Codex session ID（codex exec 跑完后从输出捕获） */
  setCodexSessionId(sessionId: string, codexSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.codexSessionId = codexSessionId;
  }

  /** 获取会话的 Codex session ID */
  getCodexSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.codexSessionId;
  }

  /** 删除会话 */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}
