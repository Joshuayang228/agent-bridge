/**
 * OpenAI 兼容 HTTP 端点
 *
 * GET  /v1/models            — 列出所有 agent（model 名 = agent id）
 * POST /v1/chat/completions   — 聊天补全（支持 stream: true → SSE）
 *
 * 认证：Authorization: Bearer <token>（GATEWAY_TOKEN 或 device token）
 */

import type { ServerResponse, IncomingMessage } from "node:http";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AuthManager } from "./auth.js";

interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
}

/** 处理 OpenAI 兼容请求，返回 true 表示已处理 */
export async function handleOpenAIHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: ProviderRegistry,
  auth: AuthManager,
): Promise<boolean> {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /v1/models
  if (url.pathname === "/v1/models" && req.method === "GET") {
    if (!checkAuth(req, auth)) {
      return sendError(res, 401, "invalid_api_key", "Invalid API key");
    }
    const agents = registry.list();
    const data = agents.map((a) => ({
      id: a.id,
      object: "model" as const,
      created: 0,
      owned_by: "agent-bridge",
    }));
    return sendJson(res, { object: "list", data });
  }

  // POST /v1/chat/completions
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!checkAuth(req, auth)) {
      return sendError(res, 401, "invalid_api_key", "Invalid API key");
    }

    const body = await readBody(req);
    let parsed: ChatRequest;
    try {
      parsed = JSON.parse(body) as ChatRequest;
    } catch {
      return sendError(res, 400, "invalid_request", "Invalid JSON body");
    }

    const { model, messages, stream } = parsed;
    const provider = registry.get(model);
    if (!provider) {
      return sendError(res, 404, "model_not_found", `Model not found: ${model}`);
    }

    // 取最后一条 user 消息
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      return sendError(res, 400, "invalid_request", "No user message found");
    }

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      // 流式 SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      try {
        const events = provider.send({
          sessionId: `http-${completionId}`,
          agentId: model,
          message: lastUser.content,
          requestApproval: async () => true,
        });

        for await (const evt of events) {
          if (evt.type === "delta" && evt.text) {
            writeSse(res, {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }],
            });
          }
          if (evt.type === "done" && evt.text) {
            // done 事件不重复发送，delta 已经包含了所有内容
          }
        }

        // 发送结束标记
        writeSse(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeSse(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: `[error] ${msg}` }, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
      }
      res.end();
      return true;
    }

    // 非流式
    try {
      const events = provider.send({
        sessionId: `http-${completionId}`,
        agentId: model,
        message: lastUser.content,
        requestApproval: async () => true,
      });

      let fullText = "";
      for await (const evt of events) {
        if (evt.type === "delta") fullText += evt.text;
        if (evt.type === "done" && evt.text) fullText = evt.text;
      }

      return sendJson(res, {
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendError(res, 500, "internal_error", msg);
    }
  }

  return false;
}

// ─── 工具函数 ───

function checkAuth(req: IncomingMessage, auth: AuthManager): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return auth.verify(token);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown): boolean {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
  return true;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): boolean {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
  return true;
}

function writeSse(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
