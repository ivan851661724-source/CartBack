# CartBack PRD v5（最终目标态 · 定稿）

> 版本 v5.1 · 2026-09-06 · **取代 PRD v3 / v4，为产品唯一权威文档**。
> **文档结构**：§0 产品定义（角色/引擎/架构/模型/数据）→ §0.7 全局状态总览（已实现 vs 待实现）→ §1-6 六功能（每功能四段：目标 → 逻辑算法 → 已实现 → 待实现）→ §7 闸门 → §8 Non-goals → §9 里程碑。
> 状态标注：✅ 已实现（附代码证据）/ 🔲 待实现（附规模 S/M/L 与依赖）。执行排期见《开发落地排期_CartBack_v2_工程对标.md》。

---

## 0. 产品定义

### 0.0 角色定义（商家 vs 消费者，全员必读）

| 角色 | 是谁 | 在系统里做什么 | 数据载体 | 数据来源 |
|---|---|---|---|---|
| **商家 Merchant** | CartBack 的使用者：跨境电商独立站卖家（付费/登录主体） | 登录；对话说需求；点确认发送；看看板；微调方案 | `acts.needs`（商家需求）；一切私有数据挂 `user_id` | 商家自己说的话与操作 |
| **消费者 Consumer（收件人）** | 商家的终端客户：收到营销邮件的人 | **不登录、不感知 CartBack**，只收邮件 / 点链接 / 下单 | `audience` + `audience_tags`（消费者标签）+ `events`（行为流） | 店铺授权同步 + 系统打分 + 归因反哺 |

**两条铁律（验收逐条测试）**：
1. **商家「说」需求，系统「算」消费者**——商家对话只写 `act.needs`，绝不写消费者标签（`audience_tags.source` 只有 scoring / attribution / manual）。
2. **发给消费者的内容只由消费者数据决定**（locale、标签、行为）——商家的私话（G1）与工程遥测（G3）绝不进入消费者邮件。

### 0.1 一句话与核心引擎

**一句话**：让不懂邮件营销的跨境电商独立站卖家，像聊天一样把流失的订单捞回来——AI 静默采集商家需求、按消费者标签生成千人千面的邮件与海报、真实归因反哺，越用越准。

**核心引擎 = 标签飞轮**：邮件和海报是消耗品，消费者身上的标签是唯一持续增值的资产。六个功能 = 飞轮五环节 + 一个加速器：

```
  ① 机会发现 ──→ ② 对话采集 ──→ ③ 方案生成 ──→ ④ 送达触达 ──→ ⑤ 归因反哺
  (消费者标签    (商家需求：     (需求×消费者   (按消费者标签   (结果→消费者
   圈出人群)      活动意图)       标签出内容)    渲染变体)       标签加权)
                                ▲
                ⑥ 竞品雷达（加速器：套路卡 → ③④ 的输入）─┘
```

### 0.2 系统架构

```
┌────────────────────────────────────────────────────────────────┐
│ 前端（六模块）：对话(首页) · 邮件 · 数据 · 受众 · 竞品 · 设置      │
├────────────────────────────────────────────────────────────────┤
│ 应用层 services/：对话编排 · 方案/海报生成 · 发送编排 · 归因 · 竞品 │
├────────────────────────────────────────────────────────────────┤
│ 领域层（纯逻辑）：IGDE 引擎 · 护栏(L2正则+critic) · 归因 · 标签策略 │
├────────────────────────────────────────────────────────────────┤
│ 基础设施 infra/：                                                │
│  ModelGateway(llm.js 多provider) · render.js 渲染管线(心脏)      │
│  JobQueue(异步+幂等) · Breaker(熔断) · Auth · Repositories       │
│  Clients：ESP(Resend) · 店铺(StoreConnector) · 收集邮箱(inbound) │
│ 存储：SQLite(主)/JSON(回退)                                      │
└────────────────────────────────────────────────────────────────┘
```

**产品心脏 = 个性化渲染管线（lib/render.js，待实现）**，固定顺序不可变：

