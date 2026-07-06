# Agent Bridge Relay Dockerfile
# 云端 VPS 跑 relay 模式（ws:// + SQLite 持久化）
FROM node:22-slim

WORKDIR /app

# better-sqlite3 是 native module，需要 python3 + make + g++ 编译
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先复制 package*.json 利用 docker layer 缓存
COPY package*.json ./
RUN npm install

# 复制源码 + web 静态文件
COPY src/ ./src/
COPY web/ ./web/
COPY tsconfig.json ./

ENV NODE_ENV=production

EXPOSE 18790

# relay 模式启动
CMD ["npx", "tsx", "src/index.ts", "--relay"]
