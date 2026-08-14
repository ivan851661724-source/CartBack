import type { NextConfig } from 'next';

/**
 * CartBack v3 前端 —— Next.js 反向代理单入口拓扑
 *
 * 关键架构点（已用 Context7 核实 Next 15 standalone 行为）：
 *  rewrites() 仅在 `next build` 时执行一次，process.env.BACKEND_URL 在构建期
 *  被烤进 routes-manifest.json，运行时不再读取。因此：
 *   - dev：next dev 每次启动重跑 rewrites()，读 .env.local 的 BACKEND_URL。
 *   - docker：必须在 frontend/Dockerfile 的 builder 阶段、`RUN npm run build` 之前
 *             `ENV BACKEND_URL=http://backend:4180`，把容器网络主机名烤进镜像。
 *  带 protocol 的 destination 会被 Next 透明反向代理（含 SSE 流式），
 *  故 /api/act/:id/message/stream 的打字机效果可穿透代理 → 同源 Cookie 鉴权零改动。
 */
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4180';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
