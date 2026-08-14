# CartBack v3 — 前端镜像（Next.js standalone，反代 /api/* 到 backend）
# 多阶段：deps → builder → runner。
#
# ⚠️ 关键：Next standalone 生产模式下 rewrites() 仅在 `next build` 时执行一次，
#   process.env.BACKEND_URL 在构建期被烤进 routes-manifest.json，运行时不再读。
#   因此 BACKEND_URL 必须在 builder 阶段、npm run build 之前用 ENV 设定。
#   compose 内 backend 主机名稳定为 `backend`，此法成立。
#   （dev 由 next dev 启动时读 .env.local，走本机 4180。）

# 1) deps —— 安装依赖（利用层缓存）
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 2) builder —— 构建产物；BACKEND_URL 在 build 前烤入
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV BACKEND_URL=http://backend:4180
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# 3) runner —— 最小运行镜像
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BACKEND_URL=http://backend:4180

# standalone 产物自含一个 server.js + 最小 node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
