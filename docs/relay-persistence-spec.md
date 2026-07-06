# 云端 Relay + 持久化 需求文档

> 状态:待用户确认
> 创建:2026-07-06

## 1. 需求背景(Why)

当前架构:`手机 → Tailscale → 家里 Gateway → agent`

痛点(用户已确认):
- **远程访问不稳定**:Tailscale P2P 打洞经常断,移动网络切换/家里路由器抖动都会断
- **断了看不到历史输出**:WS 断连后,断连期间的 timeline 事件永久丢失(`ws-handler.ts` 的 state 全在内存)
- **审批状态丢了**:断连时正在等待的 `pendingApproval` 状态丢失
- **想离线跑 agent**:agent 跑在家里,希望手机随时回来看进度——当前做不到

## 2. 功能目标(What)

1. **稳定性**:家里 Gateway outbound 主动连云端 relay,穿透 NAT,不走 P2P 打洞
2. **持久化**:所有 timeline 事件 + 审批状态持久化到云端 SQLite,断连重连可拉历史
3. **离线可见**:agent 跑在家里,事件实时推云端;手机随时回来看历史 + 实时流
4. **Tailscale 备用**:保留 Tailscale 作 fallback,relay 挂了还能用

## 3. 技术方案(How)

### 3.1 整体架构

```
┌─────────┐         ┌─────────────────────┐         ┌──────────────┐
│  手机   │  WSS    │  云端 relay         │  WSS    │  家里 Gateway │
│ (WebApp)│ ──────> │  ┌───────────────┐  │ <────── │  (agent 进程) │
└─────────┘         │  │ SQLite        │  │ outbound└──────────────┘
                    │  └───────────────┘  │
                    │  转发 + 拉历史      │
                    └─────────────────────┘
```

- **家里 Gateway**:outbound WSS 主动连云端 relay,把所有事件实时推上去
- **云端 relay**:接收家里的事件,持久化到 SQLite,转发给在线的手机;手机断连重连时从 SQLite 拉历史
- **手机**:连云端 relay,断连重连发送 `since=<seq>` 拉增量
- **不做 E2E 加密**(云服务器是自己的,简化实现)
- **保留 Tailscale**:relay 挂了或 LAN 内用时走 Tailscale 直连

### 3.2 数据流

**正常实时流**:
1. 手机发消息 → 云端 relay → 家里 Gateway
2. 家里 Gateway 跑 agent → 产生事件 → 推到云端 relay
3. 云端 relay:写 SQLite(分配 seq)+ 转发给在线手机

**手机断连重连**:
1. 手机重连云端 relay,发送 `since=<lastSeq>`
2. 云端 relay 从 SQLite 查 `seq > since` 的事件,批量推给手机
3. 手机补齐历史后,进入正常实时流

**家里 Gateway 断连**(家里网络抖动):
1. relay 检测到家里 WS 断开 → 标记 agent 状态为 `offline` → 推给手机
2. 家里 Gateway 重连后,继续推事件
3. **关键**:家里 Gateway 本地维护一个 send buffer(已发出但未确认持久化的事件),relay 持久化成功后回 ACK,ACK 之前的事件重连后补发——避免"事件推到 relay 但 relay 还没写盘就挂了"的丢失

### 3.3 关键接口

**新增协议帧**(手机 ↔ relay):

```typescript
// 手机 → relay:拉历史
{ type: "request", method: "history.since", params: { since: 12345, limit: 200 } }
// relay → 手机:历史批量返回
{ type: "response", result: { events: [...], hasMore: false, nextSeq: 12545 } }

// relay → 手机:agent 状态变化
{ type: "event", event: "agent_status", data: { agentId, status: "online" | "offline" } }
```

**家里 Gateway → relay 协议**(新内部协议,不走手机协议):
- 家里 Gateway 作为 relay 的"agent client",用 `AGENT_TOKEN` 环境变量鉴权
- 所有现有 `protocol/frames.ts` 的事件帧,封装一层 `agent_event` 信封推给 relay
- relay 收到后:写 SQLite(分配 seq)+ 回 ACK + 转发给手机

```typescript
// Gateway → relay
{ kind: "agent_event", agentId, eventType, eventData, clientSeq }
// relay → Gateway (ACK)
{ kind: "agent_event_ack", clientSeq, serverSeq }
```

### 3.4 数据模型(SQLite)

```sql
-- timeline 事件表
CREATE TABLE timeline_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- 全局递增序列号
  agent_id TEXT NOT NULL,                  -- 哪个 agent
  event_type TEXT NOT NULL,                -- 事件类型
  event_data TEXT NOT NULL,                -- JSON 序列化的事件数据
  created_at INTEGER NOT NULL              -- 时间戳(ms)
);
CREATE INDEX idx_timeline_agent_seq ON timeline_events(agent_id, seq);
CREATE INDEX idx_timeline_created ON timeline_events(created_at);

-- 审批状态表
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,                     -- 审批 ID
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,                    -- pending | approved | rejected
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- agent 状态表
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                    -- online | offline
  last_seen INTEGER
);
```

