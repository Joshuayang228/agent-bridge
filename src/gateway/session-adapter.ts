/**
 * SessionAdapter —— 外部 agent CLI 的 session 文件适配器接口
 *
 * 不同的 agent CLI（Claude Code、Codex、未来的 Aider / Cursor CLI 等）
 * 各自把会话写到不同的目录、用不同的 JSONL 格式。
 * SessionWatcher 通过这个接口抽象出统一行为，新增 agent 只需实现这个接口。
 */

import type { AgentEvent } from "../providers/types.js";

export interface SessionFile {
  path: string;
  mtime: number;
}

export interface SessionAdapter {
  /** adapter 唯一标识，跟 AgentConfig.type 对应（如 "claude-code"、"codex"） */
  readonly id: string;

  /** 监听的根目录（fs.watch recursive + 扫描的根） */
  getRootDir(): string;

  /** 扫描所有 session 文件，返回 mtime 最新的那个；没有返回 null */
  findLatestFile(): SessionFile | null;

  /** 从文件路径提取 session id（用于手机端续接 --resume） */
  extractSessionId(filePath: string): string | null;

  /**
   * 从 session 文件提取对应的 cwd（用于手机端续接 --resume 时定位正确的项目目录）
   * 不同 agent CLI 存 cwd 的位置不同：CC 在 user message 行的 cwd 字段，
   * Codex 在 session_meta.payload.cwd。返回 null 表示读不出。
   */
  extractCwd(filePath: string): string | null;

  /** 解析一行 JSON，转 AgentEvent 列表（user / queue-operation 等忽略返回空数组） */
  parseLine(line: unknown): AgentEvent[];
}
