# 邮件生成子系统（emailgen）集成说明

> 最后更新：2026-08-25 · 提交 `267c38a`（`origin/main`）
> 影响方：Node.js backend (`server.js`) + 商家设置页 (`/api/config`) + 所有调用 `scripts/mailgen.py` 的脚本 / CI

---

## 0. 一句话 TL;DR

把原本**散落在外部目录 `~/email-automation` + 只能用 Pollinations 免费图**的 Python 邮件脚本，
完整内聚到本仓库的 `backend/emailgen/`，升级为「IGDE 文案直通 / LLM 重写 / 万相定制图 /
Pillow 叠加 / HTML 合成」一条龙，商家**只在设置页录入一次 AI Key 即同时服务文案 + 图像**，
零配置时也能降级出图，绝不阻塞草稿生成主流程。

---

## 1. 为什么要做这次变更

1. **硬耦合外部路径**：原版 `backend/scripts/mailgen.py` 写死
   ```python
   sys.path.insert(0, os.path.expanduser("~/email-automation"))
   ```
   新机器 / 新同事 / Docker 容器跑起来直接 `ImportError`，完全不可复现。
2. **图像能力太弱**：仅用 `image.pollinations.ai`（公共免 Key 服务，随机、不保证质量、
   不支持品牌/折扣/CTA 定制文案），叠字依赖 Pillow 但没把包列进 requirements。
3. **AI 配置重复录入**：email-automation 自己的 `config.yaml` 要填一次 DeepSeek/万相 Key，
   CartBack 的 Node 侧 `~/.server/config.json` 又要填一次。两处不同步，排障困难。
4. **无自检 / 可观测**：脚本成功与否 Node 只看 `success=true`，不知道是走了 LLM 还是模板、
   是万相还是 Pollinations、哪一级降级触发，后续无法调优。

---

## 2. 本次新增 / 修改的文件清单

### 新增（emailgen 子系统）

| 文件 | 作用 |
|------|------|
| `backend/emailgen/__init__.py` | 包声明、公共导出列表 |
| `backend/emailgen/config.py` | 配置加载（**YAML + 环境变量 + Node stdin 注入**三层聚合，优先级依次升高） |
| `backend/emailgen/data_loader.py` | `UserRecord` 数据类 + `from_plan_card()` 工厂函数（直接吃 IGDE 方案卡） |
| `backend/emailgen/copy_generator.py` | DeepSeek 文案（主）+ MiniMax（备）+ 无 Key 时模板兜底；**IGDE 已有 subject+body 时直通零 Token** |
| `backend/emailgen/image_generator.py` | 万相文生图 → Pollinations 免费兜底 → 空图；下载到 `backend/output/images/` |
| `backend/emailgen/image_overlay.py` | Pillow 叠加折扣徽章 / CTA 按钮 / 品牌名；Pillow 缺失时自动降级不崩 |
| `backend/emailgen/email_builder.py` | HTML 模板渲染 + 严格 HTML 转义 + CID/URL 双模式 + **Python 3.9 兼容**（f-string 里无反斜杠） |
| `backend/emailgen/email_sender.py` | SMTP / Brevo 直邮（供离线脚本/批处理用，Node 真实发送仍走 Resend） |
| `backend/emailgen/utils.py` | 桌面通知（macOS/Linux/Windows 尽力而为） |
| `backend/emailgen/emailgen_config.yaml` | 配置模板（商家可在本文件 `# 密钥覆盖` 另存 `emailgen_config.local.yaml`，已加入 `.gitignore`） |
| `backend/requirements.txt` | Python 依赖：`requests` / `PyYAML` / `Pillow` |

### 修改

| 文件 | 改了什么 |
|------|----------|
| `backend/scripts/mailgen.py` | **v2 完全重写**。不再 import 外部 email-automation；stdin 扩展 10+ 字段；新增 `--selftest`；权威 stdout JSON + stderr 日志透传；结构化返回 `copy_provider / image_method / warnings / mailgen_meta` |
| `backend/server.js` `generateMailHtml()` | 透传 Node 侧持有的 `ai_config`（含 vision* 图像 Key）+ 品牌/CTA/URL；超时从 120s → 240s；新增 `mailgen_result` 结构化日志 + `draft.mailgen_meta` 持久化审计信息；Python 端 fallback 文案会回填 IGDE 原本为空的 `draft.subject/body` |
| `backend/lib/config.js` `DEFAULTS` | 新增 `shopBrand / shopCartUrl / visionKey / visionBaseUrl / visionModel / wanx*` 兼容别名 |
| `backend/server.js` `POST /api/config` | 新增对应字段的保存逻辑（商家在设置页填一次即可） |
| `.gitignore` | 补 `backend/output/**`、`emailgen_config.local.*`、`__pycache__/ *.pyc`、`venv/`（运行时大图像和密钥不入库） |

---

## 3. 运行时数据流（Agent → Draft 邮件）

