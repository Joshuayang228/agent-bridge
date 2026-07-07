---
name: deploy-relay
description: 部署 agent-bridge 的云端 Relay 服务到腾讯云轻量服务器。当用户说"部署"、"上传"、"发布"、"更新服务器"、"deploy"、"云端更新"时使用此 skill。包含 SSH 直传文件、Docker 构建重启、验证新版本的完整流程。
---

# agent-bridge — 云端 Relay 部署流程

## 基础信息

| 项目 | 值 |
|------|-----|
| 云端服务器 | 腾讯云轻量 `1.12.224.119`（root 用户，SSH 密钥已配置） |
| 云端端口 | 18790 |
| 云端代码目录 | `/root/agent-bridge-relay/` |
| Docker 容器名 | `agent-bridge-relay` |
| 数据持久化 | `/root/agent-bridge-relay/data/`（SQLite 数据库，挂载到容器内） |
| SSH 密钥 | `~/.ssh/id_ed25519`（已配置免密登录） |

## SSH 连接

已配置 SSH 密钥认证，可直接执行远程命令和上传文件：

```powershell
# 测试连接
ssh root@1.12.224.119 "echo OK"

# 上传文件
scp local_file root@1.12.224.119:/remote/path/

# 远程执行命令
ssh root@1.12.224.119 "cd /root/agent-bridge-relay && docker compose up -d --build"
```

## ⛔ 绝对禁止（数据安全红线）

- **禁止上传 `data/` 目录**：该目录包含 SQLite 数据库（`relay.db`），存储所有 timeline 事件、审批记录、配对信息。上传会覆盖服务器数据，导致**不可逆的数据丢失**。
- **禁止使用 zip 打包整个项目上传**：打包会包含 `data/`，上传后解压会覆盖服务器数据库。
- **只允许上传 `src/`、`web/`、`Dockerfile`、`docker-compose.yml`、`package.json`、`package-lock.json`、`tsconfig.json`**。
- 如果需要打包上传，必须排除 `data/` 和 `node_modules/`。

## 部署步骤

### 部署前检查（必做）

```powershell
# 1. 确认本地测试通过
npx tsc --noEmit
npx vitest run

# 2. 确认代码已 push 到 GitHub（服务器用 git pull 拉取）
git status
# 确保 working tree clean
```

### 部署流程（推荐：git pull 方式）

```powershell
# 1. 登录服务器，拉取最新代码
ssh root@1.12.224.119 "cd /root/agent-bridge && git pull"

# 2. 重新构建 Docker 镜像并重启
ssh root@1.12.224.119 "cd /root/agent-bridge-relay && docker compose up -d --build"

# 3. 验证容器运行状态
ssh root@1.12.224.119 "docker ps | grep agent-bridge-relay"

# 4. 验证服务响应（检查 WS 握手）
ssh root@1.12.224.119 "curl -s -o /dev/null -w '%{http_code}' http://localhost:18790/"
# 期望: 426（Upgrade Required，说明 WS 服务正常）

# 5. 查看启动日志确认无报错
ssh root@1.12.224.119 "docker logs agent-bridge-relay --tail 30"
```

### 只改了前端静态文件？

如果只改了 `web/` 目录的文件，且服务器上的容器已经在跑，可以直接覆盖静态文件然后重启容器（比完整构建快）：

```powershell
# 上传 web 目录
scp -r web root@1.12.224.119:/root/agent-bridge-relay/

# 重启容器（容器内用 tsx 运行，重启会重新读取静态文件）
ssh root@1.12.224.119 "docker restart agent-bridge-relay"
```

### 只改了 src/ 下的 TypeScript 代码？

必须重新构建镜像（tsx 需要重新编译执行）：

```powershell
ssh root@1.12.224.119 "cd /root/agent-bridge && git pull && docker compose up -d --build"
```

## 回滚

如果新版本有问题，快速回滚到上一个版本：

```powershell
# 查看 git log，找到上一个 commit
ssh root@1.12.224.119 "cd /root/agent-bridge && git log --oneline -5"

# 回退到指定 commit
ssh root@1.12.224.119 "cd /root/agent-bridge && git reset --hard <commit-hash>"

# 重新构建
ssh root@1.12.224.119 "cd /root/agent-bridge-relay && docker compose up -d --build"
```

## 服务器目录结构

```
/root/agent-bridge-relay/
├── src/              → TypeScript 源码
│   ├── relay/        → relay server 代码（云端跑的就是这个）
│   ├── gateway/      → gateway 代码（本地跑，云端不用）
│   └── index.ts      → 入口（--relay 参数启动 relay 模式）
├── web/              → 前端静态文件（手机端 Web App）
├── data/             → SQLite 数据库（持久化，git 不跟踪）
│   └── relay.db      → timeline 事件 + 审批 + 配对信息
├── .env              → 环境变量（PAIRING_TOKEN 等）
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Docker Compose 配置参考

`docker-compose.yml` 应包含：
- `RELAY_MODE=true` 环境变量
- 端口映射 `18790:18790`
- 数据卷 `./data:/app/data`
- `restart: unless-stopped`

## 常见问题

### SSH 连接失败
- 确认 `~/.ssh/id_ed25519` 存在
- 确认服务器 `~/.ssh/authorized_keys` 包含对应公钥
- 重新生成：`ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519" -N '""'`

### Docker 构建很慢
腾讯云轻量服务器带宽有限，首次拉取镜像可能需要 2-5 分钟。Dockerfile 已配置阿里云 apt 镜像 + 淘宝 npm 镜像加速。后续有缓存会快很多。

### 手机端页面没更新
- 可能是浏览器缓存，强制刷新（手机 Safari：下拉刷新 + 长按刷新按钮）
- 或者容器没重启，确认 `docker restart agent-bridge-relay` 已执行
- 验证：`ssh root@1.12.224.119 "cat /root/agent-bridge-relay/web/index.html | head -5"` 确认文件已更新

### 查看运行日志
```powershell
ssh root@1.12.224.119 "docker logs -f agent-bridge-relay --tail 50"
```

### 配对码不对/连不上
- 检查 `.env` 中的 `PAIRING_TOKEN` 是否正确
- 检查防火墙是否开放了 18790 端口（腾讯云控制台 → 防火墙）
- 检查容器是否在运行：`docker ps | grep agent-bridge-relay`
