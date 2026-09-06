# Migration: Python 邮件生成子系统 → Node.js + TypeScript

## 原始架构

CartBack v3 本就是前后端拆分：

- **前端**：Next.js 15 + TypeScript + Tailwind（App Router, standalone）。唯一对外端口 3000，
  通过 `next.config.ts` 的 `rewrites` 把 `/api/*` 反向代理到后端。
- **后端**（`backend/`）：零依赖原生 `http` 服务（`server.js` + `lib/*.js`，CommonJS，
  Node 22 `node:sqlite`）。端口 4173（dev）/ 4180（docker）。

迁移前唯一的 **Python 运行时依赖**：`server.js` 的 `generateMailHtml()` 用
`child_process.spawn('python3', ['scripts/mailgen.py'])` 起子进程，stdin 传 JSON、stdout
取一行 JSON。该 Python 脚本与 `backend/emailgen/` 包负责：

| Python 模块 | 职责 | 关键依赖 |
|---|---|---|
| `scripts/mailgen.py` | CLI 入口（run / --selftest / --selftest5） | — |
| `emailgen/config.py` | 多源配置（YAML + env + Node 注入） | pyyaml |
| `emailgen/data_loader.py` | UserRecord / from_plan_card | — |
| `emailgen/copy_generator.py` | LLM 文案（DeepSeek/MiniMax）+ 图片 prompt 构建器 | requests |
| `emailgen/image_generator.py` | 万相文生图 / Pollinations 兜底 / 下载 | requests |
| `emailgen/image_overlay.py` | Pillow 叠加折扣/CTA/品牌文字 | Pillow |
| `emailgen/email_builder.py` | HTML 邮件模板 | — |
| `emailgen/email_sender.py` | SMTP/Brevo 直发（**未接入运行时**，仅离线脚本） | smtplib/requests |
| `scripts/build_st5_gallery.py` | selftest5 画廊缩略图（base64 内嵌） | Pillow |

> 真实发送（Resend ESP）一直在 `server.js` 用 fetch 直连完成，Python `email_sender.py`
> 从未接入运行时；本仓库其余 `/api/*`（IGDE 对话、鉴权、存储、SSE 流式、归因等）本就是
> Node.js，不在本次迁移范围。

## 最终架构

- **前端**：Next.js 不变。
- **后端**：仍是单进程原生 `http`（`server.js` + `lib/*.js`），但 `generateMailHtml()`
  改为 **同进程** 调用编译后的 TypeScript 子系统 `require('./dist/mailgen').run(payload)`，
  不再 spawn Python。mailgen 子系统用 TypeScript 重写于 `backend/ts/`，经 `tsc` 编译到
  `backend/dist/`。

### 新增运行时依赖（`backend/package.json`）

| 包 | 用途 | 替代的 Python 依赖 |
|---|---|---|
| `@napi-rs/canvas` | 图片文字叠加（roundRect/measureText/fillText/strokeText） | Pillow |
| `js-yaml` | 解析 `emailgen_config.yaml` | pyyaml |
| `zod` | mailgen payload schema 校验 | Pydantic（手写校验） |

devDependencies：`typescript` / `@types/node` / `@types/js-yaml`（仅构建期）。
Node 22 全局 `fetch` + `AbortController` 替代 `requests`。

### Python → Node 子系统映射

| Python | TypeScript | 说明 |
|---|---|---|
| `emailgen/config.py` `load_config` | `ts/config.ts` `loadConfig` | 同优先级：Node 注入 > env > YAML > 默认 |
| `emailgen/data_loader.py` `UserRecord.from_plan_card` | `ts/data-loader.ts` `fromPlanCard` | 字段/默认值逐一对齐 |
| `emailgen/copy_generator.py` `generate_copy` | `ts/copy-generator.ts` `generateCopy` | 直通/LLM/fallback 三路；prompt 文本逐字对齐 |
| `generate_image_prompt` | `generateImagePrompt` | 风格表/语言表/55+ 门控规则对齐 |
| `emailgen/image_generator.py` | `ts/image-generator.ts` | 万相→Pollinations→下载→overlay 三级降级 |
| `emailgen/image_overlay.py` | `ts/image-overlay.ts` | senior(55+) 保留横条+实底 CTA；非 senior 投影+描边 |
| `emailgen/email_builder.py` `build_email_html` | `ts/email-builder.ts` `buildEmailHtml` | 模板逐字节对齐（含 `%%`→`%`、`html.escape(quote=True)`） |
| `scripts/mailgen.py` | `ts/mailgen.ts` | `run()` / `--selftest` / `--selftest5 [--with-image]` |
| `scripts/build_st5_gallery.py` | `ts/gallery.ts` | `node dist/gallery.js` |

## 兼容性