```
收件人切片(locale/tags) → 变体选择(按标签) → 语种渲染(en直出/非en翻译缓存)
→ 模板本地展开({{name}}/{{offer}}/单层if，零 LLM) → G0 正则拦截(含白名单) → 发送
```

裁决逻辑：LLM 只负责生成"模板/变体"（O(变体数)），发送时按收件人属性本地展开（零 LLM）——成本可控、输出稳定。不引第三方模板引擎（Liquid 等），极简占位符 + 单层 if 够用即止。

### 0.3 主数据流

```
店铺数据/CSV ─→ audience（locale/country）
                │ 同步时打分（scoring）──→ 消费者标签【来源一】
                ▼
① opportunities（高意向流失人群 = 圈定受众）
                │ 商家聊天（只产商家需求）
                ▼
② act.needs（受众/痛点/折扣/时机，静默采集）
                │ 四要素齐 → 弹确认标签
                ▼
③ drafts（输入 = 商家需求 × 消费者标签分布；posters ← wan2.6-t2i 异步生成）
                │ 确认即真发（Resend）
                ▼
④ render.js 渲染管线（变体 → 语种 → 模板展开 → G0）→ per-recipient 发送
                ▼
⑤ events（open/click/convert ← ESP 回执 + Shopify 订单 webhook）
                │ 归因 → 消费者标签加权【来源二：attribution】
                ▼
   行业基准库（匿名统计，跨店只出品类级聚合）▲ ⑥竞品邮件→策略卡→③的生成参考
```

### 0.4 模型层（ModelGateway 统一接入）

`lib/llm.js` 从单 provider 抽象为 `client(provider, model)` 分发；`config` 支持多组 key。接入表：

| 模型 | 用途 | 调用形态 | 成本策略 | 失败降级 |
|---|---|---|---|---|
| **qwen3.7-plus**（主对话，参赛口径） | 对话 + 需求采集 + 方案/变体生成 + 竞品拆解 | 结构化输出，一次出 `{reply, needs}` / `variants[3]` / 策略卡 JSON | 每 draft 调用一次 | 桩教练（已有）/ 全落标准变体 |
| deepseek-chat（备选 provider） | 可随时切回的主对话备选 | 同上 | — | 同上 |
| qwen3.6-flash | 护栏 critic（说教/越权/编造/私话泄漏精判） | 高频小调用 | — | fail-open 仅限 critic，生成链 fail-closed |
| qwen-mt-plus | 非 en 语种渲染 | translate，同 draft 同语言缓存复用 | 缓存 | 回落 en（G0 拦截保底） |
| wan2.6-t2i | 海报 3 款 | 图生，n=3/次，异步队列 | 确认时生成一次 | 占位 + 重试，不阻塞发送 |
| qwen3-vl-plus（P2） | 竞品海报视觉拆解 | 多模态 | 二期 | 跳过视觉字段 |
| text-embedding-v4 + qwen3-rerank | 套路库/基准库 RAG | 检索 + 重排 Top-3 | 量小 | 跳过注入直接生成 |

### 0.5 数据表

**现有 7 表**：acts（needs JSON）/ drafts（posters JSON 槽位）/ audience（locale/country）/ events / meta / users / sessions。
**新增 4 表**：

| 表 | 关键字段 | 说明 |
|---|---|---|
| audience_tags | tag_type(price_sensitivity/intent/category_like), tag_value, weight[0,10], source(scoring/attribution/manual), updated_at | 消费者标签；对话不写 |
| strategy_cards | competitor_name, theme_formula, angle, discount_range, timing, frequency, visual_style JSON, embedding_id | 竞品策略卡；user_id 隔离 |
| competitor_sources | name, mailbox, status, last_collected_at | 竞品源管理 |
| jobs | type, payload, status, dedupe_key, retry_count | 异步任务持久化 |

### 0.6 端点清单