**保留策略**:timeline_events 保留 7 天(可配置),定时清理。

### 3.5 部署架构

**云端 VPS**:
- 跑 `relay-server`(Node.js,TS),监听端口(比如 18790)
- Caddy 反代 + WSS(Let's Encrypt 自动证书)
- SQLite 文件本地存储(`~/.agent-bridge/relay.db`)
- 环境变量:`RELAY_TOKEN`(家里 Gateway 连入鉴权)、`PAIRING_CODE`(手机配对)

**家里 Gateway**:
- 启动时连云端 relay 的 WSS,带 `AGENT_TOKEN`
- 把所有事件实时推上去
- 保留 LAN 监听(Tailscale 备用)
- 环境变量:`RELAY_URL`、`AGENT_TOKEN`

**手机**:
- 优先连云端 relay
- 配对时拿云端 relay 的 URL + token
- 环境变量或配置页切换到 Tailscale 模式

### 3.6 依赖

- `better-sqlite3`——SQLite 驱动(同步 API,简单可靠)
- `ws`——已有
- 无其他新依赖

## 4. 影响范围评估

**新增文件**:
- `src/relay/server.ts`——云端 relay 服务(WS server + 事件路由 + 持久化)
- `src/relay/timeline-store.ts`——SQLite 持久化层
- `src/relay/agent-client.ts`——家里 Gateway 连云端的 outbound 客户端
- `src/relay/protocol.ts`——relay 内部协议类型
- `src/relay/__tests__/`——单元测试

**修改文件**:
- `src/gateway/ws-handler.ts`——支持 `history.since` 请求(手机拉历史)
- `src/gateway/connection-manager.ts`——事件广播时同步推给 relay client
- `src/gateway/auth.ts`——配对流程返回 relay URL
- `src/index.ts`——根据配置启动 relay 或 gateway 或两者(同一进程或独立部署)
- `web/index.html`——重连时拉历史、显示 agent online/offline
- `start.bat`——环境变量配置(RELAY_URL / AGENT_TOKEN)
- `package.json`——加 `better-sqlite3`、加 `start:relay` 脚本

**破坏性变更**:
- 无(保留现有协议,只新增能力)
- Tailscale 路径仍可用

**测试**:
- relay 单元测试(timeline-store CRUD、ACK 机制)
- 集成测试(家里→relay→手机 全链路)
- 断连重连测试(手机断、家里断两种场景)

## 5. 实施步骤

### 步骤 1:SQLite 持久化层 + relay server 骨架
- 实现 `timeline-store.ts`(CRUD + 保留策略)
- 实现 `relay/server.ts`(WS server + 接收 agent_event + 持久化 + ACK)
- 单元测试通过

### 步骤 2:家里 Gateway 连云端 relay
- 实现 `agent-client.ts`(outbound WSS 连 relay + send buffer + ACK 重传)
- 修改 `connection-manager.ts`,事件广播时同步推给 relay client
- 集成测试:家里发事件 → relay 收到 + 持久化 + ACK

### 步骤 3:手机端拉历史
- 修改 `ws-handler.ts`,支持 `history.since` 请求
- 修改 `web/index.html`,断连重连时发送 `since` 拉增量
- 端到端测试:断连 → 期间产生事件 → 重连 → 看到历史

### 步骤 4:审批状态持久化
- 审批请求也走 relay 持久化
- 断连重连能看到未决审批

### 步骤 5:agent 状态 + 部署打磨
- agent online/offline 状态广播
- WSS(HTTPS 证书,Caddy 反代)
- 配对流程拿 relay URL
- start.bat / 部署文档

## 6. 风险与权衡

| 风险 | 缓解 |
|------|------|
| 云端 relay 单点故障 | 保留 Tailscale 作 fallback;relay 重启后 SQLite 不丢 |
| SQLite 并发写性能 | 单写者(relay 串行处理),没问题 |
| 历史数据无限增长 | 保留策略(默认 7 天,可配置) |
| WSS 证书 | Caddy 自动 Let's Encrypt |
| 家里 Gateway 断连期间 agent 还在跑,事件丢失 | Gateway 本地 send buffer + relay ACK 机制,重连补发 |
| 双连(手机同时连 relay 和 LAN) | 只允许一个活跃连接,优先 relay |
| 现有 Tailscale 用户体验 | 保留,LAN 直连仍可用,配置页可切换 |

## 7. 待确认问题

1. **云端 VPS 的域名**:WSS 需要域名 + 证书,你有现成的域名吗?还是用 IP + 自签证书?
2. **relay 和 gateway 是否同进程**:为了开发方便,可以让 `src/index.ts` 根据环境变量决定启动哪个(本地开发时可以同进程模拟)
3. **手机配对流程**:现在配对码是家里 Gateway 生成的,改成云端 relay 生成?还是家里 Gateway 透传?