### API 兼容
`server.js` ↔ mailgen 的契约为一个 JSON 对象（`html`/`image_path`/`subject`/`body`/
`copy_provider`/`image_method`/`warnings`/`config_source`）。TS `run()` 返回完全相同的结构，
`generateMailHtml()` 的下游处理（`draft.html`、`draft.image_path`、`mailgen_meta`、
`logEvent('mailgen_result')`、subject/body 仅在 Agent 空串时回填）零改动。

`/api/draft`、`/api/image/:path`、前端 `EditModal`（`image_path` → `/api/image/<enc>`）的
对外行为均未变。前端 Next.js 调用零改动。

### 数据库兼容
本次迁移不涉及数据库 / ORM / schema —— mailgen 只读写本地图片文件（`backend/output/images/`）
与可选 YAML 配置。SQLite（`lib/store.js`）未触碰。

### 图片叠加一致性
Pillow 与 `@napi-rs/canvas` 字体度量不同，叠加层无法逐像素一致；但行为契约一致：
底部居中渲染折扣 `N%` + `OFF` + CTA 按钮 + 品牌名，且 senior(55+) 保留黑色横条 + 橙色实底
按钮、非 senior 改用投影 + 白色描边（无实底）。两者均在画布/字体不可用时降级返回原图。

### 环境变量
无新增运行时环境变量。原 `CARTBACK_DEEPSEEK_KEY` / `CARTBACK_WANX_KEY` / `CARTBACK_AI_CONFIG`
等 env 仍由 `config.ts` 读取（与 Python 一致）。`requirements.txt` 已删除。

### 运行时不再需要 Python
生产运行镜像（`backend/Dockerfile`）只含 Node + 3 个 npm 运行时依赖 + `fonts-dejavu-core`
（供 canvas 文字叠加用系统字体）。`emailgen/`、`scripts/*.py`、`requirements.txt` 均已移除。

## 安装 / 开发 / 构建 / 测试 / 生产

```bash
# 开发（前后端分离热更新：后端 ts/ 改动自动重编译 + node --watch 重启）
./scripts/start_local_dev.sh

# 手动
cd backend
npm install          # 装 typescript 等 devDeps + 运行时依赖
npm run build        # tsc → dist/（require('./dist/mailgen') 所需）
npm start            # node server.js  （需先 build；缺失会给出明确错误）
npm test             # pretest 自动 build，再 node --test
npm run selftest     # 离线自检：fallback 文案 + skip 图（与旧版 python --selftest 等价）
npm run gallery      # selftest5 画廊（需先跑过 --selftest5 生成图片）

# 前端
cd frontend && npm ci && npm run dev   # :3000，.env.local: BACKEND_URL=http://localhost:4173

# 生产（Docker 双容器，唯一对外 :3000）
docker compose up -d --build
```

### Docker 镜像构建说明
`backend/Dockerfile` 多阶段：build 阶段 `npm ci` + `tsc` 编译 `ts/`→`dist/`；运行阶段
`npm ci --omit=dev` 仅装 3 个运行时依赖 + `fonts-dejavu-core`，`COPY --from=build dist`。
`emailgen_config.yaml` 在 backend 根目录（运行时 YAML 兜底）。

## 验证（已执行）
- `npm install` / `npm ci --omit=dev`：成功（3 个运行时依赖 + canvas 二进制正确解析）。
- `npm run build`（tsc strict）：成功，0 类型错误。
- `npm test`：41 项全部通过（含新增 `test/mailgen.test.js` 两例：fallback/skip 与 igde_pass_through 直通）。
- `node dist/mailgen.js --selftest`：与旧版 `python3 scripts/mailgen.py --selftest` 输出
  **逐字节相同**（`full dict equal: True`，html_len=2981）。
- 图片叠加：senior / non-senior 两模式均产出有效 PNG（含折扣/CTA/品牌），与 Pillow 行为一致。
- `node dist/gallery.js`：成功生成 `output/st5_gallery_1.html` / `_2.html`。
- 后端 `/api/draft` 端到端：fallback 文案 + skip 图 / pass-through 两路径均正确返回。

## 有意保留的差异
1. **`email_sender.py`（SMTP/Brevo 直发）未移植**：CartBack 真实发送在 Node 侧经 Resend
   完成（含限频/重试/归因），Python `email_sender` 从未接入运行时——故按「能力已证伪」处理，
   不移植、不保留。
2. **`UserRecord` uid 兜底哈希**：Python 用进程随机的 `hash()`，TS 用确定性哈希；仅在既无
   `draft.id` 又无 `card.id` 时触达，正常 `/api/draft` 路径 `draft.id` 恒存在，无行为差异。
3. **图片叠加字体度量**：见上「图片叠加一致性」。