现有 21 个（auth×5 / bootstrap / state / act / opportunities / draft / drafts / audience / audience/import / store×3 / config / attribution / metrics / reset / export）+ 新增：
`POST /api/posters` · `GET/PUT /api/audience/:id/tags` · `GET/POST/DELETE /api/competitors` · `POST /api/competitors/inbound` · `GET /api/strategy-cards` · `GET /api/jobs/:id`（前端轮询）· `POST /api/draft/:id/send` 改 202 入队。

### 0.7 全局状态总览（2026-09-06 代码盘点 → 2026-09-07 实施更新）

| 模块 | 状态 | 待实现要点 |
|---|---|---|
| ① 机会发现 | ✅ 主体完成 | 随 T0.1 真实数据源接入即全量生效（同步打分已接：import/sync/pull 全部 scoring） |
| ② 需求采集 | ✅ 完成 | 确认卡受众圈选条件展示 ✅ · 未触发确认主动轻提示 ✅ |
| ③ 方案生成 | ✅ 代码就绪 | 真发 202 入队 ✅ · 海报管线 /api/posters ✅（wanx + canvas 占位降级，缩略图/换一批 UI ✅）· 72h 频控 ✅ · 预检+失败分类 ✅；G2 端到端已用 mock Resend 集成测试验证（test/send-e2e.test.js：202→渲染→批量逐收件人→回执→订单→退款→退信→标签反哺全链路），公网部署后换真实 ESP 即可 |
| ④ 渲染管线 | ✅ 完成 | lib/render.js 全量管线 ✅ · 变体三档 lib/variants.js ✅ · G0 拦截+白名单 ✅（设置页维护）· 按人群/语言预览 ✅（/api/draft/:id/preview + 编辑器 UI）· 被拦截标红+原因 ✅ |
| ⑤ 归因反哺 | ✅ 代码就绪 | Resend/Shopify webhook 映射 ✅ · 退款扣减+bounced 剔除 ✅ · order_id 幂等 ✅ · 标签加权服务 ✅ · 基准库聚合 ✅（embedding RAG=P2）· 标签效果 UI ✅；真连验证待部署 |
| ⑥ 竞品雷达 | ✅ MVP 全链路 | 手动粘贴 MVP ✅ · inbound webhook（token 鉴权）✅ · 预过滤 ✅ · 拆解（LLM+启发式降级）✅ · 检索接入③ ✅ · 竞品页 ✅ · G6 30 天清除 job ✅；转发制收集依赖公网部署 |
| 底座 | ✅ 主体完成 | ModelGateway（llm.js client() 多 provider）✅ · JobQueue（jobs 表+幂等+恢复）✅ · Breaker（llm/esp/poster）✅ · /api/health ✅；登录页剩余+部署属 M2 |
| 测试 | ✅ 74 全绿（存量 41 + 新增 33） | render ✅ · g0-intercept ✅ · queue ✅ · breaker ✅ · isolation ✅ · g6-purge ✅ · send-e2e（G2 全链路）✅ · gateway-benchmark ✅ |

> **2026-09-07 实施记录**：本节按当日代码实况修订。翻译环节当前经 ModelGateway 用主模型完成（qwen-mt-plus 专项接入与视觉拆解 qwen3-vl-plus 为 P2）；发送链路改为 `POST /api/draft/:id/send` 202 入队 + `GET /api/jobs/:id` 轮询，幂等键 `send:{userId}:{draftId}`，前端已同步。UI 已浏览器实测：竞品页（粘贴→拆解→策略卡）、设置页白名单、邮件页海报缩略图+按人群/语言预览均正常。实施中发现并修复两个存量缺陷：audience 表 `at_risk_at` 列缺失导致 SQLite 丢失流失时间（intent 全部误判 hot）；中文受众描述曾作为 product 事实进消费者邮件触发 G0 全拦（渲染期对非中文语种收件人的中文姓名改用邮箱前缀称呼）。

---

## 1. 功能① 主动发现挽回机会

**目标**：打开 3 秒内看见"还有 N 拨高意向客户未挽回 + 预估可挽回 GMV"；新流失主动提醒。验收：真店数据接入后机会卡片数字随真实数据变化。

