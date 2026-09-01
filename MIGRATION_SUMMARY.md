# 本次改动简述 — Python 邮件生成 → Node.js/TypeScript

> 面向协作者的迁移简述。详细技术文档见 [`MIGRATION.md`](./MIGRATION.md)。
> 分支：`migration/python-to-nodejs-mailgen`（尚未合入 main，建议 review 后合并）

## 一句话

把后端唯一依赖 Python 的「邮件生成」子系统（`spawn('python3', scripts/mailgen.py)` + `backend/emailgen/` 包）改写为**同进程 TypeScript**，运行时不再需要 Python。前端、数据库、鉴权、IGDE 对话、SSE、Resend 发送等均未改动。

## 改了什么

| 模块 | 变化 |
|---|---|
| `backend/ts/*.ts` → `dist/` | 新增 TS 版 mailgen（config/data-loader/copy-generator/image-generator/image-overlay/email-builder/schema/mailgen/gallery） |
| `backend/server.js` | `generateMailHtml()` 由 `spawn('python3')` 改为同进程 `require('./dist/mailgen').run(payload)` |
| `backend/package.json` | 新增依赖 `@napi-rs/canvas` / `js-yaml` / `zod`，devDeps `typescript`/`@types/*`；`build`/`selftest`/`gallery` 脚本 |
| `backend/Dockerfile` | 改多阶段：build 阶段 `tsc`→`dist`，运行阶段 `npm ci --omit=dev` + `fonts-dejavu-core` |
| `backend/.dockerignore` | 忽略 `dist/`、`output/` |
| `scripts/start_local_dev.sh` | 后端启动前 `npm install`+`npm run build`，并起 `tsc --watch` 热编译 |
| `backend/test/mailgen.test.js` | 新增 2 例回归（fallback/skip、igde_pass_through） |
| `MIGRATION.md` | 新增完整迁移文档 |

## 删除了什么

- `backend/emailgen/`（整包 11 个 .py）
- `backend/scripts/mailgen.py`、`backend/scripts/build_st5_gallery.py`
- `backend/requirements.txt`
- `emailgen_config.yaml` 从 `emailgen/` 移到 `backend/` 根

## 兼容性

- **API 契约零改动**：`server.js` ↔ mailgen 的 JSON 结构（`html`/`image_path`/`subject`/`body`/`copy_provider`/`image_method`/`warnings`/`config_source`）逐字段保留；`/api/draft`、`/api/image/:path`、前端 `EditModal` 调用全部不变。
- **数据库**：不涉及。
- **HTML 模板逐字节等价**：`--selftest` 输出与旧 Python 版完全相同。

## 依赖映射

`requests`→Node `fetch`+`AbortController`；`Pillow`→`@napi-rs/canvas`；`PyYAML`→`js-yaml`；Pydantic→`zod`。

## 合作者需要知道的开发变化

```bash
# 后端首次启动前多一步 build（生成 dist/，server.js 要 require 它）
cd backend && npm install && npm run build

# 一键开发脚本已自动处理（装依赖 + build + tsc --watch 热编译）
./scripts/start_local_dev.sh

# 测试 / 自检
npm test          # pretest 自动 build
npm run selftest  # 离线自检（等价旧版 python --selftest）
```

## 验证结果

- `tsc` strict：0 错误
- `npm test`：41/41 通过
- `--selftest`：与旧 Python 版逐字节一致
- 全链路（Pollinations 下载 + 文字叠加 → `_final.png` → HTML 含 `<img>`）端到端通过
- Next.js build / lint 通过
- 运行时 0 个 `.py` 文件、0 处真实 `python3` 调用

## 有意保留的差异

1. `email_sender.py`（SMTP/Brevo 直发）**未移植**——真实发送一直在 Node 侧走 Resend，该模块从未接入运行时。
2. 图片叠加：Pillow 与 `@napi-rs/canvas` 字体度量无法逐像素一致，但渲染契约一致（折扣徽章 + CTA + 品牌，senior/非 senior 双模式）。
