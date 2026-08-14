# CartBack v3 — 前后端拆分版

跨境电商会话式邮件挽回 Agent。本仓库把原单体（`archive/cartback-deploy_20260812/`）拆成：
**Next.js 前端** + **零依赖原生 `http` 后端（IGDE 引擎）**，用 **Next 反向代理单入口**对外。

> 原单体保存在 `archive/cartback-deploy_20260812/`，仅作历史对照，不删不改。

## 目录结构

```
cartback/
├── docker-compose.yml          # 双容器编排（唯一对外端口 :3000）
├── README.md                   # 本文件
├── docs/                       # 产品、设计与架构文档
│   ├── product/                # PRD
│   ├── design/                 # UI 设计源
│   └── architecture/           # Agent / 后端架构设计
├── archive/
│   └── cartback-deploy_20260812/ # 原单体快照（对照，勿改）
├── backend/                    # 纯 API 服务（IGDE 引擎 / 鉴权 / 存储）
│   ├── Dockerfile              # node:22-slim，无 public/
│   ├── package.json            # 零依赖
│   ├── server.js               # 仅 /api/*，静态托管已剥离
│   ├── lib/                    # config/store/auth/igde/llm/storeConnector（逐字节搬）
│   └── deploy/init-key.sh      # 注入 DeepSeek key（默认走前端 :3000 代理）
└── frontend/                   # Next.js 15 + TS + Tailwind（App Router standalone）
    ├── Dockerfile              # 多阶段 standalone；BACKEND_URL 构建期烤入
    ├── next.config.ts          # rewrites /api/* → ${BACKEND_URL}/api/*
    └── src/{app,components,lib,state}
```

## 拓扑：Next 反向代理 · 单入口

```
浏览器  ──:3000──▶  frontend (Next standalone)
                        │ rewrites /api/*  (构建期烤入 BACKEND_URL)
                        ▼──:4180──▶  backend (原生 http /api/*)
                                        │
                                        ▼  ./server-data/.server/  (volume)
```

- 唯一对外端口 **3000**；backend 仅容器网络内可见。
- **同源 Cookie 鉴权零改动**：反代后浏览器始终同源，`cb_session` 自动随请求带。
- SSE 流式（`/api/act/:id/message/stream`）穿透 Next 反代，打字机效果保留；前端有一次性 `/message` 降级兜底。

## 快速开始（Docker，推荐）

一键构建前后端镜像：

```bash
./scripts/build_docker_images.sh
```

指定镜像标签，或同时导出成一个可搬运的 tar 包：

```bash
./scripts/build_docker_images.sh v1.0.0
EXPORT_IMAGES=1 ./scripts/build_docker_images.sh v1.0.0
```

一键构建、启动并执行健康检查：

```bash
./scripts/deploy_docker.sh
```

指定标签和宿主机端口：

```bash
PUBLIC_PORT=8080 ./scripts/deploy_docker.sh v1.0.0
```

部署脚本会保留 `server-data/`，不会清空已有配置、密钥或 SQLite 数据。镜像已提前构建时可使用 `SKIP_BUILD=1`。默认镜像名为 `cartback-backend:local` 和 `cartback-frontend:local`。

底层 Compose 命令仍可直接使用：

```bash
docker compose up -d --build
# 访问 http://localhost:3000
```

注入 DeepSeek key（密钥只经运行时 `/api/config` 注入，持久化到 volume，不落镜像/不落 compose）：

```bash
./backend/deploy/init-key.sh sk-xxxxxxxx
# 或直接在「设置」页填 AI 密钥
```

数据 / 密钥落宿主机 `./server-data/`（即 backend 容器的 `/app/.server/`）。

## 本地开发（前后端分离）

一键启动并启用前后端热更新：

```bash
./scripts/start_local_dev.sh
```

默认访问 `http://127.0.0.1:3000`。如果端口已占用，可直接覆盖：

```bash
BACKEND_PORT=14173 FRONTEND_PORT=13000 ./scripts/start_local_dev.sh
```

脚本会检查 Node.js、端口和前端依赖；缺少 `node_modules` 时自动执行 `npm ci`。按 `Ctrl+C` 会同时停止前后端及其热更新子进程。

也可以分别启动：

```bash
# 1) 后端（默认 :4173，与原单体一致；Docker 内由 ENV PORT=4180 覆盖）
cd backend
NODE_OPTIONS=--experimental-sqlite node server.js    # :4173

# 2) 前端（另开终端）
cd frontend
npm install
npm run dev                                          # :3000，.env.local 指向 localhost:4173
```

`.env.local` 内容：`BACKEND_URL=http://localhost:4173`。
`next dev` 每次启动重跑 rewrites，读 `.env.local`，dev 下正常代理。

> 端口说明：本地 dev 用后端原生默认 **4173**；Docker 里 `backend/Dockerfile` 用 `ENV PORT=4180` 覆盖，故 compose / 前端镜像内统一 **4180**。两套端口都与原项目一致，无需改 `server.js`。

## 关键技术注意点

1. **rewrites 构建期执行**：standalone 生产模式下 `rewrites()` 仅在 `next build` 时执行一次，`process.env.BACKEND_URL` 被烤进 `routes-manifest.json`。因此 `frontend/Dockerfile` 在 builder 阶段、`npm run build` 之前用 `ENV BACKEND_URL=http://backend:4180` 烤入（compose 内 `backend` 主机名稳定）。
2. **SSE 穿透代理**：`/api/act/:id/message/stream` 经 Next 反代逐 token 流式；若代理缓冲导致不流式，前端自动降级到一次性 `/message`。
3. **密钥隔离**：AI/ESP 密钥只在 `backend/.server/config.json`，绝不进前端、绝不进镜像层。
4. **后端逻辑零改动**：IGDE 引擎、护栏、FSM、鉴权、全部 `/api/*` 逻辑逐字节保留，仅剥离静态托管。

## 双容器运维

| 操作 | 命令 |
|---|---|
| 启动 | `docker compose up -d --build` |
| 查看日志 | `docker compose logs -f` |
| 重启前端 | `docker compose restart frontend` |
| 进入 backend 排查 | `docker compose exec backend sh` |
| 备份数据 | 备份 `./server-data/` |
| 完全清空 | 删 `./server-data/` 后重建（或在「设置」页重置） |

## 验收（端到端）

见原 [`archive/cartback-deploy_20260812/README_部署.md`](archive/cartback-deploy_20260812/README_部署.md) 第 5 节的 **6 句验收**（「你能干啥啊 / 我老婆不理我 / 我太持久了 / 我不知道啊 / 你人机吗 / 加购没付那拨人想挽回一下」）—— 验证 IGDE 接住/拉回/无死模板/进收集全正常。

## 项目文档

- [产品 PRD](docs/product/PRD_CartBack_v1.md)
- [UI 设计源](docs/design/CartBack_UI_v4_Elegance.html)
- [Agent 记忆、Eval 与 Benchmark 渐进式设计](docs/architecture/AGENT_MEMORY_EVAL_BENCHMARK_DESIGN.md)
- [文档索引](docs/README.md)