**逻辑与算法**：
1. 打分（店铺同步时计算，写 audience + audience_tags，source=scoring）：`intent` 加购未付>下单未付>浏览未买>仅访问；`risk` 距流失越久越高；`price` 折扣订单占比 ≥40%→high / 10-40%→mid / <10%→low；intent 时效 ≤7 天→hot / 8-30 天→warm。
2. 过滤：真实邮箱 且 未转化 且 挽回窗口 30 天。
3. 预估 GMV = 弃购金额 × 类目挽回率基准（RECOVERY_RATE），全程标注「预估」。
4. 纯规则打分，AI 不参与（可解释）。

**已实现** ✅：机会卡片 +「捞一波」链路（`/api/opportunities`）；RECOVERY_RATE 类目基准（store.js）；audience 打分字段；假种子 + CSV 导入兜底；新流失提醒。

**待实现** 🔲：无新开发——随 T0.1 真实店铺接入自动全量生效。

**UI（目标态）**：对话页机会卡片（与聊天共享会话，G4）；受众页真实清单 + 画像抽屉「消费者标签区」（chips + 权重 + 来源，手动改后 source=manual 不再被覆盖）。

## 2. 功能② 对话式需求采集（商家的话 → 活动需求）

**目标**：商家说清诉求后 `act.needs` 四要素齐 → 自动弹确认标签；全程无表单、无必填项、无进度条。

**边界（铁律 1 执行点）**：只采集商家需求；人群判断仅作受众圈选条件传给③，不写任何消费者标签。

**逻辑与算法**：
1. qwen3.7-plus 一次调用出 `{reply, needs}`（结构化输出，与话术解耦：要点无条件落库，话术不合格只换话术）。
2. 跨轮去重：已明确字段不重复追问，除非用户否认。
3. AI 漏抽 → 关键词启发式兜底（折扣正则 `\d+%|打?\d+折|\$\d+`），保证四要素迟早集齐。
4. 四要素齐 + 无明显缺失 → 弹确认标签；聊了半天未触发 → 主动轻提示；AI 离线 → "发挽回吗？"一句话确认，闭环不报错。

**已实现** ✅：igde.js 静默采集四要素 + applyNeeds 无条件落库 + 跨轮去重；确认标签弹出（方案卡）；critic 护栏 + L2 正则；AI 离线降级。

**待实现** 🔲：确认标签卡补「受众圈选条件」展示（S）；未触发确认的主动轻提示（S）。

**UI（目标态）**：对话页开放聊天框；确认标签为对话流内嵌卡片（非独立页），含受众圈选条件核对。

## 3. 功能③ 标签驱动的方案生成（含万象海报）

**目标**：确认标签弹出后，点「确认发送」= 真实发出（G2），一次点击；方案含受众/主题/正文/折扣/独立优惠码/3 款海报。

**输入**：商家需求（needs）× 消费者标签分布——需求定"发什么"，标签定"对谁说什么"。

**逻辑与算法**：
1. 方案生成：qwen3.7-plus 出方案 JSON；检索套路库/基准 Top-3 注入参考（RAG，可跳过）。
2. 优惠码独立生成、唯一绑定 draft（归因反查依据）。
3. 海报：确认弹出时入队异步生成——wan2.6-t2i n=3/次；prompt = 商品+品类+折扣醒目+品牌调性+1200×600+负向词；URL 24h 过期 → 转存；回写 drafts.posters；失败 → 占位+重试，不阻塞发送。
4. 发送：202 入队（幂等键 `send:{userId}:{draftId}`）；72h 内同收件人同活动不重发（频控）；发送前预检（域名验证/邮箱格式/限额），失败分类人话提示。

**已实现** ✅：方案卡生成（/api/draft，estGmv/独立优惠码）；fetchResend 真发分支代码 + 指数退避重试 ≤3；drafts.posters 槽位。

