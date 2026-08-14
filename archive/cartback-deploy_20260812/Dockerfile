# CartBack v3 — 零依赖 Node 服务镜像
# 数据 / 密钥目录 (.server) 由 volume 持久化，绝不进镜像层。
FROM node:22-bookworm-slim

# Node 22 的 node:sqlite 仍为实验特性，需要该 flag 才能启用嵌入式 SQLite
ENV NODE_OPTIONS=--experimental-sqlite \
    PORT=4180

WORKDIR /app

# 仅复制运行必需文件（test/ 不进镜像，密钥目录 .server 由 .dockerignore 排除）
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 预留数据目录并降权运行（node 用户是官方镜像自带的非 root 用户）
RUN mkdir -p /app/.server && chown -R node:node /app
USER node

EXPOSE 4180

# 健康检查：bootstrap 端点无需鉴权，200 即健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4180/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
