# CartBack v3 — 后端（纯 API）镜像
# 原生 http /api/* 服务 + 同进程 TypeScript mailgen 子系统（已从 Python 迁移）。
# 数据 / 密钥目录 (.server) 由 volume 持久化，绝不进镜像层。

# ---- 编译阶段：TypeScript → dist/ ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY ts ./ts
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-bookworm-slim

# Node 22 的 node:sqlite 仍为实验特性，需要该 flag 才能启用嵌入式 SQLite
ENV NODE_OPTIONS=--experimental-sqlite \
    PORT=4180

# @napi-rs/canvas 文字叠加需要系统字体；DejaVu 粗体覆盖 Linux 候选路径
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 仅复制运行必需文件（test/ 不进镜像，密钥目录 .server 由 .dockerignore 排除）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY --from=build /app/dist ./dist
COPY emailgen_config.yaml ./emailgen_config.yaml

# 预留数据目录并降权运行（node 用户是官方镜像自带的非 root 用户）
RUN mkdir -p /app/.server && chown -R node:node /app
USER node

EXPOSE 4180

# 健康检查：bootstrap 端点无需鉴权，200 即健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4180/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