**待实现** 🔲：ESP 配置端到端验证（G2，M）· 海报生成管线 `/api/posters` + 转存（M，依赖队列）· 72h 频控（S）· 发送前预检 + 失败分类（S）。

**UI（目标态）**：确认标签卡：方案摘要 + 3 款海报缩略图（换一批/大图/单选）+ 受众圈选条件；设置页 ESP 区「已连接 · 域名已验证」；未配置 ESP 时发送按钮置灰引导。

## 4. 功能④ 千人千面 + 语种跟随（渲染管线消费方）

**目标**：同一活动，不同消费者标签的收件人收到不同变体；全部收件人母语化、零非白名单中文（G0）。

**逻辑与算法（全走 render.js 管线，§0.2）**：
1. 变体分档（硬编码三档）：price_sensitivity=high → 折扣主打；intent=hot → 紧迫（弱折扣）；其余 → 标准。qwen3.7-plus 一次出 `variants[3]`（{tier, subject, body}），只换角度不换事实。
2. 语种：locale 回落链 customer.locale → country 映射 → en；en AI 直出，非 en qwen-mt 翻译（同 draft 同语言缓存）；变体失败全落标准变体。
3. 模板本地展开：{{name}}/{{product}}/{{offer}}/{{coupon}} 按收件人填充 + 单层条件，零 LLM。
4. G0 拦截：逐封正则 `/[\u4e00-\u9fff]/` 扫主题/正文/优惠码说明；**白名单**：商家在设置页维护品牌名/专有名词（含中文品牌名），白名单内不拦截；命中非白名单 → 该封不发送 + 标红告警。

**已实现** ✅：storeConnector 的 locale 架构（recipientLang/renderForRecipient，语种跟随设计已修）；audience 的 locale/country 字段（真实源已带）。

**待实现** 🔲：render.js 管线全量（L，产品心脏）· 变体生成 + 三档映射（M~L）· G0 拦截 + 白名单（S）· UI：按人群预览 / 语言预览 / 白名单维护入口（M）。

**UI（目标态）**：邮件编辑器「按人群预览」+「语言预览」（语言分布+样例）；确认卡显示"按 3 类人群生成 3 个变体"；被拦截邮件标红+原因；设置页白名单维护。

## 5. 功能⑤ 真实归因 + 标签反哺（结果 → 资产）

**目标**：看板数字全部来自真实事件；转化结果自动给消费者标签加权；跨店出匿名基准。

**逻辑与算法**：
1. 回执：Resend webhook（delivered/open/click/bounced）→ /api/attribution（x-webhook-secret 校验）。
2. 订单：Shopify orders/create → discount_codes 命中本系统优惠码 → convert；orders/update 退款 → GMV 扣减。
3. 归因优先级：优惠码核销（不限窗口）＞ 点击后 7 天窗口（可配）＞ 不归因（宁漏勿错）；`order_id` 幂等。
4. 卫生：bounced → `email_invalid` 自动剔除后续名单（保护域名信誉）。
5. ROI = GMV /（发送成本 + 折扣成本），口径进 tooltip。
6. 标签加权：convert → 全部标签 w += 2；窗口期满未转化 → w −= 0.5；截断 [0,10]。
7. 基准库：品类 × 标签组合 × 折扣档 → 转化率；样本 ≥5 才出数；匿名聚合；embedding 入库供 RAG。

**已实现** ✅：仿真归因（演示模式）；/api/attribution webhook 端点 + x-webhook-secret + 优惠码核销归因逻辑；数据页六宫格 KPI + 漏斗 + 趋势。

**待实现** 🔲：Resend / Shopify webhook 真连 + 事件映射（M~L）· 退款扣减 + bounced 剔除（S）· 标签加权服务（M，依赖 T3.2 标签）· 基准库 RAG（M）· 「标签效果」UI（S）。

**UI（目标态）**：数据页数据源标识（演示/真实颜色区分）+ 标签效果区块（Top5 + 样本数）+ 异常条（webhook 断连 >24h 提示）。

