# Agent Bridge Relay Dockerfile
# 云端 VPS 跑 relay 模式（ws:// + SQLite 持久化）
# 使用阿里云 Debian 镜像加速 apt-get（腾讯云服务器到国际网络慢）
FROM node:22-slim

WORKDIR /app

# 切换阿里云 Debian 镜像 + 安装 better-sqlite3 编译工具链
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null \
    ; apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 配置淘宝 npm 镜像加速 npm install
RUN npm config set registry https://registry.npmmirror.com

# 先复制 package*.json 利用 docker layer 缓存
COPY package*.json ./
RUN npm install

# 复制源码 + web 静态文件 + tsconfig
COPY src/ ./src/
COPY web/ ./web/
COPY tsconfig.json ./

ENV NODE_ENV=production

EXPOSE 18790

# relay 模式启动
CMD ["npx", "tsx", "src/index.ts", "--relay"]