```
  商家在 /chat 跟 IGDE 对话
    ↓ IGDE 产出 planCard { subject, body, discount, audience, ... }
  POST /api/draft { planCard }
    ↓
  server.js → generateMailHtml(draft, card)
    ↓ spawn python3 scripts/mailgen.py（stdin JSON）
        ├─ ai_config.provider=deepseek  → 复用 Node 的 AI Key
        ├─ ai_config.visionKey*         → 复用 Node 的万相 Key
        ├─ force_regen_copy             → 商家点"换一批文案"时置 True
        ├─ skip_image                   → 商家纯调试文案时置 True
        └─ product_image_path           → 商家上传自己的产品图时跳过 AI 出图
    ↓ mailgen.py 内部管线
        [1] config 聚合（YAML → 环境变量 → ai_config 覆盖）
        [2] UserRecord.from_plan_card(card)
        [3] copy_generator.generate_copy
              · IGDE 已有 subject+body 且 !force_regen_copy → 直通（provider=igde_pass_through, 0 token）
              · 否则 DeepSeek → MiniMax → fallback_template 三级降级
        [4] image_generator.generate_product_image
              · 有 visionKey+baseUrl → 调用万相（高质量定制图；可选 Pillow overlay_text）
              · 否则 Pollinations 免 Key 兜底 + 强制 Pillow 叠加折扣/CTA
              · 都失败 → 返回空字符串（邮件只显示头图占位）
        [5] email_builder.build_email_html（use_cid=false，image_url 直填绝对路径给 /api/image/:path 预览用）
    ↓ stdout JSON { success, html, image_path, subject, body, copy_provider, image_method, warnings, mailgen_meta }
  server.js 回填 draft.html / draft.image_path / draft.mailgen_meta
    ↓ store.upsertDraft
  返回前端 { draft, estGmv, matchedCount }
```

**发送**（未改）：`/api/draft/:id/send` 仍然走 Node 端 Resend / fetchResend 真实发送，
Python 端 email_sender.py 只给**离线批处理 / 本地 SMTP 脚本**作为备选通道。

---

## 4. 其他共创者 / Agent 需要注意的点

1. **部署（必做一次）**：在 backend 侧装 Python 依赖：
   ```bash
   cd backend && python3 -m pip install -r requirements.txt
   ```
   部署脚本 `scripts/deploy_docker.sh` / Dockerfile 如果之前没装 Python + pip，需要同步补上（本提交没改 Dockerfile，请部署方自行加上或提 PR）。

2. **配置一键复用（推荐）**：商家 UI 设置页填好文案 AI Key 后，把万相 Key 也直接通过
   `POST /api/config { visionKey, visionBaseUrl, visionModel }` 写进去即可，mailgen
   会自动取到，无需再改 YAML。不想走 UI 也可以设环境变量：
   ```
   CARTBACK_DEEPSEEK_KEY=sk-xxx
   CARTBACK_WANX_KEY=sk-yyy
   CARTBACK_WANX_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
   CARTBACK_WANX_MODEL=wan2.7-image-pro
   ```

3. **本地自检（推荐加入 git pre-push / CI）**：
   ```bash
   cd backend && python3 scripts/mailgen.py --selftest
   # 期望：stderr 打印 "[selftest] ✅ 成功" + stdout 打印 1 行 JSON，exit 0
   ```
   走 skip_image 模式，完全不依赖网络 / 密钥，可在 CI 跑。

4. **不要用 `python` 命令**：Node 端 `generateMailHtml` 写死调用 `python3`。如果目标
   机器 python3 不在 PATH（目前 TRAE 内置终端就是这种情况，需手动补
   `/usr/bin:/usr/local/bin`），请在系统层解决，不要再退回 `python`。

5. **原 `~/email-automation/` 目录**：本仓库已经完全自足，不再引用外部路径；那台机器上
   的 `~/email-automation` 可以当备份保留，或在确认无其他项目依赖后删除。

6. **本次未提交的改动**：`frontend/src/components/shell/Topbar.tsx` 的本地修改保留在工作区。
   如果那个改动也要入库，请另开一个独立的 PR/commit，不要跟邮件生成混在一起。

---

## 5. 验证结果（复现步骤）

两条命令都 exit 0 即代表环境 OK：

```bash
# 测试 A：无密钥无网（CI/自检场景）
cd backend && python3 scripts/mailgen.py --selftest

# 测试 B：IGDE 文案直通 + Pollinations 免费图 + Pillow 叠加（含出图，需外网）
cd backend
echo '{"subject":"Hi","body":"body","discount":15,"brand":"LeoPhoneCase","cart_url":"https://t.co/a"}' \
  | python3 scripts/mailgen.py
# 结果字段：copy_provider=igde_pass_through, image_method=pollinations+overlay, success=true
```

---

## 6. 后续可做（留给后续接手人）

- [ ] 配置设置页（Next.js `frontend/src/components/settings/SettingsView.tsx`）新增 3 个输入框：
      万相 Key / 万相 Base URL / 万相 Model；新增店铺品牌 / 默认购物车 URL 输入。
- [ ] `backend/Dockerfile` / `scripts/deploy_docker.sh` 补上 Python 3 + `pip install -r requirements.txt`
- [ ] Agent 在方案卡增加 `force_regen_copy: true` 选项（商家「换一批文案」按钮）
- [ ] emailgen 加离线 pytest：`backend/tests/` 下补 `test_copy_generator.py` /
      `test_email_builder.py` 等桩测试，锁住 Python 3.9 兼容
- [ ] 商家上传本地产品图 UI + POST `/api/draft` 携带 `product_image_path` 走「免出图直接叠加」快路径