## 6. 功能⑥ 竞品邮件雷达（加速器）

**目标**：竞品验证过的打法变成本店策略卡，生成时引用；原始内容不出库。

**逻辑与算法**：
1. 收集：每用户唯一收集地址 `scan+{uid}@域名`（转发制，依赖公网部署）；**MVP 降级版 = 手动粘贴竞品邮件原文**（不依赖部署，参赛演示可用）。
2. 预过滤（规则）：退订链接 AND 促销词 → 营销邮件；订单/物流通知 → 丢弃。
3. 拆解：qwen3.7-plus 输出策略卡 `{theme_formula, angle, discount_range, timing, frequency, visual_style}`（允许 null）；海报视觉拆解 qwen3-vl-plus 二期。
4. 引用：卡片 embedding 入库；③生成时检索同品类 Top-3 注入；确认卡显示"已参考 N 张套路卡"。
5. 合规（G6）：学结构不抄文案；原文仅存 30 天（定时 job 清除，保留卡片）；user_id 隔离；跨店只出匿名统计。

**已实现** ✅：无（全新功能）。

**待实现** 🔲：收集入口——手动粘贴 MVP（M）→ 转发制 inbound webhook（M，依赖部署）· 预过滤规则（S）· 拆解编排（M）· 检索接入③（S）· 「竞品」页 UI（六模块外壳扩展，M）· 30 天清除 job（S）。

**UI（目标态）**：第六模块「竞品」页：源管理列表 + 添加 + 收集地址复制；策略卡卡片列表；确认卡引用提示。

---

## 7. 信任闸门（上线验收，缺一不放行）

| 闸门 | 标准 |
|---|---|
| G0 语种 | 消费者邮件零非白名单中文；主题/正文/优惠码说明/海报文案全过拦截 |
| G1 私话隔离 | 商家对话内容不进消费者邮件（critic + 正则双查） |
| G2 一键真发 | 确认发送一次点击 = 已发送（非 draft） |
| G3 无遥测暴露 | 护栏命中/工程状态不出现在商家 UI |
| G4 会话共享 | 机会按钮与聊天同一会话，确认标签是唯一收敛点 |
| G5 好消息含成本 | 回报含「捞回 ¥X · 触达 N 人 · 花费 ¥Y」 |
| G6 竞品合规 | 学结构不抄文案；原文 30 天清除（job + 测试用例）；不跨店 |

## 8. Non-goals

不做：可见进度条/必填项/刚性流程；用户手动配 flow/分群；可视化规则引擎（分段 = 对话 needs）；第三方模板引擎（Liquid）；A/B 测试与多品牌（P2 后）；竞品爬虫/原文跨店/抄文案；多租户角色权限；微服务/K8s；AI 未确认直接发送。

## 9. 里程碑与上线判定

| 里程碑 | 内容 | 判定 | 预估（单人） |
|---|---|---|---|
| **M1** | 上线闭环：真店→真发→母语→真实归因 | 商家真正能用；可对外 Demo | ≈6 周 |
| **M2** | 公网上线：部署 + 底座 + 打磨 | 多商家注册可用 | ≈9 周 |
| **M3** | 六功能全集（含竞品雷达转发版） | 参赛/投资人完整叙事 | ≈12 周 |

**上线判定**：G0-G6 逐条过 + 真店全链路无人工干预 + 59 存量测试 + 新增测试（render / g0-intercept / queue / breaker / isolation / g6-purge）全绿。双人并行：主链 P0→P1→P2，副线 T3.x（除竞品转发版）。

---

## 附：文档关系

| 文档 | 关系 |
|---|---|
| PRD v3 / v4 | **被本文取代**，仅存档 |
| 环节算法定义 v1 | 算法细节已吸收进 §1-6，仅存档 |
| 开发落地排期 v2（工程） | 执行路径有效；按本文修订：T3.1 依赖改为队列（公网演示才需 T2.1）、T1.1 补 /api/jobs/:id、T0.1 同步时打分、M1 按 6 周承诺 |
