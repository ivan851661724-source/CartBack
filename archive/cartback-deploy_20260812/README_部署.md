# CartBack v3 — 服务器部署指南（Docker）

「易邮增长 v3」对话式流失挽回顾问，零依赖 Node 服务，Docker 化部署。

## 1. 交付物清单（传到服务器的目录）

```
代码块/
├── Dockerfile            # 镜像构建
├── .dockerignore         # 排除密钥/数据(.server) 进镜像
├── docker-compose.yml    # 编排：端口 4180 + 数据卷 ./server-data
├── deploy/
│   └── init-key.sh       # 一次性注入 DeepSeek key（不落镜像）
├── server.js
├── package.json
├── lib/                  # 引擎、配置、连接器
├── public/               # 前端 SPA
└── README_部署.md        # 本文件
```

> ⚠️ 不要把 `.server/`（密钥+数据）拷进镜像或提交仓库。`.dockerignore` 已排除。

## 2. 构建镜像

```bash
cd 代码块
docker build -t cartback:latest .
```

镜像要点：
- 基础 `node:22-bookworm-slim`，内置 `node:sqlite`（已开 `--experimental-sqlite`）
- 非 root 用户 `node` 运行
- 健康检查走 `/api/bootstrap`（无需鉴权）

## 3. 启动

```bash
docker compose up -d
```

- 服务暴露 `宿主机:4180 → 容器:4180`
- 数据/密钥持久化到宿主机 `./server-data`（容器内 `/app/.server`）
- `restart: unless-stopped`，崩溃/重启自动拉起

## 4. 注入 DeepSeek key（必做，否则走桩模型）

```bash
# 容器内服务已起后执行
./deploy/init-key.sh sk-你的真实key

# 若服务在另一台机器/端口：
# ./deploy/init-key.sh sk-你的真实key 192.168.1.10:4180
```

脚本只把 key 经运行时 `POST /api/config` 写入 volume 的 `.server/config.json`，**不进镜像、不进 compose**。

## 5. 验证「线上 = 源码」一致性

开浏览器访问 `http://<服务器IP>:4180/flow.html`，连发 6 句验收：

```
你能干啥啊 / 我老婆不理我 / 我太持久了 / 我不知道啊 / 你人机吗 / 加购没付那拨人想挽回一下
```

期望：
- 第 1 句主业前置、无机械兜底；
- 第 2-5 句被接住拉回、不重复、无死模板；
- 第 6 句正常进收集；
- 全程无「我可能说太多了」死模板（若出现 = 跑的是旧构建，重新 `docker build`）。

或命令行快验：

```bash
curl -fsS http://localhost:4180/api/bootstrap | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('aiConfigured=',j.status.aiConfigured,'storeConfigured=',j.status.storeConfigured)})"
```

## 6. 接入店后台（可选，拉真实受众）

编辑宿主机 `./server-data/config.json`，加 `shopify` 或 `stores` 字段后重启容器：

```bash
docker compose restart
```

- Shopify：`shopify: { shopDomain: "xxx.myshopify.com", apiVersion: "2024-04", accessToken: "..." }`
- 独立站 REST：`stores: [{ type: "rest", baseUrl: "...", apiKey: "...", fieldMap: {...} }]`
- 未配置 → demo 模式（端点优雅返回，不崩）

## 7. 运维

| 操作 | 命令 |
|---|---|
| 看日志 | `docker compose logs -f cartback` |
| 重启 | `docker compose restart` |
| 升级（改了代码后） | `docker compose up -d --build` |
| 停服务 | `docker compose down` |
| 数据备份 | 备份宿主机 `./server-data/` 目录即可 |

## 8. 安全注意

- AI/ESP 密钥仅在**服务端** `.server/config.json`，绝不进前端、绝不进镜像层。
- 反向代理（nginx/caddy）建议前置：域名 + TLS + 基础认证，避免裸端口暴露公网。
- `localToken` 由服务首次启动随机生成并存在 volume，重启不丢；如需改 token 删 `server-data/config.json` 内 `localToken` 重启即重建。
