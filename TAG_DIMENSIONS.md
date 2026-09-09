# 消费者标签维度扩展（feat/tag-dimensions）

> 分支：`feat/tag-dimensions`　基于 `aadb891`　提交：`01a8486`

## 背景

CartBack 初始消费者标签只有 3 类（`intent` / `price_sensitivity` / `category_like`），由 `tags.js:tagsForAudienceRow` 纯规则打分。`email-automation` 测试流与 selftest5 5 套模拟画像（`mailgen.ts:177-218`）用到了一组人口/画像维度（gender / age_range / device / customer_segment / preferred_language / price_sensitivity 的 value-premium-standard 取值集），但只活在 mailgen/UserRecord 子系统，没进 audience 表、没进标签体系。本分支把这组维度纳为初始 audience 标签，并修正 price_sensitivity 取值冲突。

> 注：`lifestyle` 维度已由远程 `e005889` 以 `style_preference`（tech/fashion/business/outdoor）全栈实现，本分支不重复。

## 新增 / 调整

### 1. 新 tag_type（5 个，仿 `category_like` 防御式：字段缺失不造标签）

| tag_type | 取值 | 判定 | weight |
|---|---|---|---|
| `gender` | female/male/other | `normalizeGender`：F/M/O + 中文别名（女/男）归一 | 2 |
| `age_range` | 原样（18-24/25-34/35-44/45-54） | 原样透传 | 2 |
| `device` | 原样（iPhone 15 等） | 原样透传（不归一，型号太多） | 2 |
| `customer_segment` | new/returning/vip | `normalizeSegment`：只认三值，非法丢弃 | 3 |
| `language` | locale 主码（en/fr/de/zh…） | `localeToLanguage`：`en-US`→`en`，严格 2 字母主码 | 2 |

- **不进 `render.js:tierOf`**（折扣/紧迫/标准三档仍只由 `price_sensitivity`+`intent` 决定）；只喂 `tagDistribution` → `tagMixSummary` 影响变体生成 LLM 的措辞角度。
- 权重 ≤3，保证归因 +2 后仍低于 intent(8)/price(7) 顶格，不反客为主。

### 2. price_sensitivity 取值归一

画像侧 `value/premium/standard` 与现有 `high/mid/low` 冲突。在 `tags.js:priceTagValue` 内归一（`premium→high`、`standard→mid`、`value→low`），复用现有 tag_type，不改 audience.price 列、不改 storeConnector。

### 3. `preferred_language` 不造标签

与 locale 重叠（de-DE ↔ German），砍掉避免灌水。

## 改动文件

| 文件 | 改动 |
|---|---|
| `backend/lib/tags.js` | `priceTagValue` 接受 premium/standard/value；新增 `normalizeGender` / `normalizeSegment` / `localeToLanguage`；`tagsForAudienceRow` 产出 5 新维度；导出新 helper |
| `backend/lib/store.js` | `SCHEMA.audience` 加 `gender/age_range/device/customer_segment` 4 列（自动迁移 ALTER ADD COLUMN）；`seedAudience` 12 条轮转赋值 |
| `backend/server.js` | `parseCsv` / `store/sync` webhook / `recipientToAudience` 透传新字段（带归一）；manual 标签端点接受新 tag_type 并归一；启动补打分改为**一次性迁移**（meta `tag_dims_v2_migrated` 标记，老库升级补打新维度，不在每次启动重复重打）；**修复 posters/send 并发写竞态**（见下） |
| `backend/lib/variants.js` | `tagMixSummary` 改按 `tag_type` 去重取 count 最高代表值（兜底上限 10），防维度增多后把 `intent`/`price_sensitivity` 挤出 prompt |
| `frontend/.../AudienceDrawer.tsx`、`TagEffectPanel.tsx` | `TAG_TYPE_LABEL` 补 5 个中文标签（性别/年龄段/设备/客户分层/语种） |
| `frontend/src/lib/types.ts` | `Audience` interface 补 `gender/age_range/device/customer_segment` 可选字段 |
| `backend/test/tags.test.js` | 补 price 归一 + 5 维度有值/缺值/非法丢弃断言 + selftest5 全画像映射 test |

## 附带修复：posters / send 并发写竞态

`send-e2e` 测试原先在 `sentDraft.posters[0].file` 处偶发 `null`。根因：`upsertDraft` 是整行替换，而 `sendDraft` 持有 job 开头读的 stale 快照（posters 尚为 null），成功 upsert 时把 posters job 刚异步写入的数组整行覆盖回 null。

修法：新增 `upsertDraftPreservingAsync(draft)`，sendDraft 各 upsert 前从当前行刷新 `posters/html/image_path/variants` 等异步字段，避免覆盖。send-e2e 现 3/3 稳定通过。

## 验证

- 后端测试 `npm test`：83/83 全绿
- TS 类型检查 `npx tsc --noEmit`：通过
- 前端 `npm run build`：通过
- 端到端冒烟：删库重启，种子受众行带新列、`/api/audience/:id/tags` 含 8 条标签（intent + price + style_preference + 5 新维度）

## 数据源说明（新维度从哪来）

- **gender / age_range / device / customer_segment**：Shopify 标准客户数据**没有**这些字段，真实店铺拉取（`recipientToAudience`）时留空，`tagsForAudienceRow` 防御跳过。当前价值在 **种子 demo + CSV/webhook 导入透传**（CSV 头写 `gender`/`age_range` 等列即可识别）。
- **language**：取自 `audience.locale`（已有列，种子/连接器都带）。
- **lifestyle / style_preference**：远程已用 `row.style` 实现，CSV / webhook / manual 端点透传归一。
