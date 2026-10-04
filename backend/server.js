'use strict';
/**
 * CartBack v3 — API Gateway / 服务端（零依赖 Node）
 * 职责（架构 §2 / §6）：AI/ESP 代理（密钥不落地）+ 护栏/critic
 *      + 数据持久化 + 归因回执接收 + 端点鉴权 + 真实发信护栏。
 * 注：前端已拆分为独立 Next.js 应用（../frontend），本服务为纯 /api 后端，不再托管静态资源。
 */
const http = require('http');
const url = require('url');
const cfg = require('./lib/config');
const { Store, uid } = require('./lib/store');
const igdeMod = require('./lib/igde');
const { IGDE, guardrailL2 } = igdeMod;
const needsMod = require('./lib/needs');
const execution = require('./lib/execution');   // Wave 2：D3 planCard 同源 / D4 五道闸门 / E2 建码决策 / holdout / E3 时区
const { LLMClient } = require('./lib/llm');
const { normalizeAgentProfile } = require('./lib/context');
const { buildConnectors } = require('./lib/storeConnector');
const authMod = require('./lib/auth');
// —— PRD v5 新增模块 ——
const render = require('./lib/render');
const variantsMod = require('./lib/variants');
const tagsMod = require('./lib/tags');
const benchmarkMod = require('./lib/benchmark');
const competitorsMod = require('./lib/competitors');
const { JobQueue } = require('./lib/queue');
const { sendSmtp } = require('./lib/smtp');
const { BreakerRegistry } = require('./lib/breaker');
const postersMod = require('./lib/posters');
// —— Wave 3 批次域（I1 并列批次 / I2 全局停发 / I3 未发部分操作 / I4 自动排除）——
const campaignsMod = require('./lib/campaigns');
const exclusionMod = require('./lib/exclusion');
// —— Wave 4 体验与记忆（F1 零配置开场 / F3 主动回执 / A3 商家记忆 / F2 对话内算账）——
const notify = require('./lib/notify');
// —— Wave 5 收口（A4 僵尸会话 / E1 冲动折扣大促季判定）——
const zombie = require('./lib/zombie');
const impulse = require('./lib/impulse');
// —— 商品库（批次 1 上传链路 / 批次 2 品类字段）：设置页上传，邮件 Hero 可直接选用 ——
const productsMod = require('./lib/products');

let config = cfg.load();
const store = new Store();
store.init();
// 店后台连接器集合（架构 §2 B1）：从配置构建；null = 未接入任何店，退化本地种子/演示
const connectors = buildConnectors(config);

// —— 熔断注册表（PRD §0.2）：llm / esp / poster 各自独立计数 ——
const breakers = new BreakerRegistry({ threshold: config.breakerThreshold || 5, cooldownMs: config.breakerCooldownMs || 30000 });

// —— G0 白名单（品牌名/专有名词，可含中文；商家在设置页维护）——
function g0Whitelist() {
  const base = Array.isArray(config.g0Whitelist) ? config.g0Whitelist : [];
  const brand = config.shopBrand ? [config.shopBrand] : [];
  return [...new Set([...brand, ...base].filter(Boolean))];
}

// —— 非en语种翻译（主对话模型统一出口；同 draft 同语言缓存复用）——
// 说明：qwen-mt-plus 为 P2 专属接入，当前经 ModelGateway 用主模型完成 translate
//（prompt 锁死「只输出译文」），失败回落 en 原文，G0 拦截保底。
const translationCache = new Map();
async function translateText(text, targetLocale) {
  if (!config.aiKey || !text) return text;
  const breaker = breakers.get('llm');
  try {
    return await breaker.exec(async () => {
      const client = makeLlmClient();
      const r = await client.chatStructured({
        messages: [
          { role: 'system', content: `You are a translation engine. Translate the user text into locale "${targetLocale}". Output ONLY the translation, no quotes, no explanation. Keep template placeholders like {{name}} and {{coupon}} exactly unchanged.` },
          { role: 'user', content: text }
        ],
        temperature: 0.2,
        maxTokens: 1024
      });
      const out = r && r.reply ? String(r.reply).trim() : '';
      return out || text;
    });
  } catch (e) {
    return text; // 熔断 open / 调用失败 → 回落 en 原文（PRD §4.2）
  }
}

// —— 异步任务队列（PRD §0.5 jobs / §0.6 /api/jobs/:id）——
const queue = new JobQueue({ store, concurrency: 2, baseDelayMs: 2000, maxRetries: 3, logger: logEvent });
queue.register('send_draft', (j) => processSendJob(j));
queue.register('send_campaign', (j) => processCampaignSendJob(j));   // Wave 3 I1：批次发送（复用 run_after 定时；勿绕过 _tick due 过滤）
queue.register('posters', (j) => processPosterJob(j));
queue.register('g6_purge', () => competitorsMod.g6Purge(store));
queue.register('tag_expiry', () => applyTagExpiryWeights());
queue.register('receipt_24h', (j) => processReceiptJob(j));          // Wave 4 F3②：T+24h 打开/点击/回流汇总
queue.register('zombie_sweep', () => zombie.sweepZombieActs(store)); // Wave 5 A4：僵尸会话每小时扫描收口
queue.recover();

/* ===================== Wave 4 体验与记忆（F1 / F3 / A3）===================== */

const RECEIPT_T24_MS = 24 * 3600 * 1000;   // F3②：发送完成 → 24h 后出回执汇总

// —— F1 store_banner：audience 表聚合的店铺数据开场句数据源（无数据字段缺省）——
async function buildStoreBanner(userId, opts) {
  if (!connectors) return { connected: false };
  let storeName = null;
  let currency = 'USD';
  try {
    const meta = await connectors.getShopMeta();
    storeName = (meta && (meta.name || meta.shop)) || null;
    if (meta && meta.currency) currency = String(meta.currency);
  } catch (e) { /* 元数据失败不阻塞开场：仅 connected */ }
  const audScope = userId ? store.getAudienceForUser(userId, opts) : store.getAudience();   // 安全整改：按用户隔离
  const weekAgo = Date.now() - 7 * 86400000;
  const carts = audScope.filter(a => /加购/.test(a.intent || ''));
  const weekly = carts.filter(a => (a.at_risk_at || a.created_at || 0) >= weekAgo);
  const vals = weekly.map(a => Number(a.abandoned_value) || 0).filter(v => v > 0);
  const total = +vals.reduce((s, v) => s + v, 0).toFixed(2);
  const banner = { connected: true };
  if (storeName) banner.store_name = String(storeName).slice(0, 40);
  if (weekly.length > 0 && total > 0) {
    banner.weekly_abandoned_count = weekly.length;
    banner.aov = +(total / vals.length).toFixed(2);
    banner.abandoned_value = total;
    banner.currency = currency;
  }
  return banner;   // 无数据 → 仅 connected：引擎改问一句话开场，不硬编数据
}

// —— F3①/②：发送完成的 T+0 一句话回执 + T+24h 汇总 job 入队（sendDraft 与批次 send 共同路径调用）——
// 数字口径：只算实发（sends 表）；无 sends 支撑的通知不产数字（agg=null → 跳过 T+0，仅排队 T+24h 兜底聚合）。
function enqueueReceipts({ userId, actId, draftId, campaignId, name, code }) {
  const agg = notify.aggregateReceipt(store, { draftId, campaignId, actId });
  if (agg) {
    store.addNotification({ user_id: userId || null, ...notify.buildT0Notification({ name, agg, code }) });
  }
  queue.enqueue({
    type: 'receipt_24h',
    payload: { draftId: draftId || null, campaignId: campaignId || null, actId: actId || null, name: String(name || ''), userId: userId || null },
    dedupeKey: 'receipt_24h:' + (campaignId || draftId),
    runAfter: Date.now() + RECEIPT_T24_MS
  });
}

// F3② job 执行体：sends+events 聚合该批次/草稿的打开点击与转化 → notifications（幂等：同 scope 已发 t24 不重复）
async function processReceiptJob({ payload }) {
  const scopeId = payload.campaignId || payload.draftId;
  const agg = notify.aggregateReceipt(store, { draftId: payload.draftId, campaignId: payload.campaignId, actId: payload.actId });
  if (!agg) return { skipped: 'no sends（无实发不产数字）' };
  const already = store.getNotifications(payload.userId || null, 500, { includeUnowned: isAdminUserId(payload.userId) })
    .some(n => n.type === 't24' && (n.draft_id === scopeId || n.campaign_id === scopeId));
  if (already) return { skipped: 't24 already emitted', scope_id: scopeId };
  store.addNotification({ user_id: payload.userId || null, ...notify.buildT24Notification({ name: payload.name, agg }) });
  return { notified: true, ...agg };
}

// —— F3③ 回流报喜 + estGmv 预估→实际翻转（attribution conversion 到达时即时调用）——
// campaign.stats 回填：publicCampaign 按 sends+events 实时派生（notify.campaignStats 单一口径），此处不重复记账。
function emitRecoverReceipt({ draftId, campaignId, audience, audienceId, coupon, value }) {
  const scopeId = campaignId || draftId;
  if (!scopeId) return null;
  const camp = campaignId ? store.getCampaign(campaignId) : null;
  const draft = !camp && draftId ? store.getDraft(draftId) : null;
  if (!camp && !draft) return null;
  const actId = camp ? camp.act_id : draft.act_id;
  const audRow = audience || (audienceId ? store.getAudience().find(a => a.id === audienceId) : null);
  const agg = notify.aggregateReceipt(store, {
    draftId: camp ? null : draftId, campaignId: camp ? camp.id : null, actId
  });
  const n = notify.buildRecoverNotification({
    name: audRow && audRow.name, email: audRow && audRow.email, coupon,
    value: Number(value) || 0,
    campaignName: camp ? camp.name : null,
    draftName: draft ? (draft.audience || '挽回邮件') : null,
    agg
  });
  store.addNotification({ user_id: (camp && camp.user_id) || (draft && draft.user_id) || null, ...n });
  // 翻转数据写回 act.plan_card.actual（方案卡仍存在时；前端据此把「预估」翻成「实际」）
  if (actId) {
    const act = store.getAct(actId);
    if (act && act.plan_card) {
      act.plan_card.actual = notify.actActual(store, actId);
      store.upsertAct(act);
    }
  }
  return n;
}

// —— A3②：新会话复用意图的 prefs 数据源（该商家最近一个确认沉淀过 prefs 的 act，排除当前会话）——
function latestPrefsFor(userId, excludeActId, opts) {
  const acts = store.getActsByUser(userId, opts).filter(a => a.id !== excludeActId);
  for (const a of acts) {   // getActsByUser 已按 updated_at 降序
    const p = a.memory && a.memory.prefs;
    if (p && typeof p === 'object' && String(p.audience || '').trim()) return p;
  }
  return null;
}

// —— A3④ / 接口契约①：GET /api/state 顶层 welcome / prefs / last_plan / todos ——
function buildStateExtras(userId, opts) {
  const acts = store.getActsByUser(userId, opts);
  // F1：欢迎语资格 = 该商家名下不存在任何 act（含 closed）
  const welcome = { eligible: acts.length === 0 };
  // A3：prefs = 最近 act 的 memory.prefs（确认沉淀 / 复用标记），否则 agent profile
  let prefs = null;
  for (const a of acts) {
    const p = a.memory && a.memory.prefs;
    if (p && typeof p === 'object') {
      const keys = Object.keys(p).filter(k => p[k] != null && p[k] !== '' && k !== 'reuse');
      if (keys.length) { prefs = p; break; }
    }
  }
  if (!prefs) {
    const prof = normalizeAgentProfile(store.getAgentProfile(userId));
    if (prof && Object.keys(prof).length) prefs = prof;
  }
  // Wave 5 偏好写入：user 级偏好存在则覆盖合并（POST /api/config prefs 持久化；前端保存后回读验证）
  const userPrefs = store.getUserPrefs(userId);
  if (userPrefs && Object.keys(userPrefs).length) {
    prefs = { ...(prefs || {}), ...userPrefs };
  }
  // A3④：last_plan = 最近一个确认过的 act（有 plan_card/execution_snapshot 或名下 campaign）。
  // S2 无码预览卡（preview 标记，A2 刷新续卡用）不算确认过——跳过，未确认会话不得污染「上次方案」
  let last_plan = null;
  for (const a of acts) {
    const pc = (a.plan_card && a.plan_card.preview) ? null : a.plan_card;
    const snap = a.execution_snapshot;
    const camps = store.getCampaignsByAct(a.id);
    if (!pc && !snap && !camps.length) continue;
    last_plan = {
      act_id: a.id,
      audience: (pc && pc.audience) || (snap && snap.audience) || (camps[0] && camps[0].audience_desc) || '',
      offer_text: (pc && pc.offer) || (camps[0] && camps[0].offer_text) || '',
      discount_text: (pc && pc.discount && pc.discount.text) || (camps[0] && camps[0].discount && camps[0].discount.text) || '',
      est_gmv_amount: (pc && pc.estGmv && pc.estGmv.amount) != null ? (pc && pc.estGmv && pc.estGmv.amount)
        : (snap && snap.estGmv && snap.estGmv.amount) != null ? (snap && snap.estGmv && snap.estGmv.amount) : null,
      currency: (pc && pc.estGmv && pc.estGmv.currency) || 'USD',
      actual: (pc && pc.actual) || null,
      confirmed_at: (pc && pc.generatedAt) || (snap && snap.frozen_at) || (camps[0] && camps[0].created_at) || null,
      ...(a.stage === 'closed' ? { closed_at: a.updated_at } : {}),
      ...(camps.length ? { campaign_name: camps[camps.length - 1].name } : {})
    };
    break;
  }
  // Wave 5 A4：商家待办列表（未 done，created_at 倒序 ≤20；契约①形状 {id,summary,act_id,created_at,done}）
  return { welcome, prefs, last_plan, todos: store.getOpenTodos(userId, 20) };
}

function agentContextOptions() {
  return {
    contextWindowTokens: config.aiContextWindowTokens,
    maxOutputTokens: config.aiMaxOutputTokens,
    safetyMargin: config.aiContextSafetyMargin,
    recentTurns: config.aiRecentTurns,
    summaryTriggerRatio: config.aiSummaryTriggerRatio
  };
}

// IGDE 实例：callAI 每调用经 LLMClient.chatStructured（一次返回 reply+needs+memory patch）；
// aiEnabled 由消息处理端点按「是否配了 key」动态置位（见 /api/act/:id/message）。
const igde = new IGDE({
  aiEnabled: false,
  callAI: async (messages, opts) => llmCoach(messages, opts),
  callCritic: async (text) => callCritic(text),
  contextOptions: agentContextOptions(),
  maxLlmCallsPerTurn: config.aiMaxCallsPerTurn,
  criticMode: config.aiCriticMode
});

function syncAgentConfig() {
  igde.contextOptions = agentContextOptions();
  igde.maxLlmCallsPerTurn = Math.max(1, Math.min(8, Number(config.aiMaxCallsPerTurn) || 3));
  igde.criticMode = ['always', 'suspicious', 'off'].includes(config.aiCriticMode)
    ? config.aiCriticMode
    : 'suspicious';
}

// —— 监控计数器（架构 §7 B6：护栏命中率 / 离线降级率 / 发送失败率 / 成本计量）——
function loadMetrics() { try { return JSON.parse(store.getMeta('metrics') || '{}'); } catch (e) { return {}; } }
function saveMetrics(m) { store.setMeta('metrics', JSON.stringify(m)); }
function metricsInc(key, n = 1) { const m = loadMetrics(); m[key] = (m[key] || 0) + n; saveMetrics(m); return m; }
function metricsAdd(values) {
  const m = loadMetrics();
  for (const [key, value] of Object.entries(values || {})) {
    const n = Number(value) || 0;
    if (n) m[key] = (m[key] || 0) + n;
  }
  saveMetrics(m);
  return m;
}

function consumeAgentMeta(result) {
  const meta = result && result.agentMeta;
  if (!meta) return;
  const context = meta.context || {};
  const usage = meta.usage || {};
  metricsAdd({
    agent_turns: 1,
    agent_llm_calls: meta.llmCalls,
    llm_provider_requests: meta.providerRequests,
    critic_calls: meta.criticCalls,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    token_usage: usage.total_tokens,
    context_estimated_tokens: context.estimatedInputTokens,
    context_messages_dropped: context.droppedMessages,
    context_compactions: context.compacted ? 1 : 0,
    memory_patch_accept: meta.memoryAccepted,
    memory_patch_reject: meta.memoryRejected,
    profile_patch_accept: meta.profileAccepted,
    profile_patch_reject: meta.profileRejected,
    context_overflow_prevented: context.overBudget ? 1 : 0
  });
  if (context.compacted) {
    logEvent('context_compaction', {
      summaryCursor: context.summaryCursor,
      keptMessages: context.keptMessages,
      droppedMessages: context.droppedMessages,
      estimatedInputTokens: context.estimatedInputTokens
    });
  }
  delete result.agentMeta; // 内部运行指标不进入前端协议
}

function persistAgentProfile(result, userId) {
  const profile = result && result.agentMeta && result.agentMeta.agentProfile;
  if (userId && profile) store.upsertAgentProfile(userId, normalizeAgentProfile(profile));
}

// 结构化日志（send / attribution / guardrail hit，便于回测 V）
function logEvent(type, data) {
  console.log(JSON.stringify({ t: 'ey', ts: Date.now(), type, ...data }));
}

// —— 异步生成 HTML 邮件 + 营销图片（调用同进程 TypeScript mailgen 子系统，无需 Python） ——
//    旧版 spawn('python3', scripts/mailgen.py) 已迁移为 Node + TS in-process 调用，
//    stdout JSON 契约（html/image_path/subject/body/copy_provider/image_method/warnings/config_source）保持不变。
let _mailgenMod = null;
function getMailgen() {
  if (_mailgenMod) return _mailgenMod;
  try {
    _mailgenMod = require('./dist/mailgen');
    return _mailgenMod;
  } catch (e) {
    throw new Error('mailgen 模块未构建，请先在 backend/ 下执行 `npm run build`：' + (e && e.message));
  }
}

// opts（编辑态「生成图片」重跑时使用）：
//   imagePromptOverride：提示词覆盖（空 = 按 draft.image_prompt / 标签画像构建）
//   copyPassthrough：跳过文案 LLM，直接透传 card.subject/body
async function generateMailHtml(draft, card, opts = {}) {
  const imagePromptOverride = String(opts.imagePromptOverride || draft.image_prompt || '').trim();
  const copyPassthrough = Boolean(opts.copyPassthrough);
  // 把 Node 端持有的 AI 密钥同步下发给 mailgen（同机可信边界，不跨网络，不落盘）
  // 这样商家只需在 UI 设置页录入一次即可，后端 LLM 与邮件图像复用同一套 Key。
  const ai_config = {
    provider: config.aiProvider || 'deepseek',
    apiKey:   config.aiKey || '',
    baseUrl:  config.aiBaseUrl || '',
    model:    config.aiModel || '',
    // 图像/万相模型 Key：优先用显式独立配置；若未单独填则与文案 AI 共享（兜底）
    visionKey:     config.visionKey || config.wanxKey || '',
    visionBaseUrl: config.visionBaseUrl || config.wanxBaseUrl || '',
    visionModel:   config.visionModel || config.wanxModel || 'wan2.7-image-pro',
  };

  const payload = {
    // IGDE 方案卡文案：作为 LLM 失败时的兜底透传（generateCopy 有 AI key 时一律走专门文案 LLM，
    // 与本地 email-automation 一致；不再「优先复用 Agent 产出省 Token」，那样质量明显更低且与设计不符）
    subject: card.subject || '',
    body: card.body || '',
    // 折扣数值口径唯一：方案卡 discountNum（% off）；card.discount 兼容数字/对象（Wave 2 planCard.discount 为对象）
    discount: execution.resolveDiscountNum(card),
    brand: resolveBrand(card),
    audience: card.audience || '',
    cart_url: card.cart_url || config.shopCartUrl || 'https://cartback.demo',
    cta: card.cta || 'Shop Now',
    locale: card.locale || config.shopDefaultLocale || 'en',
    product_en: card.product_en || card.product || '',
    product_cn: card.product_cn || '',
    coupon: card.coupon || '',
    posters: Array.isArray(card.posters) ? card.posters : [],
    // 新能力开关
    force_regen_copy: Boolean(card.force_regen_copy),  // 兼容字段：generateCopy 有 AI key 时一律走 LLM，此开关现无实际作用（保留供「换一批文案」语义复用）
    skip_image:        Boolean(card.skip_image),        // 纯文案调试时跳过图片生成
    product_image_path: card.product_image_path || '',  // 商家已有现成产品图时直接用，更快
    // 品类（批次 2）：商品库选用时随商品记录带入；空 = 按受众画像/通用模板构图
    category: card.category || '',
    // 编辑态「生成图片」重跑：提示词覆盖 + 文案透传（不动已润色的 subject/body）
    image_prompt_override: imagePromptOverride,
    copy_passthrough: copyPassthrough,
    // 受众标签分布快照（圈中人群的性别/年龄段/机型/分层/风格品类代表值）——
    // mailgen 据此填充 UserRecord 画像（文案 toneHint + 图片人群风格），此前恒为硬编码默认值
    tag_distribution: Array.isArray(draft.tag_distribution) ? draft.tag_distribution : [],
    // 配置注入（零重复录入）
    ai_config,
    // 公网基址：邮件内联图片 src 用 ${publicBaseUrl}/api/image/<path>，留空则退回本地路径（仅预览可用）
    public_base_url: config.publicBaseUrl || '',
    // 品牌统一用商家名（覆盖方案卡里 per-profile 的测试品牌）
    shop_brand: resolveBrand(card),
    draft: {
      id: draft.id || null,
      brand: config.shopBrand || 'CartBack',
      cart_url: config.shopCartUrl || 'https://cartback.demo',
      locale: card.locale || config.shopDefaultLocale || 'en',
    },
  };

  // v2 支持万相生成（可能 60-120s）+ 文案失败重试，总超时放宽到 240s（与旧版 Python 子进程一致）
  let timer;
  let timedOut = false;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error('mailgen timeout after 240s')); }, 240000);
  });

  let result;
  try {
    result = await Promise.race([getMailgen().run(payload), guard]);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  clearTimeout(timer);
  if (timedOut) throw new Error('mailgen timeout after 240s');

  // 结构化日志：把 copy_provider / image_method / warnings 写入结构化事件，方便回测
  logEvent('mailgen_result', {
    draft_id: draft.id || null,
    success: Boolean(result.success),
    copy_provider: result.copy_provider || null,
    image_method: result.image_method || null,
    html_len: (result.html || '').length,
    image_path_len: (result.image_path || '').length,
    config_source: result.config_source || null,
    warning_count: Array.isArray(result.warnings) ? result.warnings.length : 0,
  });

  if (result.success) {
    draft.html = result.html || '';
    draft.image_path = result.image_path || '';
    // 万相提示词快照：EditModal 编辑态展示「真实提示词」，重跑「生成图片」时复用
    if (result.image_prompt) draft.image_prompt = result.image_prompt;
    // mailgen 端可能重写了 subject/body（fallback_template 或 force_regen）
    // 这里仅在 Agent 原本是空串时才回填，避免覆盖 Agent 已精心润色的文案
    if (result.subject && !(card && card.subject)) draft.subject = result.subject;
    if (result.body    && !(card && card.body))    draft.body    = result.body;
    draft.mailgen_meta = {
      copy_provider: result.copy_provider,
      image_method:  result.image_method,
      warnings:      result.warnings || null,
      config_source: result.config_source,
    };
    store.upsertDraft(draft);
    return result;
  } else {
    throw new Error(result.error || 'mailgen unknown error');
  }
}

// —— M3 页脚热区真实链接 ——
// publicBaseUrl 配好后产出真实端点 URL；email 已知时（逐收件人）退订链接带 e 参数，落地即完成退订标记
function emailFooterUrls(draftId, email) {  if (!config.publicBaseUrl) return null;
  const base = String(config.publicBaseUrl).trim().replace(/\/$/, '');
  return {
    unsubscribe: `${base}/api/email/unsubscribe?d=${encodeURIComponent(draftId)}` + (email ? `&e=${encodeURIComponent(email)}` : ''),
    view: `${base}/api/email/view/${encodeURIComponent(draftId)}`,
  };
}
// 存量草稿的 html 是生成时固化的（当时的页脚链接是 cart_url 兜底）；
// 发送/预览/看板出口统一刷新为新端点，免重新生成草稿
function applyFooterLinks(html, draftId, email) {
  const urls = emailFooterUrls(draftId, email);
  if (!urls || !html || String(html).startsWith('ERROR')) return html;
  return html
    .replace(/(href=")([^"]*)("[^>]*>\s*Unsubscribe\s*<\/a>)/i, (m, a, _b, c) => a + urls.unsubscribe + c)
    .replace(/(href=")([^"]*)("[^>]*>\s*View in browser\s*<\/a>)/i, (m, a, _b, c) => a + urls.view + c);
}

// —— M4 白标品牌解析链：设置页 shopBrand（非默认值）> 方案卡 brand > CartBack 兜底 ——
function resolveBrand(card) {
  if (config.shopBrand && config.shopBrand !== 'CartBack') return config.shopBrand;
  const b = String((card && card.brand) || '').trim();
  return b || 'CartBack';
}

// —— M4 发件人名链：显式 espSenderName（非默认 CartBack）> 草稿固化品牌 > 兜底 ——
// espSenderName 的配置默认值就是 'CartBack'（含已持久化的旧配置），须视为「未设置」走品牌链
function senderNameFor(c, draft) {
  const raw = (c && c.espSenderName && c.espSenderName !== 'CartBack')
    ? c.espSenderName
    : ((draft && draft.brand) || config.shopBrand || 'CartBack');
  // 安全整改：draft.brand 来自商家对话输入（resolveMerchantBrand），含 CR/LF 可注入 SMTP 头（如 Bcc），
  // 也会污染 Resend/Brevo 的 from 字段——统一剥离控制字符。
  const safe = String(raw).replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim();
  return safe || 'CartBack';
}

// —— M5 主题口径护栏：加购未付/弃购人群（从未完成订单）禁 order/purchase 措辞，一律 cart（保留首字母大写） ——
function cartTone(text) {
  return String(text || '')
    .replace(/\b[Yy]our order\b/g, (m) => (m[0] === 'Y' ? 'Your cart' : 'your cart'))
    .replace(/\b[Oo]rder(s?)\b/g, (m, s) => (m[0] === 'O' ? 'Cart' : 'cart') + (s || ''))
    .replace(/\b[Pp]urchase(s?)\b/g, (m, s) => (m[0] === 'P' ? 'Cart' : 'cart') + (s || ''));
}
function applySubjectTone(subject, audience) {
  if (!subject || !/加购|未付|弃购/.test(String(audience || ''))) return subject;
  return cartTone(subject);
}

// —— M6 商品位兜底：方案卡 product 为空时按圈中人群的风格品类标签补一个品类描述 ——
const STYLE_PRODUCT_FALLBACK = { tech: 'tech picks', fashion: 'style picks', business: 'work essentials', outdoor: 'outdoor gear' };
function productFallbackFor(draft) {
  if (draft && draft.product) return draft.product;
  const dist = Array.isArray(draft && draft.tag_distribution) ? draft.tag_distribution : [];
  const style = String(((dist.find(t => t.tag_type === 'style_preference') || {}).tag_value) || '').toLowerCase();
  return STYLE_PRODUCT_FALLBACK[style] || '';
}

// —— M10 standard 档称呼注入：共享 draft.html 的通用称呼 → 逐收件人称呼（变体档本就逐人渲染） ——
function personalizeHtml(html, msg) {
  if (!html || !msg) return html;
  // 安全整改：name 来自 CSV 导入/店铺同步等不可信数据，原样内插曾构成邮件 HTML 注入（发件域被当钓鱼跳板）
  const name = escapeHtml(render.safeName(msg.recipient || {}, msg.locale || 'en'));
  if (!name || name === 'there') return html;
  return html
    .replace(/Hi there,?\s*/i, 'Hi ' + name + ', ')
    .replace(/Hi,\s*/, 'Hi ' + name + ', ');
}

// —— 速率限制（架构 §6 P0-3：/send 速率限制防域名声誉滥用）——
const rateBucket = { start: Date.now(), count: 0 };
function rateLimitOk() {
  const now = Date.now();
  if (now - rateBucket.start > 60000) { rateBucket.start = now; rateBucket.count = 0; }
  const limit = config.sendRateLimitPerMin || 20;
  if (rateBucket.count >= limit) return false;
  rateBucket.count++;
  return true;
}

// —— 注册限流（整改 3：per-IP 滑动窗口，每小时 ≤10 次，防刷号）——
const regBuckets = {}; // ip -> { win, count }
function regRateOk(ip) {
  const now = Date.now();
  const b = regBuckets[ip] || { win: now, count: 0 };
  if (now - b.win > 3600000) { b.win = now; b.count = 0; }
  b.count++; regBuckets[ip] = b;
  return b.count <= 10;
}
// 安全整改：X-Forwarded-For 客户端可伪造（伪造首段即可无限换桶绕过注册限流）。
// 仅在显式声明 TRUST_PROXY=1（部署在可信反代后）时采信 XFF，且取【最后一跳】（反代追加的真实来源）；
// 默认直连场景一律取 TCP 对端地址，不可被请求头伪造。
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

// —— 普通用户每日 AI 额度（安全整改：免费账号不得无限烧 Token Plan；管理员不受限；0 = 不限）——
// 计量口径：1 次 agent 对话轮 = 1 次；1 次竞品邮件拆解 = 1 次（一次轮内最多 aiMaxCallsPerTurn 次模型调用）。
const llmQuota = {}; // userId -> { day: 'YYYY-MM-DD', used }
function llmQuotaTry(userId, cost = 1) {
  const limit = Number(config.userLlmDailyLimit) || 0;
  if (!limit || !userId) return true;
  const day = new Date().toISOString().slice(0, 10);
  let q = llmQuota[userId];
  if (!q || q.day !== day) { q = { day, used: 0 }; llmQuota[userId] = q; }
  if (q.used + cost > limit) return false;
  q.used += cost;
  return true;
}

// —— AI 适配器（lib/llm 的 LLMClient，服务端代理保密钥） ——
function makeLlmClient() {
  return new LLMClient({
    baseUrl: config.aiBaseUrl,
    model: config.aiModel,
    apiKey: config.aiKey,
    timeoutMs: 45000,   // 并发压测下 LLM 偶发 >20s：20s 超时会把整轮对话打成空回复（实测 r6 B套件）
    contextWindowTokens: config.aiContextWindowTokens,
    contextSafetyMargin: config.aiContextSafetyMargin,
    extraBody: config.aiExtraBody || null
  });
}

// 真实模型教练：一次返回回复与结构化提取（PRD v2 envelope：slot_updates/extras/corrections）。
// opts.onReplyToken 存在时走真流式（边生成边上屏——乐观预览，权威 reply 以返回值为准），否则保持一次性结构化调用。
async function llmCoach(messages, opts) {
  if (!config.aiKey) throw new Error('AI 未配置');
  const client = makeLlmClient();
  const r = (opts && opts.onReplyToken)
    ? await client.streamChatStructured({ messages, maxTokens: config.aiMaxOutputTokens, onReplyToken: opts.onReplyToken })
    : await client.chatStructured({ messages, maxTokens: config.aiMaxOutputTokens });
  return {
    reply: r.reply,
    needs: r.needs,
    slotUpdates: r.slotUpdates || [],
    extras: r.extras || [],
    corrections: r.corrections || [],
    memoryPatch: r.memoryPatch,
    profilePatch: r.profilePatch,
    usage: r.usage,
    requestCount: r.requestCount,
    jsonOk: r.jsonOk
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// —— PRD v2 引擎档位：llm 熔断 closed 且已配 key → online；open/half-open/未配 key → degraded（G2）——
function engineOnline() {
  return Boolean(config.aiKey) && breakers.get('llm').snapshot().state === 'closed';
}

async function callCritic(text) {
  if (!config.aiKey) return guardrailL2(text); // 本地启发式兜底（L2）
  // fail-closed（架构 P1-4）：真实 critic 调用失败 → 视为违规拦截，而非放行
  try {
    const client = makeLlmClient();
    const r = await client.chatStructured({
      messages: [
        { role: 'system', content: '你是严格的内容审查员。判断文本是否「说教 / 推销 / 列清单 / 替用户下结论」。只回 JSON {"bad":true} 或 {"bad":false}，不要其它内容。' },
        { role: 'user', content: text }
      ]
    });
    // chatStructured 只抽取 reply/needs，「bad」需从原始 content 解析
    const content = r.raw && r.raw.choices && r.raw.choices[0] && r.raw.choices[0].message.content;
    const parsed = safeJson(content);
    if (parsed && typeof parsed.bad === 'boolean') return !parsed.bad;
    return guardrailL2(text); // 解析失败 → 本地兜底
  } catch (e) {
    return false; // fail-closed
  }
}

// —— ESP 适配器（Resend 真发 + 仿真回退） ——
// 隐私：Batch API 每封独立 to，收件人互不可见（修复 To 群发泄露收件人列表）；
// 送达率：≤100 封/请求分批（Resend batch 上限；单收件人走普通端点——batch 最少 2 封）。
// ④ 渲染管线消费：messages = renderCampaign 产物 [{email, subject, body, html?}]，逐收件人内容可不同。
const RESEND_BATCH_SIZE = 100;
async function fetchResend(draft, messages, c) {
  const base = String(c.espApiUrl || 'https://api.resend.com/emails').replace(/\/emails?\/?$/, '');
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.espKey };
  const message = r => {
    const msg = {
      // M4 白标：发件人带品牌名（走品牌链）
      from: `${senderNameFor(c, draft)} <${c.espFrom}>`,
      to: [r.email],
      subject: r.subject,
      text: r.body
    };
    // HTML 邮件仅对生成过 html 的变体附上（mailgen html 为标准档直出；其余档用纯文本，避免跨变体串内容）
    // M10 + M3：称呼注入 + 页脚链接刷新（同 Brevo 口径）
    if (r.html) msg.html = applyFooterLinks(personalizeHtml(r.html, r), draft.id, r.email);
    else if (!r.tier || r.tier === 'standard') {
      if (draft.html && !String(draft.html).startsWith('ERROR')) msg.html = applyFooterLinks(personalizeHtml(draft.html, r), draft.id, r.email);
    }
    // M3 合规投递头：一键退订（publicBaseUrl 未配则不加，避免投出死链头）
    const unsub = emailFooterUrls(draft.id, r.email);
    if (unsub) msg.headers = { 'List-Unsubscribe': `<${unsub.unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    return msg;
  };
  const post = async (url, body) => {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('ESP HTTP ' + resp.status);
    return resp.json();
  };
  const ids = [];
  if (messages.length === 1) {
    const r = await post(base + '/emails', message(messages[0]));
    if (r && r.id) ids.push(r.id);
    return { id: ids.join(','), ids, batches: 1 };
  }
  for (let i = 0; i < messages.length; i += RESEND_BATCH_SIZE) {
    const batch = messages.slice(i, i + RESEND_BATCH_SIZE);
    const r = await post(base + '/emails/batch', batch.map(message));   // 整批原子成败 → 失败由 sendDraft 整体重试
    if (Array.isArray(r)) for (const m of r) if (m && m.id) ids.push(m.id);
  }
  return { id: ids.join(','), ids, batches: ids.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// —— Brevo 发送适配器（配置迁移自 email-automation 的 emailgen_config.yaml → .server/config.json 变量）——
// espProvider='brevo'：POST /v3/smtp/email，鉴权走 api-key 头（非 Bearer）；逐收件人单发
async function fetchBrevo(draft, messages, c) {
  const url = String(c.espApiUrl || 'https://api.brevo.com/v3/smtp/email');
  const headers = { 'Content-Type': 'application/json', 'accept': 'application/json', 'api-key': c.espKey };
  // M4 白标：发件人名走品牌链（收件人看到的不是工具品牌）
  const sender = { name: senderNameFor(c, draft), email: c.espFrom };
  const ids = [];
  let batches = 0;
  for (const r of messages) {
    const body = {
      sender,
      to: [{ email: r.email }],
      subject: String(r.subject || '').slice(0, 200),
      textContent: String(r.body || '').slice(0, 20000),
    };
    const baseHtml = r.html || ((!r.tier || r.tier === 'standard') && draft.html && !String(draft.html).startsWith('ERROR') ? draft.html : '');
    // M10 + M3：standard 档共享 html 注入逐收件人称呼，再刷新页脚退订链接（带该收件人 e 参数）
    const html = baseHtml ? applyFooterLinks(personalizeHtml(baseHtml, r), draft.id, r.email) : '';
    if (html) body.htmlContent = html;
    // M3 合规投递头：一键退订（publicBaseUrl 未配则不加，避免投出死链头）
    const unsub = emailFooterUrls(draft.id, r.email);
    if (unsub) body.headers = { 'List-Unsubscribe': `<${unsub.unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('Brevo HTTP ' + resp.status + ': ' + JSON.stringify(await resp.json().catch(() => ({}))).slice(0, 160));
    const j = await resp.json().catch(() => ({}));
    if (j && j.messageId) ids.push(j.messageId);
    batches++;
    if (messages.length > 1) await sleep(120);   // Brevo 限速保护
  }
  return { id: ids.join(','), ids, batches };
}

// —— SMTP 发送适配器（163/QQ 等标准邮箱；配置迁移自用户提供：espProvider='smtp'）——
// 逐收件人直邮（SMTP 无批量协议）；限速 500ms 防邮箱商频控
async function fetchSmtp(draft, messages, c) {
  const ids = [];
  for (const r of messages) {
    const baseHtml = r.html || ((!r.tier || r.tier === 'standard') && draft.html && !String(draft.html).startsWith('ERROR') ? draft.html : '');
    // M10 + M3：称呼注入 + 页脚链接刷新（同 Brevo 口径）
    const html = baseHtml ? applyFooterLinks(personalizeHtml(baseHtml, r), draft.id, r.email) : '';
    // M3 合规投递头：一键退订（publicBaseUrl 未配则不加，避免投出死链头）
    const unsub = emailFooterUrls(draft.id, r.email);
    const extraHeaders = unsub
      ? ['List-Unsubscribe: <' + unsub.unsubscribe + '>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click']
      : null;
    const out = await sendSmtp({
      host: c.smtpHost, port: c.smtpPort, user: c.smtpUser, pass: c.smtpPass,
      from: c.espFrom, senderName: senderNameFor(c, draft),
      to: r.email, subject: r.subject, text: r.body, html, extraHeaders,
    });
    ids.push((out && out.messageId) || 'smtp-' + Date.now().toString(36));
    if (messages.length > 1) await sleep(500);
  }
  return { id: ids.join(','), ids, batches: messages.length };
}

/* ===================== 安全整改：账号可见域（多租户隔离） =====================
 * 规则（与 lib/store 过滤口径一致）：
 *  - 行 user_id === 当前用户 → 可见；
 *  - 空 user_id（历史/种子数据）→ 仅管理员可见（本地模式 / config.adminEmails 命中）；
 *  - 其余（他人数据）→ 不可见。
 */
// 历史无归属数据的锚点账号（本地管理员 admin@local）。本地模式所有请求都挂它名下，
// 引擎按数据归属（draft.user_id）取受众时，命中锚点 = 历史数据可见域。
function legacyAnchorId() { return authMod.ensureLocalOwner(store).id; }
function isAdminUserId(userId) { return userId != null && userId === legacyAnchorId(); }
function isAdminReq(req) {
  if (req.authMode === 'local') return true;
  if (!req.userId) return false;
  if (isAdminUserId(req.userId)) return true;
  const u = store.getUserById(req.userId);
  if (!u) return false;
  const admins = Array.isArray(config.adminEmails) ? config.adminEmails : [];
  return admins.map(s => String(s).toLowerCase()).includes(String(u.email || '').toLowerCase());
}
function scopeOpts(req) { return { userId: req.userId, includeUnowned: isAdminReq(req) }; }
function canSeeRow(row, req) {
  if (!row) return false;
  return row.user_id ? row.user_id === req.userId : isAdminReq(req);
}
/** 引擎路径作用域：按数据归属人（act/draft 的 user_id）取名单；空归属或本地锚点 = 历史数据可见域 */
function ownerScope(user_id) { return { userId: user_id || null, includeUnowned: !user_id || isAdminUserId(user_id) }; }

// 依据方案卡受众描述解析真实收件人（P0 真实源未接前用假种子/导入名单）
// 安全整改：第二参为【已按用户隔离】的受众列表；缺省时按 draft 归属域解析。
function matchAudienceByDesc(desc, aud) {
  const all = aud || store.getAudience();
  const d = (desc || '').toLowerCase();
  let list = all;
  if (/弃购|未付/.test(d)) list = all.filter(a => /弃购|未付|下单未付/.test(a.intent));
  else if (/加购/.test(d)) list = all.filter(a => /加购/.test(a.intent));
  else if (/浏览/.test(d)) list = all.filter(a => /浏览/.test(a.intent));
  else if (/老客|沉睡|流失/.test(d)) list = all.filter(a => /老客|沉睡|流失/.test(a.intent));
  if (list.length === 0) list = all;
  return list;
}
function resolveRecipients(draft) {
  const scope = ownerScope(draft.user_id);
  return filterTargetable(matchAudienceByDesc(draft.audience, store.getAudienceForUser(scope.userId, scope))).slice(0, 200);
}
// Wave 2 D3：净名单唯一口径（可发送上限 200 与 reach_count / matchedCount / holdout 圈定同源）
function audienceNetList(desc, scope) {
  const aud = scope ? store.getAudienceForUser(scope.userId, scope) : store.getAudience();
  return filterTargetable(matchAudienceByDesc(desc, aud)).slice(0, 200)
    .filter(r => r.email_status !== 'email_invalid' && r.email_status !== 'unsubscribed');
}

// Wave 2 D4③ 白标：商家品牌解析链（设置页 shopBrand 非默认 > 对话 extras「brand/品牌」 > 工具默认 'CartBack'）。
// 返回 'CartBack' = 未白标 → 闸门③拦截（署名绝不能落到工具品牌上）。
function resolveMerchantBrand(act) {
  if (config.shopBrand && config.shopBrand !== 'CartBack') return config.shopBrand;
  const extras = (act && act.memory && Array.isArray(act.memory.extras)) ? act.memory.extras : [];
  const hit = extras.find(e => e && (e.key === 'brand' || e.key === '品牌') && String(e.value || '').trim());
  if (hit) return String(hit.value).trim().slice(0, 40);
  return 'CartBack';
}

// PRD §1 过滤口径：真实邮箱 且 未转化 且 挽回窗口 30 天（与确认卡展示的圈选条件同源，说到做到）
// Wave 3 I4 重构：实现收敛到 lib/exclusion.baseTargetable（单方案与批次共用同一口径，语义不变）
const RECOVERY_WINDOW_MS = exclusionMod.RECOVERY_WINDOW_MS;
function filterTargetable(list) {
  return exclusionMod.baseTargetable(store, list, { now: Date.now(), recoveryWindowMs: RECOVERY_WINDOW_MS });
}

// —— ② 受众圈选条件（确认卡展示用）：需求关键词 → 结构化过滤条件 + 命中概览 ——
function audienceConditions(desc, scope) {
  const d = (desc || '').toLowerCase();
  const filters = [];
  if (/弃购|未付/.test(d)) filters.push({ field: 'intent', op: 'includes', value: '弃购/下单未付' });
  else if (/加购/.test(d)) filters.push({ field: 'intent', op: 'includes', value: '加购未付' });
  else if (/浏览/.test(d)) filters.push({ field: 'intent', op: 'includes', value: '浏览未买' });
  else if (/老客|沉睡|流失/.test(d)) filters.push({ field: 'intent', op: 'includes', value: '老客/沉睡/流失' });
  // value 一律给人看的文案（确认卡原样渲染）；内部枚举不出库（走查 P1-8：email_invalid 曾直接露给商家）
  filters.push({ field: 'email', op: 'valid', value: '邮箱有效' });
  filters.push({ field: 'email_status', op: 'not_equals', value: '排除无效邮箱' });
  filters.push({ field: 'window', op: 'within_days', value: '30 天内互动' });
  const aud = scope ? store.getAudienceForUser(scope.userId, scope) : store.getAudience();   // 安全整改：命中概览按用户域
  const matched = filterTargetable(matchAudienceByDesc(desc, aud));   // 与发送端同一口径
  return {
    desc: desc || '全部受众',
    filters,
    matchedCount: matched.length,
    estGmv: +matched.reduce((s, a) => s + (a.estGmv || 0), 0).toFixed(2)
  };
}

// —— ③ 72h 频控已并入 D4 闸门②（lib/execution.frequencyFilter）——
// 窗口常量单处收敛在 lib/config.js（「PRD 口径 7 天，挂起裁决先不动 72h」）。

// —— ESP 发信就绪判定（按供应商取凭证；走查部署 P0：smtp 供应商此前被 espKey 门槛永远判成未配置）——
function espReady() {
  if (config.espProvider === 'smtp') {
    return Boolean(config.smtpHost && config.smtpUser && config.smtpPass && config.espFrom);
  }
  return Boolean(config.espKey && config.espFrom);
}

// —— ③ 发送前预检 + 失败分类（PRD §3.4：域名验证/邮箱格式/限额，失败给分类人话提示）——
// Wave 2：72h 频控从预检移入 D4 闸门②（409 checklist 口径），本函数只管「配置类」硬故障
function precheckSend(draft, { dryRun = false } = {}) {
  const problems = [];
  if (config.mode === 'real') {
    if (!espReady()) problems.push({ type: 'esp_not_configured', human: config.espProvider === 'smtp' ? 'SMTP 还没配全（服务器 / 用户 / 授权码），去设置页填好再发。' : '还没有配置发信密钥（ESP），去设置页填好再发。' });
    if (!config.espFrom) problems.push({ type: 'from_missing', human: '还没有设置发件人地址，去设置页填「发件邮箱」。' });
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.espFrom)) problems.push({ type: 'from_invalid', human: '发件人地址格式不对，请检查设置页的「发件邮箱」。' });
    // 域名验证（MVP：与店铺域名/公开基址一致性提示；Resend 域名验证状态经预检调用探测）
    else if (config.publicBaseUrl) {
      const fromDomain = config.espFrom.split('@')[1] || '';
      const siteDomain = (config.publicBaseUrl.replace(/^https?:\/\//, '').split(':')[0] || '').replace(/^www\./, '');
      if (siteDomain && fromDomain && !siteDomain.endsWith(fromDomain)) {
        problems.push({ type: 'domain_mismatch', human: `发件域名（${fromDomain}）和站点域名（${siteDomain}）不一致，邮件容易被判垃圾，建议用同域名发件箱。` });
      }
    }
  }
  const all = resolveRecipients(draft);
  const valid = all.filter(r => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || '') && r.email_status !== 'email_invalid' && r.email_status !== 'unsubscribed');
  if (!valid.length) problems.push({ type: 'no_recipients', human: '没有可发送的收件人（邮箱无效或都被退信剔除了）。' });
  if (config.sendRateLimitPerMin > 0 && valid.length > config.sendRateLimitPerMin * 5) {
    problems.push({ type: 'quota_warning', human: `本批 ${valid.length} 人超过当前发送限额建议值，系统会自动分批限速。` });
  }
  const blocking = problems.filter(p => !['quota_warning', 'domain_mismatch'].includes(p.type));
  return {
    ok: blocking.length === 0,
    problems,
    recipients: valid.length,
    sendable: valid.length
  };
}

// ④ 渲染管线消费方：发送前逐收件人渲染（变体选择→语种→模板展开→G0 拦截）
async function renderForDraft(draft, recipients) {
  const draftFacts = {
    id: draft.id, coupon: draft.coupon, discount: draft.discount,
    // 注意：product 绝不回退到 audience（商家侧中文描述）——进消费者邮件的事实必须无中文，否则 G0 全拦
    // M6：优先草稿固化快照，其次风格品类标签兜底（renderForDraft 供旧草稿兜底，新草稿创建时已固化）
    product: productFallbackFor(draft) || '', offer: draft.offer || '',
    // M4：品牌优先草稿固化快照（设置页 > 方案卡，创建时已解析），兜底配置链
    brand: draft.brand || resolveBrand({})
  };
  const variants = (Array.isArray(draft.variants) && draft.variants.length)
    ? draft.variants
    : variantsMod.standardVariants({ brand: draftFacts.brand, discount: draft.discount, coupon: draft.coupon, product: draftFacts.product });
  return render.renderCampaign({
    draft: draftFacts,
    variants,
    recipients,
    tagsOf: (r) => store.getAudienceTags(r.id),
    whitelist: g0Whitelist(),
    translateFn: translateText,
    cache: translationCache
  });
}

// 仿真归因事件（演示模式驱动看板；真实模式仅在有回执时写入）——事件打上 draft 归属（安全整改）
function scheduleSimEvents(draft, recipients) {
  const now = Date.now();
  recipients.forEach((r, i) => {
    const base = now + i * 1200;
    store.addEvent({ type: 'emailed', draft_id: draft.id, audience_id: r.id, user_id: draft.user_id || null, ts: base });
    if (Math.random() < 0.72) store.addEvent({ type: 'open', draft_id: draft.id, audience_id: r.id, user_id: draft.user_id || null, ts: base });
    if (Math.random() < 0.34) store.addEvent({ type: 'click', draft_id: draft.id, audience_id: r.id, user_id: draft.user_id || null, ts: base + 3000 });
    if (Math.random() < 0.14) {
      const value = +(r.abandoned_value * (0.1 + Math.random() * 0.2)).toFixed(2);
      store.addEvent({ type: 'convert', draft_id: draft.id, audience_id: r.id, user_id: draft.user_id || null, value, ts: base + 9000 });
      tagsMod.weightForConversion(store, r.id);   // ⑤ 标签反哺（演示模式同步演示加权）
    }
  });
}

// ⑤ 窗口期满未转化 → 标签 w −= 0.5（队列周期 job 调用）
function applyTagExpiryWeights() {
  const windowMs = ((config.attributionWindowDays) || 7) * 86400000;
  const now = Date.now();
  let touched = 0;
  for (const d of store.getDrafts()) {
    if (!['sent', 'recovering', 'timeout'].includes(d.status) || !d.sent_at) continue;
    if (now - d.sent_at <= windowMs) continue;
    const evs = store.getEvents({ draft_id: d.id });
    const converts = new Set(evs.filter(e => e.type === 'convert').map(e => e.audience_id));
    const expiryKey = 'tag_expiry_done:' + d.id;
    if (store.getMeta(expiryKey)) continue;
    for (const e of evs) {
      if (e.type !== 'emailed' || !e.audience_id || converts.has(e.audience_id)) continue;
      touched += tagsMod.weightForExpiry(store, e.audience_id);
    }
    store.setMeta(expiryKey, '1');
  }
  if (touched) logEvent('tag_expiry_weight', { touched });
  return { touched };
}

// send job 持有 draft 的 stale 快照（job 开头读一次）；upsert 前从当前行刷新异步 job（posters/mailgen）
// 写入的字段，避免整行覆盖回退 posters/html/image_path（posters job 与 send job 并发写竞态修复）。
function upsertDraftPreservingAsync(draft) {
  const cur = store.getDraft(draft.id);
  if (cur) {
    for (const k of ['posters', 'html', 'image_path', 'variants', 'variants_provider', 'strategy_card_ids', 'audience_conditions']) {
      if (cur[k] != null) draft[k] = cur[k];
    }
  }
  return store.upsertDraft(draft);
}

// —— D4 五道闸门不过时的 draft 失败收口（人话原因 + checklist 留痕）——
function failDraftByGates(draft, checklist) {
  const failing = checklist.items.filter(i => !i.pass);
  draft.status = 'failed';
  draft.fail_reason = '发送闸门未通过：' + failing.map(f => f.reason || f.label).join('；');
  draft.gate_checklist = checklist.items;
  upsertDraftPreservingAsync(draft);
  metricsInc('send_fail');
  logEvent('send_gate_fail', { draft_id: draft.id, gates: failing.map(f => f.gate) });
  return { error: draft.fail_reason, checklist: checklist.items, recipients: 0, cost: 0, estGmv: draft.estGmv };
}

async function sendDraft(draft, opts = {}) {
  const act = draft.act_id ? store.getAct(draft.act_id) : null;
  const all = resolveRecipients(draft).filter(r => r.email_status !== 'email_invalid' && r.email_status !== 'unsubscribed');
  // 预检不通过（配置类硬故障/无人可发）直接失败并分类提示
  const check = precheckSend(draft);
  if (!check.ok) {
    draft.status = 'failed';
    draft.fail_reason = (check.problems.find(p => p.type !== 'quota_warning') || {}).human || 'precheck_failed';
    upsertDraftPreservingAsync(draft);
    metricsInc('send_fail');
    logEvent('send_fail', { draft_id: draft.id, reason: draft.fail_reason });
    return { error: draft.fail_reason, problems: check.problems, recipients: 0, cost: 0, estGmv: draft.estGmv };
  }
  // —— D4 五道闸门重跑（服务端兜底；POST /send 已跑过一次）——
  //    唯一闸门=时段且不过 → 缓发（返回 deferred，由队列带 run_after 重新入队，非永久拒绝）；
  //    其余任一不过 → 永久拒绝并说明原因；店铺 API 校验超时在闸门⑤内视为不过（宁缓发不错发）。
  const checklist = await execution.evaluateChecklist({ act, draft, store, config, connector: connectors, recipients: all });
  if (!checklist.all_pass) {
    const failing = checklist.items.filter(i => !i.pass);
    if (failing.length === 1 && failing[0].gate === 'window' && !opts.noReschedule) {
      return { deferred: true, retryAt: checklist.windowRetryAt, checklist: checklist.items };
    }
    return failDraftByGates(draft, checklist);
  }
  // —— holdout 对照组（J3 前置子集）：先冻结（幂等）再从净值名单剔除；对照成员不收信、不计挽回、绝不写 sends ——
  const holdoutPlan = execution.selectHoldout(checklist.net);
  const holdoutMembers = new Set(store.getHoldouts({ campaign_id: draft.id }).map(h => String(h.recipient).toLowerCase()));
  if (holdoutPlan.frozen) {
    store.freezeHoldouts({ act_id: draft.act_id, campaign_id: draft.id, recipients: holdoutPlan.members, ratio: holdoutPlan.ratio, source: 'single_plan' });
    for (const m of holdoutPlan.members) holdoutMembers.add(m);
  }
  const allow = checklist.net.filter(r => !holdoutMembers.has(String(r.email).toLowerCase()));
  const heldOut = checklist.net.length - allow.length;
  // 闸门快照（逐收件人 sends.gate_snapshot 共用；五项全过时刻的留痕）
  const gateSnapshot = { items: checklist.items, all_pass: true, at: Date.now(), timezone: checklist.timezone };
  metricsInc('send_volume', allow.length);
  const real = (config.mode === 'real' && espReady());
  draft.status = 'sending'; upsertDraftPreservingAsync(draft);
  if (!real) {
    draft.status = 'sent';
    draft.sent_at = Date.now();
    draft.esp_message_id = 'sim_' + uid();
    draft.cost = +(allow.length * 0.02).toFixed(2); // 仿真混合成本
    draft.skipped_by_frequency = checklist.skippedByFrequency;
    draft.holdout_count = heldOut;
    draft.g0_blocked = [];   // 仿真档不做 G0 拦截（内容为商家确认过的原稿）
    upsertDraftPreservingAsync(draft);
    scheduleSimEvents(draft, allow);
    // Wave 2：逐收件人落 sends（demo 同口径；tz 按收件人时区）
    for (const r of allow) {
      store.recordSendRow({
        act_id: draft.act_id, campaign_id: draft.id, recipient: r.email,
        template: 'standard', tag: r.intent || null, code: draft.coupon || null,
        tz: execution.tzForRecipient(r), gate_snapshot: gateSnapshot, status: 'sent'
      });
    }
    benchmarkMod.rebuildBenchmark(store);
    metricsInc('send_sim');
    logEvent('send', { real: false, recipients: allow.length, skipped_by_frequency: checklist.skippedByFrequency, holdout: heldOut, cost: draft.cost });
    return { real: false, recipients: allow.length, skippedByFrequency: checklist.skippedByFrequency, holdout: heldOut, cost: draft.cost, estGmv: draft.estGmv };
  }
  // ④ 渲染管线（真实模式）：变体→语种→模板展开→G0
  const rendered = await renderForDraft(draft, allow);
  const sendable = rendered.messages.filter(m => !m.blocked);
  const blockedList = rendered.messages.filter(m => m.blocked);
  draft.g0_blocked = blockedList.map(m => ({ email: m.email, hits: m.g0Hits }));
  if (blockedList.length) {
    metricsInc('g0_blocked', blockedList.length);
    logEvent('g0_intercept', { draft_id: draft.id, blocked: blockedList.length });
  }
  if (!sendable.length) {
    // 全部被 G0 拦截 → 置失败并给出人话修复指引（绝不把「0 人已发送」标成成功）
    draft.status = 'failed';
    draft.fail_reason = 'G0 语种护栏拦截了全部邮件（检出非白名单中文）。请到设置页把品牌名/专有名词加入白名单，或修正文案后重试。';
    upsertDraftPreservingAsync(draft);
    metricsInc('send_fail');
    logEvent('send_fail', { draft_id: draft.id, reason: 'g0_blocked_all' });
    return { error: draft.fail_reason, g0Blocked: blockedList.length, recipients: 0, cost: 0, estGmv: draft.estGmv };
  }
  let attempt = 0, lastErr;
  while (attempt < 3) {
    attempt++;
    try {
      const sendViaEsp = (c) => {
        if (c.espProvider === 'brevo') return fetchBrevo(draft, sendable, c);
        if (c.espProvider === 'smtp') return fetchSmtp(draft, sendable, c);
        return fetchResend(draft, sendable, c);
      };
      const r = await breakers.get('esp').exec(() => sendViaEsp(config));
      draft.status = 'sent';
      draft.sent_at = Date.now();
      draft.esp_message_id = r.id || ('real_' + uid());
      draft.cost = +(sendable.length * 0.0004).toFixed(4);
      draft.skipped_by_frequency = checklist.skippedByFrequency;
      draft.holdout_count = heldOut;
      // 记录 per-recipient 发送事实（频控 / 标签反哺窗口 / ESP 回执映射的依据）
      const espIds = Array.isArray(r.ids) ? r.ids : [];
      for (let i = 0; i < sendable.length; i++) {
        const m = sendable[i];
        store.addEvent({
          type: 'emailed', draft_id: draft.id,
          audience_id: (m.recipient || {}).id || null,
          user_id: draft.user_id || null,
          esp_id: espIds[i] || null, ts: Date.now()
        });
        // Wave 2：sends 实发流水（幂等键 campaign+recipient，重试不追加新行）
        store.recordSendRow({
          act_id: draft.act_id, campaign_id: draft.id, recipient: m.email,
          template: m.tier || 'standard', tag: ((m.recipient || {}).intent) || null,
          code: draft.coupon || null, tz: execution.tzForRecipient(m.recipient),
          gate_snapshot: gateSnapshot, status: 'sent'
        });
      }
      upsertDraftPreservingAsync(draft);
      benchmarkMod.rebuildBenchmark(store);
      metricsInc('send_real');
      logEvent('send', { real: true, recipients: sendable.length, skipped_by_frequency: checklist.skippedByFrequency, holdout: heldOut, g0_blocked: blockedList.length, attempt, cost: draft.cost });
      return { real: true, id: draft.esp_message_id, recipients: sendable.length, skippedByFrequency: checklist.skippedByFrequency, holdout: heldOut, g0Blocked: blockedList.length, cost: draft.cost, estGmv: draft.estGmv };
    } catch (e) { lastErr = e; await sleep(1000 * attempt); }
  }
  draft.status = 'failed';
  draft.fail_reason = String(lastErr && lastErr.message || lastErr);
  // 最终失败：逐收件人 sends 落失败终态（同键更新，不追加新行）
  for (const m of sendable) {
    store.recordSendRow({
      act_id: draft.act_id, campaign_id: draft.id, recipient: m.email,
      template: m.tier || 'standard', tag: ((m.recipient || {}).intent) || null,
      code: draft.coupon || null, tz: execution.tzForRecipient(m.recipient),
      gate_snapshot: gateSnapshot, status: 'failed'
    });
  }
  upsertDraftPreservingAsync(draft);
  metricsInc('send_fail');
  logEvent('send_fail', { recipients: sendable.length, error: draft.fail_reason });
  return { real: true, error: draft.fail_reason, recipients: (sendable || []).length, cost: draft.cost || 0, estGmv: draft.estGmv };
}

// —— 队列 handler：send_draft（POST /api/draft/:id/send 202 入队后的实际执行体）——
async function processSendJob({ job, payload }) {
  const draft = store.getDraft(payload.draftId);
  if (!draft) return { skipped: 'draft not found' };
  if (['sent', 'sending'].includes(draft.status)) return { skipped: 'already ' + draft.status };
  // —— Wave 3 I2：发送执行点统一停发检查（高于一切单批操作）——
  //   停发日历命中 → 顺延重排（复用 run_after，非永久拒绝）；紧急全停 → 跳过（job done，草稿保持 queued，
  //   商家明说「恢复吧」解除全停后需重新触发发送 —— 全停绝不自动恢复，也没有已知的恢复时刻可排）。
  const blocker = campaignsMod.sendBlocker(store);
  if (blocker) {
    if (blocker.kind === 'calendar') {
      const retryAt = blocker.retryAt || (Date.now() + 3600 * 1000);
      queue.enqueue({
        type: 'send_draft', payload: { draftId: draft.id },
        dedupeKey: 'send:sched:' + draft.id + ':' + retryAt, runAfter: retryAt
      });
      draft.status = 'queued';
      draft.scheduled_at = retryAt;
      upsertDraftPreservingAsync(draft);
      logEvent('send_deferred_blackout', { draft_id: draft.id, retry_at: retryAt, reason: blocker.reason });
      return { deferred: 'blackout', retry_at: retryAt, reason: blocker.reason };
    }
    return { skipped: 'global_paused', reason: blocker.reason };
  }
  const r = await sendDraft(draft);
  if (r && r.deferred) {
    // D4① 时段闸缓发：重新入队到下一个合理时段（复用 jobs 机制 run_after），非永久拒绝
    const retryAt = r.retryAt || (Date.now() + 3600 * 1000);
    const { job: next } = queue.enqueue({
      type: 'send_draft',
      payload: { draftId: draft.id },
      dedupeKey: 'send:sched:' + draft.id + ':' + retryAt,
      runAfter: retryAt
    });
    draft.status = 'queued';
    draft.scheduled_at = retryAt;
    upsertDraftPreservingAsync(draft);
    logEvent('send_deferred', { draft_id: draft.id, retry_at: retryAt, next_job_id: next.id });
    return { rescheduled: true, next_job_id: next.id, retry_at: retryAt, checklist: r.checklist };
  }
  // —— Wave 4 F3①/②：发送成功 → T+0 一句话回执 + T+24h 汇总 job 入队（sends 实发口径）——
  if (r && !r.error && (r.recipients > 0)) {
    enqueueReceipts({ userId: draft.user_id, actId: draft.act_id, draftId: draft.id, name: draft.audience || '挽回邮件', code: draft.coupon || null });
  }
  return r;
}

/* ===================== Wave 3 批次域（I1/I2/I3/I4）===================== */

// 批次圈人口径：与单方案同源（matchAudienceByDesc + filterTargetable），但拆批语义要求更细的意图切分——
// 「加购未付」「下单未付」必须拆成两批不同人群（I1），故先按最具体意图匹配，再回落 matchAudienceByDesc。
// 安全整改：scope = { userId, includeUnowned }，圈人只在归属域内（buildCampaignMatcher 绑定）。
function campaignMatcher(desc, scope) {
  const all = scope ? store.getAudienceForUser(scope.userId, scope) : store.getAudience();
  const d = (desc || '').toLowerCase();
  let list;
  if (/加购/.test(d)) list = all.filter(a => /加购/.test(a.intent));                       // 加购未付（不含弃购/下单未付）
  else if (/下单未付|弃购/.test(d)) list = all.filter(a => /弃购|下单未付/.test(a.intent)); // 下单未付/弃购
  else list = matchAudienceByDesc(desc, all);                                              // 其余回落单方案口径
  return filterTargetable(list).filter(r => r.email_status !== 'email_invalid' && r.email_status !== 'unsubscribed');
}
function buildCampaignMatcher(scope) { return (desc) => campaignMatcher(desc, scope); }

// I2 日历契约（GET /api/state / GET /api/blackout 共用）：active + 区间列表（并集判定在 sendBlocker 内）
function blackoutContract() {
  const ranges = store.getBlackouts().map(r => ({
    id: r.id, from: campaignsMod.isoDay(r.from), to: campaignsMod.isoDay(r.to - 1), label: r.label
  }));
  return { active: campaignsMod.activeBlackoutRange(store) != null, ranges };
}

// —— I3/I1 对话执行器（IGDE 注入缝；userId 按请求作用域；opts = { includeUnowned } 管理员可见域）——
// 返回结构化结果，人话组装在引擎侧（确定性边界声明/逐批复述不进模型话术层）。
function makeCampaignExecutor(userId, opts) {
  const scope = { userId: userId || null, includeUnowned: Boolean(opts && opts.includeUnowned) };
  const matcher = buildCampaignMatcher(scope);
  return {
    // —— Wave 4 F2：算账口径的人数/客单（audience 表聚合；客单缺省行业默认并标注 demo）——
    audienceStats(desc) {
      const list = matcher(desc || '');
      const vals = list.map(a => Number(a.abandoned_value) || 0).filter(v => v > 0);
      if (vals.length) {
        const total = vals.reduce((s, v) => s + v, 0);
        return { count: list.length, aov: +(total / vals.length).toFixed(2), aov_source: 'store', currency: 'USD' };
      }
      return { count: list.length, aov: cfg.INDUSTRY_DEFAULT_AOV, aov_source: 'demo', currency: 'USD' };
    },
    previewBatches(batches) {
      const { plans } = campaignsMod.planBatches(store, batches, { matcher, userId });
      return plans.map(p => ({
        name: p.name, audience_desc: p.audience_desc, offer_text: p.offer_text,
        percent_off: p.percent_off, reach_count: p.reach_count, excluded: p.excluded
      }));
    },
    async createBatches(batches, { exclusionOverride } = {}) {
      const r = await campaignsMod.createCampaigns(store, {
        batches, userId, matcher, connector: connectors,
        brand: (config.shopBrand && config.shopBrand !== 'CartBack') ? config.shopBrand : 'CartBack',
        exclusionOverride: Boolean(exclusionOverride)
      });
      return {
        campaigns: r.campaigns.map(c => campaignsMod.publicCampaign(store, c)),
        failures: r.failures, advice: r.advice
      };
    },
    resolveTarget(ref) {
      // 降级词表单批操作的目标预检：能解析到真实批次才让引擎接手（null = 回归正常对话）
      const camp = ref == null
        ? (store.getCampaignsByUser(userId).length === 1 ? store.getCampaignsByUser(userId)[0] : null)
        : campaignsMod.resolveCampaignRef(store, ref, userId);
      return camp ? { campaign_id: camp.id, name: camp.name } : null;
    },
    async campaignOp({ op, target, campaign_id, params }) {
      const camp = campaign_id
        ? store.getCampaign(campaign_id)
        : campaignsMod.resolveCampaignRef(store, target, userId);
      if (!camp || (camp.user_id ? camp.user_id !== userId : !(opts && opts.includeUnowned))) return { ok: false, reason: '没有找到这个批次（用「批次 A」或人话名指一下）', reason_not_found: true };
      if (op === 'pause') {
        const r = campaignsMod.pauseCampaign(store, camp, { scope: 'user' });
        if (!r.ok) return r;
        return { ok: true, name: camp.name, status: camp.status, boundary: campaignsMod.boundaryOf(camp, store) };
      }
      if (op === 'resume') {
        const r = campaignsMod.resumeCampaign(store, camp);
        if (!r.ok) return r;
        return { ok: true, name: camp.name, status: camp.status, boundary: campaignsMod.boundaryOf(camp, store) };
      }
      if (op === 'discount') {
        const r = await campaignsMod.changeDiscount(store, camp, { percentOff: params && params.percent_off, connector: connectors });
        if (!r.ok) return r;
        return {
          ok: true, name: camp.name, code: r.code, oldCode: r.oldCode, changed: r.changed,
          boundary: campaignsMod.boundaryOf(camp, store)
        };
      }
      if (op === 'exclude') {
        const r = campaignsMod.excludeFromCampaign(store, camp, { emails: params && params.emails, allOpened: Boolean(params && params.all_opened) });
        if (!r.ok) return r;
        return {
          ok: true, name: camp.name, excluded_count: r.excluded_count, rejected: r.rejected,
          boundary: campaignsMod.boundaryOf(camp, store)
        };
      }
      if (op === 'resend') {
        const r = await campaignsMod.resendCampaign(store, camp, {
          subject: (params && params.subject) || '', confirmFrequency: Boolean(params && params.confirm_frequency),
          connector: connectors, userId, brand: (config.shopBrand && config.shopBrand !== 'CartBack') ? config.shopBrand : 'CartBack'
        });
        if (!r.ok && r.needs_confirm) return { ...r, campaign_id: camp.id, name: camp.name };
        if (!r.ok) return r;
        return { ok: true, camp: campaignsMod.publicCampaign(store, r.camp) };
      }
      return { ok: false, reason: '未知操作：' + op };
    },
    pauseAll() { return campaignsMod.pauseAll(store); },
    resumeAll() { return campaignsMod.resumeAll(store); },
    // —— Wave 5 E1：大促季判定（停发日历命中区间 ±14 天 → 阈值放宽到 40%）——
    saleWindow() { return impulse.inSaleWindow(store); },
    // —— Wave 5 E1：坚持原折扣的审计留痕（events type='audit'）——
    audit({ kind, act_id, note } = {}) {
      return store.addEvent({
        type: 'audit', draft_id: act_id || null, audience_id: null,
        user_id: userId || null,
        value: 0, order_id: `${kind || 'e1'}:${String(note || '').slice(0, 120)}`, ts: Date.now()
      });
    },
    // —— Wave 5 I5：批次状态汇报数据源（publicCampaign 形状；stats 与 notify.campaignStats 同源）——
    listCampaignReports() {
      return store.getCampaignsByUser(userId).map(c => campaignsMod.publicCampaign(store, c));
    },
    addBlackout(params) {
      const parsed = campaignsMod.parseBlackoutRange(params || {});
      if (!parsed.ok) return parsed;
      const row = store.addBlackout({ user_id: userId || null, from: parsed.range.from, to: parsed.range.to, label: parsed.range.label });
      logEvent('blackout_added', { blackout_id: row.id, label: row.label });
      return { ok: true, range: { from: campaignsMod.isoDay(row.from), to: campaignsMod.isoDay(row.to - 1), label: row.label } };
    }
  };
}

// —— 批次五道闸门 / 发送执行（复用 execution 原语 + renderCampaign + ESP 适配器；sends 落 campaign_id=campaign.id）——
async function sendCampaignBatch(camp, { viaJob = false } = {}) {
  const gates = await campaignsMod.evaluateCampaignGates(store, camp, {
    connector: connectors, publicBaseUrl: config.publicBaseUrl
  });
  if (!gates.all_pass) {
    const failing = gates.items.filter(i => !i.pass);
    if (failing.length === 1 && failing[0].gate === 'window') {
      return { deferred: true, retryAt: gates.windowRetryAt, checklist: gates.items };
    }
    camp.status = camp.status === 'running' ? 'draft' : camp.status;
    camp.gate_note = '发送闸门未通过：' + failing.map(f => f.reason || f.label).join('；');
    store.upsertCampaign(camp);
    metricsInc('send_fail');
    logEvent('campaign_gate_fail', { campaign_id: camp.id, gates: failing.map(f => f.gate) });
    return { error: camp.gate_note, checklist: gates.items };
  }
  // holdout 冻结晚于排除（净值 pending 圈定；对照成员绝不写入 sends）
  const holdoutPlan = campaignsMod.freezeCampaignHoldouts(store, camp, gates.allow);
  const holdSet = new Set(store.getHoldouts({ campaign_id: camp.id }).map(h => String(h.recipient).toLowerCase()));
  const allow = gates.allow.filter(r => !holdSet.has(String(r.email).toLowerCase()));
  if (!allow.length) {
    camp.status = 'done';
    camp.gate_note = null;
    store.upsertCampaign(camp);
    return { recipients: 0, holdout: holdoutPlan.count, note: '没有可发送的未发收件人' };
  }
  const gateSnapshot = { items: gates.items, all_pass: true, at: Date.now(), timezone: gates.timezone };
  const real = (config.mode === 'real' && espReady());
  camp.status = 'running';
  store.upsertCampaign(camp);
  metricsInc('send_volume', allow.length);

  const recordRows = (recipients, status) => {
    for (const r of recipients) {
      store.recordSendRow({
        act_id: camp.act_id, campaign_id: camp.id, recipient: r.email,
        template: 'standard', tag: r.intent || null, code: (camp.discount && camp.discount.code) || null,
        tz: execution.tzForRecipient(r), gate_snapshot: gateSnapshot, status
      });
    }
  };

  if (!real) {
    // demo 仿真：与单方案同口径逐收件人落 sends（幂等键 campaign_id+recipient）
    recordRows(allow, 'sent');
    const c = campaignsMod.deriveCounts(store, camp);
    camp.status = c.pending === 0 ? 'done' : (gates.skippedByFrequency > 0 ? 'paused' : 'done');
    if (camp.status === 'paused') {
      camp.pause_scope = 'system';
      camp.resume_note = `频控窗口内 ${gates.skippedByFrequency} 人已触达，剩余未发明早再试`;
      camp.frozen_reason = null;
    }
    camp.scheduled_at = camp.status === 'done' ? 0 : camp.scheduled_at;
    camp.gate_note = null;
    store.upsertCampaign(camp);
    metricsInc('send_sim');
    logEvent('campaign_send', { campaign_id: camp.id, real: false, recipients: allow.length, skipped_by_frequency: gates.skippedByFrequency, holdout: holdoutPlan.count });
    return { real: false, recipients: allow.length, skippedByFrequency: gates.skippedByFrequency, holdout: holdoutPlan.count };
  }

  // 真实模式：渲染管线（变体→语种→模板→G0）+ ESP（复用 sendDraft 的适配器链）
  const percent = Number(camp.percent_off) || execution.resolveDiscountNum({ discount: camp.discount });
  const pseudoDraft = {
    id: camp.id, brand: camp.brand || resolveBrand({}), coupon: (camp.discount && camp.discount.code) || null,
    discount: percent, product: '', offer: camp.offer_text || '', audience: camp.audience_desc,
    html: '', locale: null
  };
  const variants = variantsMod.standardVariants({ brand: pseudoDraft.brand, discount: percent, coupon: pseudoDraft.coupon, product: '' });
  const rendered = await render.renderCampaign({
    draft: pseudoDraft, variants, recipients: allow,
    tagsOf: (r) => store.getAudienceTags(r.id),
    whitelist: g0Whitelist(), translateFn: translateText, cache: translationCache
  });
  const sendable = rendered.messages.filter(m => !m.blocked);
  const blockedList = rendered.messages.filter(m => m.blocked);
  if (blockedList.length) { metricsInc('g0_blocked', blockedList.length); logEvent('g0_intercept', { campaign_id: camp.id, blocked: blockedList.length }); }
  if (!sendable.length) {
    camp.status = 'draft';
    camp.gate_note = 'G0 语种护栏拦截了全部邮件（检出非白名单中文）';
    store.upsertCampaign(camp);
    return { error: camp.gate_note, g0Blocked: blockedList.length };
  }
  try {
    const sendViaEsp = (c) => {
      if (c.espProvider === 'brevo') return fetchBrevo(pseudoDraft, sendable, c);
      if (c.espProvider === 'smtp') return fetchSmtp(pseudoDraft, sendable, c);
      return fetchResend(pseudoDraft, sendable, c);
    };
    const r = await breakers.get('esp').exec(() => sendViaEsp(config));
    recordRows(sendable.map(m => ({ ...m, email: m.email })), 'sent');
    // Wave 4 F3：落 emailed 事件（esp_id → Resend 回执反查），打开/点击才能归因到批次（demo 路径无 ESP 回执）
    const espIds = Array.isArray(r.ids) ? r.ids : [];
    for (let i = 0; i < sendable.length; i++) {
      store.addEvent({
        type: 'emailed', draft_id: camp.id,
        audience_id: (sendable[i].recipient || {}).id || null,
        user_id: camp.user_id || null,
        esp_id: espIds[i] || null, ts: Date.now()
      });
    }
    const c2 = campaignsMod.deriveCounts(store, camp);
    camp.status = c2.pending === 0 ? 'done' : 'running';
    camp.scheduled_at = camp.status === 'done' ? 0 : camp.scheduled_at;
    camp.gate_note = null;
    store.upsertCampaign(camp);
    metricsInc('send_real');
    logEvent('campaign_send', { campaign_id: camp.id, real: true, recipients: sendable.length, g0_blocked: blockedList.length });
    return { real: true, recipients: sendable.length, g0Blocked: blockedList.length, esp_id: r.id };
  } catch (e) {
    // 失败不落 sends（重试只补未发者；recordSendRow 幂等键防重）
    camp.status = 'running';
    camp.gate_note = '发送失败：' + String(e && e.message || e).slice(0, 160);
    store.upsertCampaign(camp);
    return { error: camp.gate_note, retryable: true };
  }
}

// —— 队列 handler：send_campaign（批次发送 job；暂停批次不执行；停发命中 → 冻结不删）——
async function processCampaignSendJob({ job, payload }) {
  const camp = store.getCampaign(payload.campaignId);
  if (!camp) return { skipped: 'campaign not found' };
  if (camp.status === 'paused') return { skipped: 'paused', reason: '暂停批次的 job 不执行' };
  if (camp.status === 'done') return { skipped: 'done' };
  // I2：发送执行点统一停发检查（高于一切单批操作）
  const blocker = campaignsMod.sendBlocker(store);
  if (blocker) {
    if (camp.status !== 'frozen') camp.prev_status = camp.status === 'running' ? 'scheduled' : camp.status;
    camp.status = 'frozen';
    camp.freeze_scope = blocker.kind === 'global' ? 'global' : 'calendar';
    camp.frozen_reason = blocker.reason;
    camp.updated_at = Date.now();
    store.upsertCampaign(camp);
    logEvent('campaign_frozen', { campaign_id: camp.id, kind: blocker.kind });
    return { frozen: true, kind: blocker.kind, reason: blocker.reason };
  }
  const r = await sendCampaignBatch(camp, { viaJob: true });
  if (r && r.deferred) {
    // 时段闸缓发：run_after 重新入队（复用 queue 定时，勿绕过）
    const retryAt = r.retryAt || (Date.now() + 3600 * 1000);
    queue.enqueue({
      type: 'send_campaign', payload: { campaignId: camp.id },
      dedupeKey: 'send_campaign:' + camp.id + ':' + retryAt, runAfter: retryAt
    });
    camp.status = 'scheduled';
    camp.scheduled_at = retryAt;
    store.upsertCampaign(camp);
    logEvent('campaign_send_deferred', { campaign_id: camp.id, retry_at: retryAt });
    return { rescheduled: true, retry_at: retryAt };
  }
  // —— Wave 4 F3①/②：批次发送成功 → T+0 一句话回执 + T+24h 汇总 job 入队（sends 实发口径）——
  if (r && !r.error && (r.recipients > 0)) {
    enqueueReceipts({ userId: camp.user_id, actId: camp.act_id, campaignId: camp.id, name: camp.name, code: (camp.discount && camp.discount.code) || null });
  }
  return r;
}

// —— Wave 2 D3：草稿创建唯一实现（confirm 同源路径与 /api/draft 兼容路径共用）——
// authoritative=true：card 来自 act.execution_snapshot/confirm 权威序列化，estGmv/matchedCount 直接取卡上口径，
// 保证「卡 ↔ 草稿」四字段（audience/discount/count/estGmv）逐字段相等（闸门⑤ diff=0 的前提）。
async function createDraftFromCard(card, { actId = null, userId = null, authoritative = false, draftId = null } = {}) {
  const scope = ownerScope(userId);
  const net = audienceNetList(card.audience, scope);
  const estGmv = authoritative && card.estGmv ? card.estGmv.amount : +net.reduce((s, a) => s + (a.estGmv || 0), 0).toFixed(2);
  const matchedCount = authoritative ? (Number(card.reach_count) || net.length) : net.length;
  const conditions = audienceConditions(card.audience, scope);
  // ⑥ 竞品套路卡检索（G6：只出结构卡，raw_email 绝不外发）+ 基准库 Top-3
  const refCards = competitorsMod.topCards(store, userId, { audience: card.audience, discount: card.discount, k: 3 });
  const benchLib = benchmarkMod.getBenchmark(store);
  const benchHits = benchmarkMod.queryBenchmark(benchLib, { audience: card.audience, discount: card.discount, k: 3 });
  // ④ 变体生成：需求（act.needs 纯字符串视图）× 标签分布 → 一次调用出三档；AI 离线全落标准三档
  const act = actId ? store.getAct(actId) : null;
  const needs = needsMod.plainNeeds((act && act.needs) || {});
  const tagDist = tagsMod.tagDistribution(store, net);
  const discountNum = execution.resolveDiscountNum(card);
  const draftFacts = {
    // M4 品牌链：设置页 shopBrand（非默认）> 方案卡 brand > CartBack 兜底；固化到 draft.brand
    brand: resolveBrand(card),
    // 折扣数值唯一出处 = 方案卡 discountNum（% off；0 = 无钩子方案，文案不虚报折扣）
    discount: discountNum,
    coupon: card.coupon,
    // M6 商品位：方案卡 product > 风格品类标签兜底（避免变体里商品位永远为空）
    product: card.product || productFallbackFor({ tag_distribution: tagDist }), offer: card.offer || ''
  };
  const llmJSON = config.aiKey ? async (messages) => {
    const r = await breakers.get('llm').exec(() => makeLlmClient().chatStructured({ messages, maxTokens: 2048 }));
    return { reply: r.reply, needs: r.needs, jsonOk: r.jsonOk, raw: r.raw };
  } : null;
  const strategyHints = refCards.map(c => ({ theme_formula: c.theme_formula, angle: c.angle, discount_range: c.discount_range, timing: c.timing }));
  const v = await variantsMod.generateVariants({ draft: draftFacts, needs, llmJSON, strategyHints, tagDist });
  if (v.warning) logEvent('variants_fallback', { warning: v.warning });
  metricsInc(v.provider === 'llm' ? 'variants_llm' : 'variants_standard');
  // M5 口径护栏：加购未付人群的主题禁 order/purchase 措辞（生成侧规则 + 出口兜底双保险）
  for (const variant of v.variants) variant.subject = applySubjectTone(variant.subject, card.audience);
  const draft = {
    id: draftId || uid('dr_'), act_id: actId || null,
    subject: applySubjectTone(card.subject, card.audience), body: card.body, audience: card.audience,
    // 数值口径（% off）：变体/逐收件人渲染统一读数值；「给什么钩子」的展示文案在 planCard.discount
    discount: discountNum,
    coupon: card.coupon, posters: card.posters,
    estGmv, matchedCount, sendTiming: card.sendTiming || null,
    tag_distribution: tagDist,   // 圈中受众的标签分布快照（邮件卡展示产品分类/年龄段/机型代表值）
    brand: draftFacts.brand,     // M4 白标快照（落款/页脚/发件人名/图片 alt 统一品牌位）
    product: draftFacts.product, // M6 商品位快照（变体渲染复用）
    status: 'draft', created_at: Date.now(), sent_at: null, esp_message_id: null, cost: 0,
    user_id: userId || null,
    locale: card.locale || null,
    html: '', image_path: '',   // 待异步生成
    variants: v.variants, variants_provider: v.provider,
    strategy_card_ids: refCards.map(c => c.id),
    audience_conditions: conditions
  };
  store.upsertDraft(draft);

  // 同步生成 HTML 邮件 + 营销图片（标准档直出 html；变体在发送环节逐收件人渲染）
  try {
    await generateMailHtml(draft, card);
    draft.image_path = draft.image_path || '';
    store.upsertDraft(draft);
  } catch (err) {
    draft.html = 'ERROR: ' + (err.message || err);
    draft.image_path = '';
    store.upsertDraft(draft);
  }
  return { draft, estGmv, matchedCount, conditions, tagDist, refCards, benchHits, variants_provider: v.provider };
}

// —— Wave 2 E2/D3：S2 确认动作（POST /api/act/:id/confirm 的执行体）——
// 时序前置：S2 确认通过后、D3 出卡前，先调店铺 API 真实建码；
//   成功（created/reused）或无钩子（none）→ 服务端同源序列化 planCard + 冻结 execution_snapshot + 建 draft，stage→S3；
//   建码失败 → 409（不出卡、不建 draft、停留 S2，明示原因与三条出口）；
//   未连接店铺 → 过渡期出无钩子卡（明示「未创建折扣码：连接店铺后可补」）。
// 共同红线：卡面上绝不出现未真实存在的折扣码（code 一律取店铺连接器真实回执）。
const CONFIRM_FAIL_OPTIONS = ['重试建码', '改用店内现成码', '改发无钩子提醒信'];

function checklistContract(raw, { frozen = false, note = null } = {}) {
  const holdout = {
    frozen: Boolean(frozen),
    count: raw.holdoutPlan.count,
    ratio: raw.holdoutPlan.ratio
  };
  const n = note != null ? note : raw.holdoutPlan.note;
  if (n) holdout.note = n;
  return { items: raw.items, all_pass: raw.all_pass, holdout };
}

// —— Wave 2：S2 消息轮的「无码预览卡」升级为 planCard 权威形状（与 confirm 出卡同构，前端同一组件渲染）——
// base（igde 基础卡，discount 为文案字符串）→ 补 reach_count/estGmv/signature/discount 对象（code_status=pending）。
// S3 轮回传的 act.plan_card 已是权威形状，原样返回。
function withAuthoritativePreview(act, planCard) {
  if (!planCard || (planCard.discount && typeof planCard.discount === 'object')) return planCard;
  const wrapped = execution.buildPlanCard({
    base: planCard, code: null, codeStatus: 'pending',
    reachCount: audienceNetList(planCard.audience, ownerScope(act.user_id)).length,
    extras: (act.memory && Array.isArray(act.memory.extras)) ? act.memory.extras : [],
    brand: resolveMerchantBrand(act),
    unsubscribeOk: Boolean(config.publicBaseUrl)
  });
  if (!config.visionKey) wrapped.skip_image = true;
  wrapped.brand = resolveMerchantBrand(act);
  return wrapped;
}

// —— A2/D1（复测 10-03 P0-N2 配套）：S2 无码预览卡落库（打 preview 标记）——
// 满 4/4 当轮的确认卡此前只随 done 帧下发、不落库，刷新后 /api/state 无卡可召回，
// 商家走完采集却找不到确认入口。落库后前端刷新即可按 act.plan_card 重现确认卡（A2「刷新不丢方案卡」）。
// Z4 last_plan 只认确认过的卡（preview 标记被跳过，未确认会话不污染「上次方案」摘要）。
function persistPreviewCard(act, result) {
  if (!result || !result.planCard || act.stage !== 'S2') return;
  act.plan_card = { ...result.planCard, preview: true };
  store.upsertAct(act);
}

async function confirmActToStage3(act, body = {}, userId = null) {
  needsMod.migrateAct(act);
  const locale = config.shopDefaultLocale || 'en';
  const extras = (act.memory && Array.isArray(act.memory.extras)) ? act.memory.extras : [];

  // 幂等重确认：S3 且快照/卡/草稿都在 → 回已有权威卡（重确认不是新方案，不重复建码）
  if (act.stage === 'S3' && act.execution_snapshot && act.plan_card && !(body && (body.nohook || body.reuse_code))) {
    const existing = act.plan_card.draft_id ? store.getDraft(act.plan_card.draft_id) : null;
    if (existing) {
      const raw = await execution.evaluateChecklist({ act, draft: existing, store, config, connector: connectors, recipients: audienceNetList(existing.audience, ownerScope(act.user_id)) });
      const cc = checklistContract(raw, { frozen: false, note: (raw.holdoutPlan.note || '发送放行时冻结') });
      return { ok: true, repeated: true, act, planCard: act.plan_card, checklist: cc, holdout: cc.holdout, draft_id: existing.id, draft: existing };
    }
  }
  if (act.stage === 'closed') return { ok: false, status: 409, error: '会话已收尾归档，不能再确认' };
  if (needsMod.missingSlots(act.needs).length) return { ok: false, status: 409, error: '四项要素还没齐（针对谁/为什么挽回/给什么钩子/要什么结果），先在对话里补全再确认' };

  const offerText = needsMod.slotText(act.needs, 'offer');
  let codeStatus = 'none';
  let code = null;
  let percent = execution.parseOfferPercent(offerText); // null = 非折扣型钩子（包邮/赠品/无额外优惠…）
  let note = null;
  let createError = null;

  if (body && body.nohook === true) {
    // 无钩子重试出口：跳过建码，出无钩子卡
    codeStatus = 'none';
    percent = 0;
    note = '改发无钩子提醒信：未创建折扣码';
  } else if (body && typeof body.reuse_code === 'string' && body.reuse_code.trim()) {
    // 自带码出口：校验存在且有效后出卡（code_status=reused）
    const want = body.reuse_code.trim().toUpperCase();
    if (!connectors || !connectors.supportsDiscountCodes || !connectors.supportsDiscountCodes()) {
      createError = '店铺未连接，无法校验现成折扣码「' + want + '」';
    } else {
      try {
        const hit = await connectors.verifyDiscountCode(want);
        if (!hit) createError = '店内没有找到可用折扣码「' + want + '」，请确认码名后再试';
        else {
          codeStatus = 'reused';
          code = String(hit.code).toUpperCase();
          percent = Number(hit.percent_off) || percent || 10;
        }
      } catch (e) {
        createError = '店铺校验折扣码失败或超时：' + String(e && e.message || e).slice(0, 140);
      }
    }
  } else if (percent != null && percent > 0) {
    if (!connectors || !connectors.supportsDiscountCodes || !connectors.supportsDiscountCodes()) {
      // 未连接店铺 → 过渡期：允许出无钩子 planCard（不含折扣码，卡上明示），发送入口保留
      codeStatus = 'none';
      percent = 0;
      note = '未创建折扣码：连接店铺后可补';
    } else {
      // E2 主路径：先建码后出卡；每次方案新建码不复用历史码；code 必须来自店铺真实回执
      const named = execution.parseOfferCodeName(offerText);
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !code; attempt++) {
        const candidate = (named && attempt === 0) ? named : 'COMEBACK-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        try {
          const receipt = await connectors.createDiscountCode({ code: candidate, percent_off: percent });
          codeStatus = 'created';
          code = String(receipt.code).toUpperCase();   // 真实回执优先（禁止本地拼）
          percent = Number(receipt.percent_off) || percent;
        } catch (e) {
          lastErr = e;
          // 用户指定码名重名/失败 → 换系统随机码再试；随机码仍失败 → 走失败出口
          if (!(named && attempt === 0)) break;
        }
      }
      if (!code) createError = '店铺建码失败：' + String(lastErr && lastErr.message || lastErr || '未知原因').slice(0, 160);
    }
  }

  // —— E2 失败分支：planCard 不出卡（卡不出、不发），停留 S2，明示原因与三条出口 ——
  if (createError) {
    act.code_status = 'failed';
    act.stage = 'S2';
    act.execution_snapshot = null;
    act.plan_card = null;
    store.upsertAct(act);
    return { ok: false, status: 409, code_status: 'failed', reason: createError, options: CONFIRM_FAIL_OPTIONS, act };
  }

  // —— 成功路径：服务端同源序列化（先序列化 JSON，卡面渲染与草稿渲染都读这一份）——
  const effectivePercent = (codeStatus === 'created' || codeStatus === 'reused') ? (Number(percent) || 0) : 0;
  const base = igde.producePlanCard(act, { locale, code, codeStatus });
  base.discountNum = effectivePercent;
  const brand = resolveMerchantBrand(act);
  const reachCount = audienceNetList(base.audience, ownerScope(act.user_id)).length;
  const draftId = uid('dr_');
  const planCard = execution.buildPlanCard({
    base, code, codeStatus, reachCount, extras, brand,
    unsubscribeOk: Boolean(config.publicBaseUrl), draftId, note,
    sendWindowText: null
  });
  if (!config.visionKey) planCard.skip_image = true; // 未配图像 AI：出卡不跑图片生成（离线确定性）
  planCard.brand = brand;                            // 草稿/mailgen 品牌链消费（内部键）
  act.execution_snapshot = execution.serializeSnapshot(planCard); // D3 四字段快照冻结（闸门⑤ diff 依据）
  act.plan_card = planCard;
  act.stage = 'S3';
  act.code_status = codeStatus;
  // —— Wave 4 A3①：S2 确认通过 → 方案关键参数沉淀进 act.memory.prefs（下次「照上次的来」可复用）——
  // 值一律字符串化（memory.prefs 经 normalizeMemory 收口为字符串 map；数值读取侧 Number() 还原）
  act.memory = needsMod.ensureMemory(act.memory);
  act.memory.prefs = {
    audience: String(planCard.audience || ''),
    reason: String(planCard.reason || ''),
    goal: String(planCard.goal || ''),
    // offer 原文取方案卡 needs 纯字符串视图（planCard 顶层无 offer 键；needs.offer = 用户原话钩子，可复用预填）
    offer_text: String((planCard.needs && planCard.needs.offer) || planCard.offer || ''),
    discount_percent: String((planCard.discount && planCard.discount.percent_off) || 0),
    discount_text: String((planCard.discount && planCard.discount.text) || ''),
    code_status: String(codeStatus || 'none'),
    brand: String(brand || ''),
    signature: String(brand || ''),      // 署名习惯（A3①；与 brand 同值，前端署名卡直读）
    act_id: act.id,
    confirmed_at: String(Date.now()),
    source: 'confirm'
  };
  store.upsertAct(act);

  const created = await createDraftFromCard(planCard, { actId: act.id, userId, authoritative: true, draftId });
  const draft = created.draft;

  // confirm 时闸门预检一次返回；holdout 先圈定展示但不落库（真正落库冻结在 send 放行时）
  const raw = await execution.evaluateChecklist({ act, draft, store, config, connector: connectors, recipients: audienceNetList(draft.audience, ownerScope(act.user_id)) });
  const cc = checklistContract(raw, { frozen: false, note: (raw.holdoutPlan.note || '发送放行时冻结') + '；确认后名单变动不影响，冻结以放行时刻为准' });
  return { ok: true, act, planCard, checklist: cc, holdout: cc.holdout, draft_id: draft.id, draft };
}

// G6：策略卡对外形态——原文（raw_email）绝不出库，只出结构卡
function publicCard(c) {
  const { raw_email, ...rest } = c;
  return { ...rest, raw_retained: Boolean(raw_email) };
}

const POSTERS_DIR = require('path').join(__dirname, 'output', 'posters');
// —— 队列 handler：posters（wanx 优先，失败占位；经熔断快速失败降级）——
async function processPosterJob({ job, payload }) {
  const draft = store.getDraft(payload.draftId);
  if (!draft) return { skipped: 'draft not found' };
  const t2i = async (prompt) => breakers.get('poster').exec(() => postersMod.wanxText2Image({
    prompt, apiKey: config.visionKey, baseUrl: config.visionBaseUrl || 'https://dashscope.aliyuncs.com/api/v1',
    model: config.visionModel || 'wan2.6-t2i'
  }));
  const r = await postersMod.generatePosters({ draft, config, outDir: POSTERS_DIR, t2iFn: config.visionKey ? t2i : null });
  draft.posters = r.posters;
  store.upsertDraft(draft);
  metricsAdd({ posters_generated: r.posters.filter(p => p.method === 'wanx').length, posters_placeholder: r.posters.filter(p => p.method === 'placeholder').length });
  logEvent('posters_done', { draft_id: draft.id, methods: r.posters.map(p => p.method) });
  return { posters: r.posters.map(p => ({ method: p.method, url: p.url })) };
}

// —— CSV 导入解析（RFC 4180：支持 "引用字段" 内含逗号/换行/转义引号 ""） ——
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // 转义引号 ""
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const hasHeader = header.includes('email');
  const start = hasHeader ? 1 : 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });
    if (!hasHeader) { row.name = (cols[0] || '').trim(); row.email = (cols[1] || '').trim(); }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email || '')) continue;
    out.push({
      name: row.name || row.email.split('@')[0],
      email: row.email,
      intent: row.intent || '导入',
      risk: row.risk || '中',
      price: row.price || '中',
      abandoned_value: parseFloat(row.abandoned_value) || 0,
      style: tagsMod.normalizeStyle(row.style) || null,   // 风格品类列（tech/fashion/business/outdoor，含中文别名）
      gender: tagsMod.normalizeGender(row.gender) || null,          // 性别列（female/male/other，含中文别名）
      age_range: row.age_range || null,                              // 年龄段原样（18-24/25-34/…）
      device: row.device || null,                                    // 设备原样（iPhone 15 等）
      customer_segment: tagsMod.normalizeSegment(row.customer_segment) || null, // 客户分层 new/returning/vip
      locale: row.locale || null,                                    // 语种（language 标签来源，en-US/en/zh…）
      source: 'import'
    });
  }
  return out;
}

// —— HTTP 工具 ——
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
// 邮件 HTML 内插转义（收件人名等来自不可信导入数据；personalizeHtml 对最终 HTML 做原串替换）
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

// —— 路由 ——（纯 /api；静态前端已拆分到独立 Next.js 应用）
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS（收紧：仅同源 localhost；§6.3）
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-local-token');
  }
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 静态前端已拆分到独立 Next.js 应用（../frontend）；本服务仅 /api
  if (!pathname.startsWith('/api/')) { res.writeHead(404); res.end('Not Found'); return; }

  // 鉴权：bootstrap 与 /api/auth/* 豁免；业务端点解析会话 cookie，回退 x-local-token（老前端零破坏，整改 1a）
  // /api/attribution 为真实 ESP webhook 回执，豁免全局鉴权、端点内用 webhook secret 校验（整改 2）
  if (pathname !== '/api/bootstrap' && !pathname.startsWith('/api/auth/') && pathname !== '/api/attribution' && !pathname.startsWith('/api/image/') && pathname !== '/api/health' && !pathname.startsWith('/api/email/')) {
    const who = authMod.resolveUser(req, store, config);
    if (!who) return sendJson(res, 403, { error: 'unauthorized' });
    req.userId = who.userId;
    req.authMode = who.authMode;
  }

  try {
    // —— bootstrap：配置状态；token 仅本地开放模式（CARTBACK_OPEN_LOCAL=1）下发 ——
    if (pathname === '/api/bootstrap' && method === 'GET') {
      return sendJson(res, 200, { token: authMod.OPEN_LOCAL ? config.localToken : null, status: cfg.status(config) });
    }

    // —— 用户认证（架构方案 v4 D7；会话 cookie 优先，x-local-token 兼容过渡）——
    function publicUser(u) { return { id: u.id, email: u.email, name: u.name, status: u.status, created_at: u.created_at }; }
    function issueSession(userId) {
      const token = authMod.newToken();
      store.createSession({ token_hash: authMod.hashToken(token), user_id: userId });
      authMod.setSessionCookie(res, token); // 云存档：Max-Age 10 年
      return token;
    }
    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!regRateOk(clientIp(req))) return sendJson(res, 429, { error: '注册过于频繁，请稍后再试' });   // 整改 3
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: '邮箱格式不正确' });
      // 密码格式限制已移除（前端守卫保证非空）；如需恢复强度校验在此加回
      if (!name || name.length > 40) return sendJson(res, 400, { error: '昵称不能为空且不超过 40 字' });
      if (store.getUserByEmail(email)) return sendJson(res, 409, { error: '该邮箱已注册' });
      const user = store.createUser({ email, name, password_hash: authMod.hashPassword(password), status: 'active' });
      issueSession(user.id);
      logEvent('auth_register', { userId: user.id, email: user.email });
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (authMod.isLoginLocked(email)) return sendJson(res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
      const user = store.getUserByEmail(email);
      if (!user || !authMod.verifyPassword(password, user.password_hash)) {
        authMod.noteLoginFail(email);
        return sendJson(res, 401, { error: '邮箱或密码错误' });
      }
      if (user.status === 'disabled') return sendJson(res, 403, { error: '账号已被禁用，请联系支持' });
      authMod.noteLoginOk(email);
      issueSession(user.id);
      logEvent('auth_login', { userId: user.id });
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = authMod.parseCookies(req)[authMod.SESSION_COOKIE];
      if (token) {
        const s = store.findSessionByTokenHash(authMod.hashToken(token));
        if (s) store.deleteSession(s.id);
      }
      authMod.clearSessionCookie(res);
      logEvent('auth_logout', {});
      return sendJson(res, 200, { ok: true });
    }
    // —— 退出所有设备（整改 5：会话云存档永久，cookie 丢失时靠它回收全部旧会话）——
    if (pathname === '/api/auth/logout-all' && method === 'POST') {
      const who = authMod.resolveUser(req, store, config);
      if (!who) return sendJson(res, 401, { error: '未登录' });
      store.deleteSessionsByUser(who.userId);
      authMod.clearSessionCookie(res);
      logEvent('auth_logout_all', { userId: who.userId });
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      const who = authMod.resolveUser(req, store, config);
      if (!who) return sendJson(res, 401, { error: '未登录' });
      const u = store.getUserById(who.userId);
      return sendJson(res, 200, { user: u ? publicUser(u) : null, authMode: who.authMode });
    }
    if (pathname.startsWith('/api/auth/')) return sendJson(res, 404, { error: 'auth route not found' });

    // —— state：首屏数据（整改 1c：acts/drafts/KPI/趋势按当前用户过滤；audience 店铺级共享）——
    if (pathname === '/api/state' && method === 'GET') {
      // Wave 3 I2：读点对账停发日历（窗口已过 → 日历冻结批次自动顺延恢复 + resume_note 提示）
      campaignsMod.reconcileBlackout(store);
      // Wave 4（契约①）：welcome（F1 欢迎语资格）/ prefs（A3）/ last_plan（A3④）/ store_banner（F1 数据开场句）
      const extras = buildStateExtras(req.userId, scopeOpts(req));
      const storeBanner = await buildStoreBanner(req.userId, scopeOpts(req));
      const so = scopeOpts(req);
      return sendJson(res, 200, {
        status: cfg.status(config),
        engine: engineOnline() ? 'online' : 'degraded',   // PRD v2：llm 熔断 closed→online，open/half-open→degraded
        acts: store.getActsByUser(req.userId, so),
        drafts: store.getDraftsByUser(req.userId, so),
        audience: store.getAudienceForUser(req.userId, so),   // 安全整改：受众含客户邮箱，按账号隔离
        kpis: store.getKpis(config.mode, req.userId, so),
        week: store.getKpisWeek(config.mode, req.userId, 7 * 86400000, so),   // UI v4 整改 2：叙事条本周口径
        trend: store.getTrend(req.userId, so),
        metrics: loadMetrics(),
        demoAnchorRoi: 24.9,
        // —— Wave 3 批次域契约③ ——
        campaigns: store.getCampaignsByUser(req.userId).map(c => campaignsMod.publicCampaign(store, c)),
        blackout: blackoutContract(),
        global_paused: campaignsMod.getGlobalPaused(store),
        // —— Wave 4 契约① ——
        welcome: extras.welcome,
        prefs: extras.prefs,
        last_plan: extras.last_plan,
        store_banner: storeBanner,
        // —— Wave 5 A4 契约①：商家待办列表（{id, summary, act_id, created_at, done}，未 done 倒序 ≤20）——
        todos: extras.todos
      });
    }

    if (pathname === '/api/agent-profile' && method === 'GET') {
      return sendJson(res, 200, { profile: normalizeAgentProfile(store.getAgentProfile(req.userId)) });
    }
    if (pathname === '/api/agent-profile' && method === 'DELETE') {
      store.deleteAgentProfile(req.userId);
      return sendJson(res, 200, { ok: true, profile: {} });
    }

    // —— Wave 4 F3④：通知中心（回执气泡由前端从通知拉取渲染，不写 act.messages，无需改 SSE）——
    if (pathname === '/api/notifications' && method === 'GET') {
      const so = scopeOpts(req);
      return sendJson(res, 200, {
        ok: true,
        items: store.getNotifications(req.userId, 50, so),   // created_at 倒序，≤50
        unread: store.unreadNotificationCount(req.userId, so)
      });
    }
    if (pathname === '/api/notifications/read' && method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;   // 缺省全标已读
      const marked = store.markNotificationsRead(req.userId, ids, scopeOpts(req));
      return sendJson(res, 200, { ok: true, marked, unread: store.unreadNotificationCount(req.userId, scopeOpts(req)) });
    }

    // —— Wave 5 A4 契约②：点待办 → 用原 act 数据开新会话预填（{ok, act}；幂等：已 done → 409）——
    const todoRe = pathname.match(/^\/api\/todos\/([\w-]+)\/resume$/);
    if (todoRe && method === 'POST') {
      const todo = store.getTodo(todoRe[1]);
      if (!todo || !canSeeRow(todo, req)) return sendJson(res, 404, { error: 'todo not found' });
      if (todo.done) return sendJson(res, 409, { ok: false, error: '该待办已恢复过（幂等：不重复开新会话）' });
      const src = todo.act_id ? store.getAct(todo.act_id) : null;
      if (!src || !canSeeRow(src, req)) return sendJson(res, 404, { error: '原会话已不存在，无法恢复' });
      const now = Date.now();
      const newAct = zombie.buildResumedAct(src, { now });
      if (req.userId) newAct.user_id = req.userId;
      // 新建会话语义：该用户其它未收口会话置 closed（原 act 已 closed 保持）
      store.closeOpenActs(newAct.user_id || null, newAct.id, scopeOpts(req));
      store.upsertAct(newAct);
      store.markTodoDone(todo.id);
      logEvent('todo_resumed', { todo_id: todo.id, from_act: src.id, to_act: newAct.id });
      return sendJson(res, 200, { ok: true, act: store.getAct(newAct.id) });
    }

    // —— 创建引导会话（支持 preset 预选受众：受众模块「点开画像跳配置」）——
    if (pathname === '/api/act' && method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      // Wave 4 F1：欢迎语资格在新建前判定（该商家名下不存在任何 act，含 closed）——一生只出现一次
      const hasAnyAct = store.getActsByUser(req.userId, scopeOpts(req)).length > 0;
      const storeBanner = await buildStoreBanner(req.userId, scopeOpts(req));
      const act = {
        id: uid('act_'), stage: 'S0', needs: needsMod.emptyNeeds(), messages: [],
        memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: needsMod.emptyAskCount() },
        context_summary: null, summary_cursor: 0, context_version: 1,
        code_status: 'none',       // Wave 2 E2：优惠码生命周期（none→pending→created/reused/failed；confirm 时推进）
        filled_count: 0,           // 派生字段：四槽 value 非空数（store.upsertAct 落库时重算并保证单调不减）
        status: 'active', created_at: Date.now(), updated_at: Date.now(),
        user_id: req.userId || null   // 整改 1c：打归属
      };
      const op = igde.opening({ hasAnyAct, storeBanner });
      act.messages.push({ role: 'assistant', content: op.reply, ts: Date.now() });
      // Wave 2 closed 触发点（Wave 1 遗留补齐）：新建会话时把该用户旧的无 closed act 置 stage=closed（只读归档）
      store.closeOpenActs(req.userId || null, act.id, scopeOpts(req));
      // 注入防御：preset.audience 是不可信输入 —— 收口（去控制符/折叠空白/限长），
      // 疑似注入话术（忽略指令/角色切换/索要系统提示词）直接忽略该预选，走正常开场。
      if (body.preset && typeof body.preset.audience === 'string' && body.preset.audience.trim()) {
        const presetAud = igdeMod.clampNeedValue(body.preset.audience);
        if (presetAud && !igdeMod.looksLikeInjection(presetAud)) {
          igde.applyNeeds(act, { audience: presetAud });
          act.stage = 'S1';
          act.messages.push({ role: 'assistant', content: `收到，这次针对【${act.needs.audience.value}】。还想知道：他们为啥快丢、你希望他们回来干啥、想给什么钩子？`, ts: Date.now() });
        }
      }
      store.upsertAct(act);
      // Wave 4 契约④：chips 随开场下发；welcome 标识本条是否拼了欢迎语（前端eligible=false时不显示）
      return sendJson(res, 200, { act, chips: op.chips || [], welcome: Boolean(op.welcome), store_banner: storeBanner });
    }

    // —— 新流失主动提醒（环节⑥：监控新弃购/高意向，主动冒给 agent；安全整改：受众按账号隔离）——
    if (pathname === '/api/opportunities' && method === 'GET') {
      const so = scopeOpts(req);
      const aud = store.getAudienceForUser(req.userId, so);
      const high = aud.filter(a => (a.score || 0) >= 0.7);
      const sent = store.getDraftsByUser(req.userId, so).filter(d => ['sent', 'recovering'].includes(d.status));
      const targeted = new Set(sent.map(d => (d.audience || '').toLowerCase()));
      const untargeted = high.filter(a => !targeted.has((a.intent || '').toLowerCase()));
      // 「新流失」计数按用户隔离（audience 为店铺级共享，但上次看过的基数是各用户自己的）
      const oppKey = 'opp_last_seen:' + (req.userId || 'anon');
      const lastSeen = parseInt(store.getMeta(oppKey) || '0', 10);
      const newCount = Math.max(0, aud.length - lastSeen);
      const opportunities = untargeted.slice(0, 5).map(a => ({
        id: a.id, name: a.name, intent: a.intent, estGmv: a.estGmv, urgencyDays: a.urgencyDays
      }));
      store.setMeta(oppKey, String(aud.length));
      const message = newCount > 0
        ? `又有 ${newCount} 个高意向快丢了，捞吗？`
        : (untargeted.length ? `还有 ${untargeted.length} 拨高意向人群没发过挽回，捞吗？` : '当前高意向人群都已覆盖，稳。');
      return sendJson(res, 200, { total: high.length, untargeted: untargeted.length, newCount, message, opportunities });
    }

    // —— 对话消息：IGDE 驱动 ——
    const m = pathname.match(/^\/api\/act\/([\w-]+)\/message$/);
    if (m && method === 'POST') {
      const act = store.getAct(m[1]);
      if (!canSeeRow(act, req)) return sendJson(res, 404, { error: 'act not found' });
      // 安全整改：普通用户每日 AI 额度（防免费账号无限烧 Token Plan；管理员不受限）
      if (!isAdminReq(req) && !llmQuotaTry(req.userId, 1)) {
        return sendJson(res, 429, { error: '今日 AI 使用额度已用完（每用户每日 ' + (config.userLlmDailyLimit || 0) + ' 轮），请明天再试或联系管理员。' });
      }
      const body = await readBody(req);
      igde.aiEnabled = !!config.aiKey; // 动态：配了 key 走真模型，否则桩
      syncAgentConfig();
      // 邮件语种 = 店铺默认语种（收件人逐人本地化在发送环节 renderForRecipient 做）
      // B3 记账：persist 回调在引擎内「先落库后回复」；落库失败 → 503（不落库不回复）
      try {
        const r = await igde.handle(act, (body.message || '').toString().slice(0, 2000), {
          locale: config.shopDefaultLocale || 'en',
          agentProfile: store.getAgentProfile(req.userId),
          executors: makeCampaignExecutor(req.userId, scopeOpts(req)),   // Wave 3：批次/运维执行器（按请求注入，带 userId 作用域）
          reusePrefs: latestPrefsFor(req.userId, act.id, scopeOpts(req)),   // Wave 4 A3②：复用意图的 prefs 数据源
          persist: () => store.upsertAct(act)
        });
        persistAgentProfile(r, req.userId);
        consumeAgentMeta(r);
        if (r.planCard) r.planCard = withAuthoritativePreview(act, r.planCard); // S2 预览卡升级为权威形状（无码）
        persistPreviewCard(act, r);   // A2：S2 预览卡落库，刷新后可召回确认卡
        if (r.guardrailHits && r.guardrailHits.length) {
          r.guardrailHits.forEach(h => metricsInc('guardrail_' + h));
          logEvent('guardrail', { hits: r.guardrailHits });
        }
        return sendJson(res, 200, r);
      } catch (e) {
        if (e && e.code === 'PERSIST_FAIL') return sendJson(res, 503, { error: e.message });
        throw e;
      }
    }

    // —— 对话消息（SSE 交付 · 真流式）：头先写，IGDE 处理过程中逐 token 推帧；
    //    B3 记账：token 帧在引擎内缓冲、upsertAct 成功后才冲刷（严格先落库后回复）——
    //    落库失败 → error 帧「刚才那句我没存上，再说一次」（无任何 token/done 帧先行）；
    //    未流出 token（桩模式 / 边界拒绝 / 护栏重生成）时保留 3 字打字机兜底；
    //    护栏替换了乐观流出的预览时发 replace 校正帧。
    //    done 帧契约（PRD v2）：保留 result，新增 ok/stage/act/engine/chips 四字段，
    //    act = 落库后的完整 act 序列化（含三态 needs / memory.extras / filled_count / code_status）。
    const sm2 = pathname.match(/^\/api\/act\/([\w-]+)\/message\/stream$/);
    if (sm2 && method === 'POST') {
      const act = store.getAct(sm2[1]);
      if (!canSeeRow(act, req)) return sendJson(res, 404, { error: 'act not found' });
      // 安全整改：普通用户每日 AI 额度（同非流式口径；SSE 头在门禁之后才写，错误仍走 JSON 429）
      if (!isAdminReq(req) && !llmQuotaTry(req.userId, 1)) {
        return sendJson(res, 429, { error: '今日 AI 使用额度已用完（每用户每日 ' + (config.userLlmDailyLimit || 0) + ' 轮），请明天再试或联系管理员。' });
      }
      const body = await readBody(req);
      igde.aiEnabled = !!config.aiKey;
      syncAgentConfig();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'   // 告知反向代理（Next/nginx）不要缓冲 SSE
      });
      res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`); // 立即冲一个字节，防代理攒包
      let closed = false;
      res.on('close', () => { closed = true; });                    // 客户端断连后停止写帧
      const send = (frame) => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(frame)}\n\n`); };
      let streamed = '';      // 已乐观流出的 reply 增量累计（落库成功后才开始积累）
      const onReplyToken = (piece) => { streamed += piece; send({ type: 'token', value: piece }); };
      let result;
      try {
        result = await igde.handle(act, (body.message || '').toString().slice(0, 2000), {
          locale: config.shopDefaultLocale || 'en',
          agentProfile: store.getAgentProfile(req.userId),
          executors: makeCampaignExecutor(req.userId, scopeOpts(req)),   // Wave 3：批次/运维执行器（按请求注入，带 userId 作用域）
          reusePrefs: latestPrefsFor(req.userId, act.id, scopeOpts(req)),   // Wave 4 A3②：复用意图的 prefs 数据源
          onReplyToken,
          persist: () => store.upsertAct(act)
        });
      } catch (e) {
        // B3：落库失败（或引擎异常）→ 不发回复，error 帧人话提示（前端可安全重发）
        const msg = (e && e.code === 'PERSIST_FAIL') ? e.message : String(e && e.message || e);
        send({ type: 'error', error: msg });
        res.end();
        return;
      }
      persistAgentProfile(result, req.userId);
      consumeAgentMeta(result);
      if (result.planCard) result.planCard = withAuthoritativePreview(act, result.planCard); // S2 预览卡升级为权威形状（无码）
      persistPreviewCard(act, result);   // A2：S2 预览卡落库，刷新后可召回确认卡
      if (result.guardrailHits && result.guardrailHits.length) {
        result.guardrailHits.forEach(h => metricsInc('guardrail_' + h));
        logEvent('guardrail', { hits: result.guardrailHits });
      }
      const finalReply = result.reply || '';
      if (!streamed) {
        // 未流出任何 token（桩 / 边界 / 护栏重生成 / 模型没按 JSON 输出）→ 3 字打字机兜底
        // 注：3 字分块在中文语境下可能切断词语（如"挽回"→"挽"+"回"），但在打字机效果场景下
        // 可接受——优先保证逐字上屏的即时感，而非词边界完整性。西文 3 字符通常仍在词边界内。
        for (let i = 0; i < finalReply.length; i += 3) {
          send({ type: 'token', value: finalReply.slice(i, i + 3) });
        }
      } else if (finalReply !== streamed) {
        // 流出过预览但与权威 reply 不一致：前缀关系 → 补齐尾部；否则护栏替换 → 整段校正
        if (finalReply.startsWith(streamed)) {
          const rest = finalReply.slice(streamed.length);
          for (let i = 0; i < rest.length; i += 3) send({ type: 'token', value: rest.slice(i, i + 3) });
        } else {
          send({ type: 'replace', value: finalReply });
        }
      }
      // PRD v2 done 帧：保留现有 result 字段不变，新增 ok/stage/act/engine/chips
      const persistedAct = store.getAct(act.id) || act;
      send({
        type: 'done',
        result,
        ok: true,
        stage: persistedAct.stage,
        act: persistedAct,
        engine: result.engine || (engineOnline() ? 'online' : 'degraded'),
        chips: result.chips || [],
        // Wave 3 I1：batch_plan 待确认时下发待确认批次卡（前端据 result.batches 渲染）
        ...(result.batches ? { batches: result.batches } : {})
      });
      res.end();
      return;
    }

    // —— 生成草稿（Wave 2 D3：服务端同源为唯一权威）——
    //   actId 路径（权威）：从 act 冻结快照/needs 服务端序列化 planCard → 草稿，不信任前端回传；
    //     已 confirm（有 execution_snapshot）→ 权威卡（含真实码）；未 confirm → 无码预览卡（E2 红线）。
    //   planCard 直传路径（兼容）：仅保留给 mailgen 冒烟/旧前端 —— 此路径出的草稿没有执行快照，闸门⑤必拦，发不出去。
    if (pathname === '/api/draft' && method === 'POST') {
      const body = await readBody(req);
      let card = null;
      let actId = body.actId || null;
      let authoritative = false;
      if (actId) {
        const act = store.getAct(actId);
        if (!canSeeRow(act, req)) return sendJson(res, 404, { error: 'act not found' });
        if (act.execution_snapshot && act.plan_card) {
          card = act.plan_card;             // confirm 产出的权威卡（同源 JSON，含真实码）
          authoritative = true;
        } else {
          // 未 confirm：服务端按冻结 needs 出无码预览卡（不含折扣码 —— E2 红线）
          const base = igde.producePlanCard(act, { locale: config.shopDefaultLocale || 'en' });
          card = execution.buildPlanCard({
            base, code: null, codeStatus: 'pending',
            reachCount: audienceNetList(base.audience, ownerScope(act.user_id)).length,
            extras: (act.memory && Array.isArray(act.memory.extras)) ? act.memory.extras : [],
            brand: resolveMerchantBrand(act),
            unsubscribeOk: Boolean(config.publicBaseUrl)
          });
          if (!config.visionKey) card.skip_image = true;
          card.brand = resolveMerchantBrand(act);
        }
      } else if (body.planCard) {
        card = body.planCard;
      } else {
        return sendJson(res, 400, { error: 'missing planCard or actId' });
      }
      const r = await createDraftFromCard(card, { actId, userId: req.userId, authoritative, draftId: authoritative ? (card.draft_id || null) : null });

      return sendJson(res, 200, {
        draft: r.draft, estGmv: r.estGmv, matchedCount: r.matchedCount,
        audience_conditions: r.conditions,
        tag_distribution: r.tagDist,
        references: {
          strategy_cards: r.refCards.map(c => ({ id: c.id, competitor_name: c.competitor_name, theme_formula: c.theme_formula, angle: c.angle })),
          strategy_cards_count: r.refCards.length,
          benchmark: r.benchHits
        },
        variants_provider: r.variants_provider
      });
    }

    // —— Wave 2 E2/D3：S2 确认动作（无请求体；可选 {reuse_code} / {nohook:true}）——
    // 成功：200 {ok,act,planCard,checklist,holdout,draft_id,draft}（act.stage→S3，draft 服务端同源落库）；
    // 建码失败：409 {ok:false,code_status:'failed',reason,options:['重试建码','改用店内现成码','改发无钩子提醒信'],act}；
    const cm = pathname.match(/^\/api\/act\/([\w-]+)\/confirm$/);
    if (cm && method === 'POST') {
      const act = store.getAct(cm[1]);
      if (!canSeeRow(act, req)) return sendJson(res, 404, { error: 'act not found' });
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const r = await confirmActToStage3(act, body, req.userId);
      if (!r.ok) {
        const payload = { ok: false };
        for (const k of ['error', 'code_status', 'reason', 'options', 'act']) if (r[k] !== undefined) payload[k] = r[k];
        return sendJson(res, r.status || 409, payload);
      }
      logEvent('act_confirmed', { act_id: act.id, code_status: act.code_status, draft_id: r.draft_id, all_pass: r.checklist.all_pass });
      metricsInc('act_confirm_' + (act.code_status || 'none'));
      return sendJson(res, 200, r);
    }

    if (pathname === '/api/drafts' && method === 'GET') {
      // UI v4 整改 1：汇总 stats + 每封生命周期进度段（草稿→发送→触达→回流）
      const drafts = store.getDraftsByUser(req.userId);
      const segMap = { draft: [1,0,0], sending: [1,0,0], sent: [1,1,0], recovering: [1,1,1], timeout: [1,1,0], failed: [1,0,0] };
      const stats = {
        count: drafts.length,
        reached: drafts.reduce((s, d) => s + (d.matchedCount || 0), 0),      // 累计触达（仿真=匹配数）
        gmv: +drafts.reduce((s, d) => s + (+d.estGmv || 0), 0).toFixed(2),   // 已捞回·预估
        cost: +drafts.reduce((s, d) => s + (+d.cost || 0), 0).toFixed(2)
      };
      const items = drafts.map(d => ({ ...d, html: applyFooterLinks(d.html, d.id), progressSeg: segMap[d.status] || [1,0,0], locale: d.locale || config.shopDefaultLocale || 'en' }));
      return sendJson(res, 200, { drafts: items, stats });
    }

    // —— 删除草稿（邮件卡片操作行「删除」，Figma 406:2955）——
    const dm = pathname.match(/^\/api\/draft\/([\w-]+)$/);
    if (dm && method === 'DELETE') {
      const draft = store.getDraft(dm[1]);
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      if (!canSeeRow(draft, req)) return sendJson(res, 404, { error: 'draft not found' });
      if (['sending', 'queued'].includes(draft.status)) {
        return sendJson(res, 409, { error: '该邮件正在发送，不能删除' });
      }
      store.deleteDraft(draft.id);
      logEvent('draft_deleted', { draft_id: draft.id, status: draft.status });
      return sendJson(res, 200, { deleted: true });
    }

    // —— 编辑态「生成图片」（Figma 446:6142）：按（可编辑）提示词重跑图片，文案/主题不动 ——
    // 批次 1「最后一米」：接受 product_image_id（商品库选用）→ 解析为本地路径 → 走 generateMailHtml
    // 既有 product_image_path 管道（本地图直接用/万相图生图/叠字），只补上游赋值。
    const im = pathname.match(/^\/api\/draft\/([\w-]+)\/image$/);
    if (im && method === 'POST') {
      const draft = store.getDraft(im[1]);
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      if (!canSeeRow(draft, req)) return sendJson(res, 404, { error: 'draft not found' });
      if (['sent', 'sending', 'queued'].includes(draft.status)) {
        return sendJson(res, 409, { error: '该邮件已发送或正在发送，不能再修改' });
      }
      let prompt = draft.image_prompt || '';
      let productImageId = '';
      try {
        const body = await readBody(req);
        if (typeof body.prompt === 'string' && body.prompt.trim()) prompt = body.prompt.trim();
        else if (typeof body.prompt === 'string' && !body.product_image_id) return sendJson(res, 400, { error: '提示词不能为空' });
        if (typeof body.product_image_id === 'string' && body.product_image_id.trim()) productImageId = body.product_image_id.trim();
      } catch (e) { /* 无 body：沿用 draft.image_prompt */ }
      try {
        // 伪 card：复用 generateMailHtml 管线（透传现有 subject/body，仅重跑图片）；brand/product 走草稿固化快照
        const pseudoCard = {
          subject: draft.subject, body: draft.body, discountNum: draft.discount,
          coupon: draft.coupon, audience: draft.audience, locale: draft.locale,
          brand: draft.brand, product: draft.product,
        };
        if (productImageId) {
          const prod = store.getProduct(productImageId);
          if (!prod || (prod.user_id && prod.user_id !== req.userId)) {
            return sendJson(res, 404, { error: '商品不存在或不可见' });
          }
          const prodPath = productsMod.resolveProductImagePath(store, req.userId, productImageId);
          if (!prodPath) return sendJson(res, 404, { error: '商品图文件已丢失，请重新上传' });
          pseudoCard.product_image_path = prodPath;
          if (prod.category) pseudoCard.category = prod.category;   // 批次 2：品类随商品记录带入（构图按品类）
        }
        await generateMailHtml(draft, pseudoCard, { imagePromptOverride: prompt, copyPassthrough: true });
        logEvent('draft_image_regen', { draft_id: draft.id, prompt_len: prompt.length, product_image_id: productImageId || null, image_method: (draft.mailgen_meta || {}).image_method });
        return sendJson(res, 200, {
          image_path: draft.image_path, image_prompt: draft.image_prompt || prompt, html: draft.html,
        });
      } catch (e) {
        logEvent('draft_image_regen_fail', { draft_id: draft.id, error: String(e && e.message || e) });
        return sendJson(res, 500, { error: '生成图片失败：' + (e && e.message || e) });
      }
    }

    // —— 商品库（批次 1）：设置页上传/列表/删除；user_id 隔离，多账号互不可见 ——
    if (pathname === '/api/products' && method === 'GET') {
      const items = store.getProductsByUser(req.userId).map(p => ({
        id: p.id, name: p.name, category: p.category || '',
        content_type: p.content_type, bytes: p.bytes, created_at: p.created_at,
        image_url: '/api/image/' + encodeURIComponent(p.file_path),
      }));
      return sendJson(res, 200, { products: items });
    }
    if (pathname === '/api/products' && method === 'POST') {
      // 图片走 JSON/base64 通道（无 multipart 依赖）：前端压图 ≤2MB → base64 ≈ 2.7MB 字符，放宽读限到 6MB
      let body;
      try {
        body = await readBody(req, 6e6);
      } catch (e) {
        return sendJson(res, e && e.message === 'body too large' ? 413 : 400, { error: e && e.message === 'body too large' ? '图片超过 2MB，请压缩后重试' : '请求体不是合法 JSON' });
      }
      const decoded = productsMod.decodeImageDataUrl(body);
      if (!decoded) return sendJson(res, 400, { error: '缺少图片数据（image_data 需为 base64 或 data URL）' });
      if (decoded.length > productsMod.MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: '图片超过 2MB，请压缩后重试' });
      // 品类：商家点选为主；未选 → 对话 LLM 读图推断兜底（qwen3.7-plus 等多模态，已配置才可用）；仍空 = 通用模板
      let category = productsMod.CATEGORIES.includes(body.category) ? body.category : '';
      if (!category) {
        try {
          const raw = String(body.image_data || body.data_url || body.image_base64 || '').trim();
          const declared = String(body.content_type || decoded.declaredMime || 'image/jpeg').toLowerCase() || 'image/jpeg';
          const dataUrl = raw.startsWith('data:') ? raw : `data:${declared};base64,${raw}`;
          category = await productsMod.inferCategory(dataUrl, config);
          if (category) logEvent('product_category_inferred', { userId: req.userId, category });
        } catch (e) { /* 推断失败非致命：落通用模板 */ }
      }
      const r = productsMod.saveUploadedProduct(store, req.userId, { ...body, category });
      if (r.error) return sendJson(res, r.error[0], { error: r.error[1] });
      logEvent('product_uploaded', { userId: req.userId, product_id: r.product.id, category: r.product.category, bytes: r.product.bytes });
      metricsInc('product_uploaded');
      return sendJson(res, 200, {
        product: {
          id: r.product.id, name: r.product.name, category: r.product.category,
          content_type: r.product.content_type, bytes: r.product.bytes, created_at: r.product.created_at,
          image_url: '/api/image/' + encodeURIComponent(r.product.file_path),
        },
      });
    }
    const pdm = pathname.match(/^\/api\/products\/([\w-]+)$/);
    if (pdm && method === 'DELETE') {
      const ok = productsMod.deleteProductFile(store, req.userId, pdm[1]);
      if (!ok) return sendJson(res, 404, { error: '商品不存在或不可见' });
      logEvent('product_deleted', { userId: req.userId, product_id: pdm[1] });
      return sendJson(res, 200, { deleted: true });
    }

    // —— 发送（PRD §0.6：改 202 入队；预检 + D4 五道闸门 + holdout 冻结 + 幂等键 send:{userId}:{draftId}）——
    const sm = pathname.match(/^\/api\/draft\/([\w-]+)\/send$/);
    if (sm && method === 'POST') {
      const draft = store.getDraft(sm[1]);
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      if (!canSeeRow(draft, req)) return sendJson(res, 404, { error: 'draft not found' });
      // 状态检查前置：已发送/发送中的草稿不接受编辑落库（避免 409 前把编辑内容写进已发出的邮件）
      if (['sent', 'sending', 'queued'].includes(draft.status)) {
        return sendJson(res, 409, { error: '该邮件已发送或正在发送，请勿重复操作' });
      }
      // —— Wave 3 I2：发送入口统一停发检查（高于一切单批操作）——
      //   日历命中 → 顺延重排（202，复用 run_after；不删除不丢弃）；紧急全停 → 409（无已知恢复时刻，
      //   绝不自动恢复，商家明说「恢复吧」解除全停后重新发送）。
      const blocker0 = campaignsMod.sendBlocker(store);
      if (blocker0) {
        if (blocker0.kind === 'calendar') {
          const retryAt = blocker0.retryAt || (Date.now() + 3600 * 1000);
          const { job } = queue.enqueue({
            type: 'send_draft', payload: { draftId: draft.id },
            dedupeKey: 'send:sched:' + draft.id + ':' + retryAt, runAfter: retryAt
          });
          draft.status = 'queued';
          draft.scheduled_at = retryAt;
          store.upsertDraft(draft);
          logEvent('send_deferred_blackout', { draft_id: draft.id, retry_at: retryAt, reason: blocker0.reason });
          return sendJson(res, 202, { job_id: job.id, queued: true, scheduled_at: retryAt, deferred: 'blackout', reason: blocker0.reason, draft });
        }
        return sendJson(res, 409, { ok: false, error: blocker0.reason + '。解除全停（明说「恢复吧」）后再发送' });
      }
      // 前端邮件页编辑：发送前把最新主题/正文落库（P0-1：避免「界面显示新内容、实际发出旧内容」）
      // 注：主题/正文不在 D3 四字段 diff 口径内（audience/discount/count/estGmv），不破坏快照同源
      try {
        const body = await readBody(req);
        if (body && typeof body.subject === 'string' && body.subject.trim()) draft.subject = applySubjectTone(body.subject.trim(), draft.audience);
        if (body && typeof body.body === 'string' && body.body.trim()) draft.body = body.body.trim();
        store.upsertDraft(draft);
      } catch (e) { /* 无 body 或非 JSON：维持存储原稿 */ }
      // M3：发送前刷新固化页脚链接（存量草稿生成时是 cart_url 兜底；publicBaseUrl 未配则原样）
      const refreshedHtml = applyFooterLinks(draft.html, draft.id);
      if (refreshedHtml !== draft.html) { draft.html = refreshedHtml; store.upsertDraft(draft); }
      // ③ 发送前预检：ESP 配置 / 发件域名 / 收件人有效性，失败分类人话提示（频控已移入 D4 闸门②）
      const check = precheckSend(draft);
      if (!check.ok) {
        const first = check.problems.find(p => !['quota_warning', 'domain_mismatch'].includes(p.type));
        logEvent('send_precheck_fail', { draft_id: draft.id, problems: check.problems });
        return sendJson(res, 400, { error: first ? first.human : '发送预检未通过', problems: check.problems });
      }
      // —— D4 五道闸门（服务端重跑；前端按钮本就该被禁用，这里是兜底）——
      //    仅时段闸不过 → 缓发（重新入队带 scheduled_at，202）；其余任一不过 → 409 {ok:false, checklist}
      const act = draft.act_id ? store.getAct(draft.act_id) : null;
      const recipients = audienceNetList(draft.audience, ownerScope(draft.user_id));
      const gateCheck = await execution.evaluateChecklist({ act, draft, store, config, connector: connectors, recipients });
      const failing = gateCheck.items.filter(i => !i.pass);
      if (failing.length) {
        if (failing.length === 1 && failing[0].gate === 'window') {
          const retryAt = gateCheck.windowRetryAt || (Date.now() + 3600 * 1000);
          const { job } = queue.enqueue({
            type: 'send_draft', payload: { draftId: draft.id },
            dedupeKey: 'send:sched:' + draft.id + ':' + retryAt, runAfter: retryAt
          });
          draft.status = 'queued';
          draft.scheduled_at = retryAt;
          store.upsertDraft(draft);
          logEvent('send_deferred_window', { draft_id: draft.id, retry_at: retryAt, job_id: job.id, timezone: gateCheck.timezone });
          return sendJson(res, 202, {
            job_id: job.id, queued: true, scheduled_at: retryAt, deferred: 'window',
            checklist: checklistContract(gateCheck, { frozen: false, note: '时段闸缓发，将在下一合理时段自动发送' }),
            draft
          });
        }
        logEvent('send_gate_fail', { draft_id: draft.id, gates: failing.map(f => f.gate) });
        return sendJson(res, 409, { ok: false, checklist: checklistContract(gateCheck) });
      }
      // —— 全过 → 先冻结 holdout 对照组（幂等；对照成员绝不写入 sends）→ 再入队发送 ——
      const holdoutPlan = execution.selectHoldout(gateCheck.net);
      if (holdoutPlan.frozen) {
        store.freezeHoldouts({ act_id: draft.act_id, campaign_id: draft.id, recipients: holdoutPlan.members, ratio: holdoutPlan.ratio, source: 'single_plan' });
      }
      const holdoutContract = {
        frozen: holdoutPlan.frozen,
        count: store.getHoldouts({ campaign_id: draft.id }).length,
        ratio: holdoutPlan.ratio,
        ...(holdoutPlan.note ? { note: holdoutPlan.note } : {})
      };
      if (!rateLimitOk()) {
        return sendJson(res, 429, { error: '发送频率超限（每分钟上限 ' + (config.sendRateLimitPerMin || 20) + '），请稍后再试' });
      }
      // 202 入队（幂等键防重复点击）；实际发送由队列异步执行，前端经 GET /api/jobs/:id 轮询
      const { job, deduped } = queue.enqueue({
        type: 'send_draft',
        payload: { draftId: draft.id },
        dedupeKey: 'send:' + (req.userId || 'anon') + ':' + draft.id
      });
      if (!deduped) {
        draft.status = 'queued';
        store.upsertDraft(draft);
      }
      logEvent('send_queued', { draft_id: draft.id, job_id: job.id, deduped, sendable: gateCheck.net.length - holdoutContract.count, skipped_by_frequency: gateCheck.skippedByFrequency, holdout: holdoutContract.count });
      return sendJson(res, 202, {
        job_id: job.id, queued: true, deduped,
        check: { recipients: check.recipients, skippedByFrequency: gateCheck.skippedByFrequency, sendable: gateCheck.net.length - holdoutContract.count, warnings: check.problems.filter(p => ['quota_warning', 'domain_mismatch'].includes(p.type)) },
        checklist: checklistContract(gateCheck, { frozen: holdoutContract.frozen, note: holdoutContract.note }),
        holdout: holdoutContract,
        draft
      });
    }

    /* ================= Wave 3 批次域端点（I1/I2/I3/I4；前端并行开发契约②） ================= */

    // —— 建批（I1）：逐批建（逐批独立 E2 建码；某批失败该批 draft+code_status=failed，其余照建）
    //    人群重叠自动 I4 排除（重叠者归先发批）；建批 ≠ 发送（无 scheduled_at → draft）。
    //    body: {batches:[{name?, audience_desc, offer_text, percent_off?, scheduled_at?}], exclusion_override?:bool}
    if (pathname === '/api/campaigns' && method === 'POST') {
      const body = await readBody(req);
      const batches = Array.isArray(body.batches) ? body.batches : [];
      if (!batches.length || !batches.every(b => b && String(b.audience_desc || b.audience || '').trim())) {
        return sendJson(res, 400, { error: 'batches 不能为空，每批要带 audience_desc（针对谁）' });
      }
      const r = await campaignsMod.createCampaigns(store, {
        batches: batches.map(b => ({
          name: b.name, audience_desc: String(b.audience_desc || b.audience || '').slice(0, 60),
          offer_text: String(b.offer_text || b.offer || '').slice(0, 120),
          percent_off: Number(b.percent_off) || undefined,
          scheduled_at: Number(b.scheduled_at) || 0
        })),
        userId: req.userId, matcher: buildCampaignMatcher(scopeOpts(req)), connector: connectors,
        brand: (config.shopBrand && config.shopBrand !== 'CartBack') ? config.shopBrand : 'CartBack',
        exclusionOverride: Boolean(body.exclusion_override)
      });
      logEvent('campaigns_created', { count: r.campaigns.length, failures: r.failures.length, override: Boolean(body.exclusion_override) });
      return sendJson(res, 200, {
        ok: true,
        campaigns: r.campaigns.map(c => campaignsMod.publicCampaign(store, c)),
        failures: r.failures,
        ...(r.advice ? { advice: r.advice } : {})
      });
    }

    // —— 批次列表（含派生计数：sent/pending 一律从 sends/holdouts 派生）
    if (pathname === '/api/campaigns' && method === 'GET') {
      campaignsMod.reconcileBlackout(store);
      return sendJson(res, 200, {
        ok: true,
        campaigns: store.getCampaignsByUser(req.userId).map(c => campaignsMod.publicCampaign(store, c)),
        blackout: blackoutContract(),
        global_paused: campaignsMod.getGlobalPaused(store)
      });
    }

    // 批次归属校验 + 加载（404 语义与 drafts 一致；安全整改：空归属历史批次仅管理员可见）
    function loadCampaignForRequest(id) {
      const camp = store.getCampaign(id);
      if (!canSeeRow(camp, req)) return { error: [404, 'campaign not found'] };
      return { camp };
    }

    // —— 批次发送（建批 ≠ 发送；可指定 scheduled_at 错时发；复用 queue run_after）——
    //    停发命中 → 该批 frozen（不删不发送）；时段闸不过 → 202 缓发；其余闸门不过 → 409 checklist。
    const csid = pathname.match(/^\/api\/campaigns\/([\w-]+)\/send$/);
    if (csid && method === 'POST') {
      const { camp, error } = loadCampaignForRequest(csid[1]);
      if (error) return sendJson(res, error[0], { error: error[1] });
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      // I2：发送入口统一停发检查（高于一切单批操作）
      const blocker = campaignsMod.sendBlocker(store);
      if (blocker) {
        if (camp.status !== 'frozen') camp.prev_status = camp.status;
        camp.status = 'frozen';
        camp.freeze_scope = blocker.kind === 'global' ? 'global' : 'calendar';
        camp.frozen_reason = blocker.reason;
        camp.updated_at = Date.now();
        store.upsertCampaign(camp);
        logEvent('campaign_frozen', { campaign_id: camp.id, kind: blocker.kind });
        return sendJson(res, 202, {
          ok: true, frozen: true, kind: blocker.kind, reason: blocker.reason,
          campaign: campaignsMod.publicCampaign(store, camp)
        });
      }
      const scheduledAt = Number(body.scheduled_at) || 0;
      if (scheduledAt > Date.now()) {
        camp.status = 'scheduled';
        camp.scheduled_at = scheduledAt;
        store.upsertCampaign(camp);
        const { job } = queue.enqueue({
          type: 'send_campaign', payload: { campaignId: camp.id },
          dedupeKey: 'send_campaign:' + camp.id + ':' + scheduledAt, runAfter: scheduledAt
        });
        logEvent('campaign_scheduled', { campaign_id: camp.id, scheduled_at: scheduledAt, job_id: job.id });
        return sendJson(res, 202, { ok: true, job_id: job.id, queued: true, campaign: campaignsMod.publicCampaign(store, camp) });
      }
      const gates = await campaignsMod.evaluateCampaignGates(store, camp, { connector: connectors, publicBaseUrl: config.publicBaseUrl });
      const failing = gates.items.filter(i => !i.pass);
      if (failing.length === 1 && failing[0].gate === 'window') {
        const retryAt = gates.windowRetryAt || (Date.now() + 3600 * 1000);
        camp.status = 'scheduled';
        camp.scheduled_at = retryAt;
        store.upsertCampaign(camp);
        const { job } = queue.enqueue({
          type: 'send_campaign', payload: { campaignId: camp.id },
          dedupeKey: 'send_campaign:' + camp.id + ':' + retryAt, runAfter: retryAt
        });
        return sendJson(res, 202, {
          ok: true, job_id: job.id, queued: true, deferred: 'window', scheduled_at: retryAt,
          checklist: { items: gates.items, all_pass: false },
          campaign: campaignsMod.publicCampaign(store, camp)
        });
      }
      if (failing.length) {
        logEvent('campaign_gate_fail', { campaign_id: camp.id, gates: failing.map(f => f.gate) });
        return sendJson(res, 409, { ok: false, checklist: { items: gates.items, all_pass: false } });
      }
      if (!rateLimitOk()) {
        return sendJson(res, 429, { error: '发送频率超限（每分钟上限 ' + (config.sendRateLimitPerMin || 20) + '），请稍后再试' });
      }
      const { job } = queue.enqueue({ type: 'send_campaign', payload: { campaignId: camp.id }, dedupeKey: 'send_campaign:' + (req.userId || 'anon') + ':' + camp.id });
      logEvent('campaign_send_queued', { campaign_id: camp.id, job_id: job.id, sendable: gates.allow.length, skipped_by_frequency: gates.skippedByFrequency });
      return sendJson(res, 202, { ok: true, job_id: job.id, queued: true, campaign: campaignsMod.publicCampaign(store, camp) });
    }

    // —— I3 暂停（恢复必须用户明说；空批边界照给）
    const cpm = pathname.match(/^\/api\/campaigns\/([\w-]+)\/pause$/);
    if (cpm && method === 'POST') {
      const { camp, error } = loadCampaignForRequest(cpm[1]);
      if (error) return sendJson(res, error[0], { error: error[1] });
      const r = campaignsMod.pauseCampaign(store, camp, { scope: 'user' });
      if (!r.ok) return sendJson(res, 409, { ok: false, error: r.reason });
      return sendJson(res, 200, { ok: true, campaign: campaignsMod.publicCampaign(store, camp), boundary: campaignsMod.boundaryOf(camp, store) });
    }

    // —— I3 恢复（global_paused 期间拒绝；恢复须用户明说 —— 本端点即用户显式动作）
    const crm = pathname.match(/^\/api\/campaigns\/([\w-]+)\/resume$/);
    if (crm && method === 'POST') {
      const { camp, error } = loadCampaignForRequest(crm[1]);
      if (error) return sendJson(res, error[0], { error: error[1] });
      const r = campaignsMod.resumeCampaign(store, camp);
      if (!r.ok) return sendJson(res, 409, { ok: false, error: r.reason });
      return sendJson(res, 200, { ok: true, campaign: campaignsMod.publicCampaign(store, camp), boundary: campaignsMod.boundaryOf(camp, store) });
    }

    // —— I3 改折扣：只改未发部分；力度变化 → 建新码（E2），旧码仅对已发邮件继续有效
    const cdm2 = pathname.match(/^\/api\/campaigns\/([\w-]+)\/discount$/);
    if (cdm2 && method === 'POST') {
      const { camp, error } = loadCampaignForRequest(cdm2[1]);
      if (error) return sendJson(res, error[0], { error: error[1] });
      const body = await readBody(req);
      const r = await campaignsMod.changeDiscount(store, camp, { percentOff: body.percent_off, connector: connectors });
      if (!r.ok) return sendJson(res, 409, { ok: false, error: r.reason });
      logEvent('campaign_discount_changed', { campaign_id: camp.id, code: r.code, old_code: r.oldCode });
      return sendJson(res, 200, {
        ok: true, campaign: campaignsMod.publicCampaign(store, camp),
        boundary: campaignsMod.boundaryOf(camp, store), changed: r.changed
      });
    }

    // —— I3 排除：从未发名单即时移除、逐条留痕；操作对象是已发部分 → 拒绝并解释
    const cem = pathname.match(/^\/api\/campaigns\/([\w-]+)\/exclude$/);
    if (cem && method === 'POST') {
      const { camp, error } = loadCampaignForRequest(cem[1]);
      if (error) return sendJson(res, error[0], { error: error[1] });
      const body = await readBody(req);
      const r = campaignsMod.excludeFromCampaign(store, camp, { emails: body.emails, allOpened: Boolean(body.all_opened) });
      if (!r.ok) return sendJson(res, 409, { ok: false, error: r.reason, rejected: r.rejected || [] });
      return sendJson(res, 200, {
        ok: true, campaign: campaignsMod.publicCampaign(store, camp),
        boundary: campaignsMod.boundaryOf(camp, store), excluded_count: r.excluded_count,
        rejected: r.rejected || []
      });
    }

    // —— I3 重发：生成新批次（新码、可换主题行）；频次护栏未确认 → 409 needs_confirm + 风险数字
    const crm2 = pathname.match(/^\/api\/campaigns\/([\w-]+)\/resend$/);
    if (crm2 && method === 'POST') {
      const { camp, error } = loadCampaignForRequest(crm2[1]);
      if (error) return sendJson(res, error[0], { error: error[1] });
      const body = await readBody(req);
      const r = await campaignsMod.resendCampaign(store, camp, {
        subject: String(body.subject || '').slice(0, 120),
        confirmFrequency: Boolean(body.confirm_frequency),
        connector: connectors, userId: req.userId,
        brand: (config.shopBrand && config.shopBrand !== 'CartBack') ? config.shopBrand : 'CartBack'
      });
      if (!r.ok && r.needs_confirm) {
        return sendJson(res, 409, { ok: false, needs_confirm: true, risk: r.risk, hint: r.hint });
      }
      if (!r.ok) return sendJson(res, 409, { ok: false, error: r.reason });
      logEvent('campaign_resend', { source_id: camp.id, new_id: r.camp.id });
      return sendJson(res, 200, {
        ok: true, campaign: campaignsMod.publicCampaign(store, r.camp),
        boundary: campaignsMod.boundaryOf(camp, store)
      });
    }

    // —— I2 停发日历：挂 / 撤 / 查（日期区间如黑五；可提前挂）
    if (pathname === '/api/blackout' && method === 'POST') {
      const body = await readBody(req);
      const parsed = campaignsMod.parseBlackoutRange({ from: body.from, to: body.to, label: body.label });
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });
      const row = store.addBlackout({ user_id: req.userId || null, from: parsed.range.from, to: parsed.range.to, label: parsed.range.label });
      logEvent('blackout_added', { blackout_id: row.id, label: row.label, from: row.from, to: row.to });
      return sendJson(res, 200, { ok: true, blackout: { id: row.id, from: campaignsMod.isoDay(row.from), to: campaignsMod.isoDay(row.to - 1), label: row.label }, active: campaignsMod.activeBlackoutRange(store) != null });
    }
    if (pathname === '/api/blackout' && method === 'GET') {
      return sendJson(res, 200, blackoutContract());
    }
    const bdm = pathname.match(/^\/api\/blackout\/([\w-]+)$/);
    if (bdm && method === 'DELETE') {
      const removed = store.deleteBlackout(bdm[1]);
      if (!removed) return sendJson(res, 404, { error: 'blackout not found' });
      // 撤日历 → 已结束的窗口立刻对账（日历冻结批次顺延恢复 + 重排 job）
      const restored = campaignsMod.reconcileBlackout(store);
      for (const camp of restored) {
        if (camp.scheduled_at) {
          queue.enqueue({
            type: 'send_campaign', payload: { campaignId: camp.id },
            dedupeKey: 'send_campaign:' + camp.id + ':' + camp.scheduled_at, runAfter: camp.scheduled_at
          });
        }
      }
      logEvent('blackout_removed', { blackout_id: bdm[1], restored: restored.length });
      return sendJson(res, 200, { ok: true, restored: restored.map(c => campaignsMod.publicCampaign(store, c)) });
    }

    // —— I2 紧急全停 / 解除（解除必须用户明说「恢复吧」触发本端点，绝无自动路径）
    if (pathname === '/api/pause-all' && method === 'POST') {
      const r = campaignsMod.pauseAll(store);
      logEvent('pause_all', { paused: r.paused, frozen: r.frozen });
      return sendJson(res, 200, { ok: true, global_paused: true, paused: r.paused, frozen: r.frozen });
    }
    if (pathname === '/api/resume-all' && method === 'POST') {
      const r = campaignsMod.resumeAll(store);
      // 解除后重排因全停冻结、有排程时刻的批次 job
      for (const camp of campaignsMod.allCampaigns(store)) {
        if (camp.status === 'scheduled' && camp.scheduled_at) {
          queue.enqueue({
            type: 'send_campaign', payload: { campaignId: camp.id },
            dedupeKey: 'send_campaign:' + camp.id + ':' + camp.scheduled_at, runAfter: camp.scheduled_at
          });
        }
      }
      logEvent('resume_all', { resumed: r.resumed_count });
      return sendJson(res, 200, { ok: true, global_paused: false, resumed: r.resumed, resumed_count: r.resumed_count });
    }

    // —— 受众（安全整改：含客户邮箱 PII，按账号隔离；空 user_id 历史数据仅管理员可见）——
    if (pathname === '/api/audience' && method === 'GET') {
      return sendJson(res, 200, { audience: store.getAudienceForUser(req.userId, scopeOpts(req)) });
    }
    if (pathname === '/api/audience/import' && method === 'POST') {
      const body = await readBody(req);
      const list = parseCsv(body.csv || '');
      if (!list.length) return sendJson(res, 400, { error: '未解析到有效邮箱' });
      store.addAudience(list, req.userId);   // 安全整改：导入名单归属当前用户
      tagsMod.scoreAudience(store, list);   // ① 同步时打分（source=scoring；manual 不被覆盖）
      return sendJson(res, 200, { imported: list.length, audience: store.getAudienceForUser(req.userId, scopeOpts(req)) });
    }

    // —— Store Connector：店铺事件 webhook 同步（架构 §2 B1：店铺 API / webhook / CSV 导入）——
    if (pathname === '/api/store/sync' && method === 'POST') {
      const body = await readBody(req);
      const events = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : []);
      if (!events.length) return sendJson(res, 400, { error: '缺少 events' });
      const list = events
        .map(e => ({
          name: e.name || (e.email || '').split('@')[0], email: e.email,
          intent: e.intent || '导入', risk: e.risk || '中', price: e.price || '中',
          abandoned_value: parseFloat(e.abandoned_value) || 0, source: 'store',
          at_risk_at: Number(e.at_risk_at) || Date.now(),   // 真实店铺事件自带流失时间（30 天窗口过滤依据）
          style: tagsMod.normalizeStyle(e.style) || null,            // 风格品类归一（tech/fashion/business/outdoor）
          gender: tagsMod.normalizeGender(e.gender) || null,        // 性别归一（female/male/other）
          age_range: e.age_range || null,                            // 年龄段原样
          device: e.device || null,                                  // 设备原样
          customer_segment: tagsMod.normalizeSegment(e.customer_segment) || null, // 客户分层
          locale: e.locale || null                                   // 语种（language 标签来源）
        }))
        .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email || ''));
      if (!list.length) return sendJson(res, 400, { error: '未解析到有效邮箱' });
      store.addAudience(list, req.userId);   // 安全整改：同步名单归属当前用户
      tagsMod.scoreAudience(store, list);   // ① 店铺事件同步打分
      logEvent('store_sync', { imported: list.length, userId: req.userId });
      return sendJson(res, 200, { imported: list.length, audience: store.getAudienceForUser(req.userId, scopeOpts(req)).length });
    }

    // —— 店后台连接器：把【收件人 + 行为】映射进现有受众 schema ——
    //   业务映射（工程师可据真实 CRM 字段细化）：行为决定受众分类与可挽回金额
    function recipientToAudience(r, events) {
      const carts = (events || []).filter(e => e.email === r.email && e.type === 'cart_abandoned');
      const bought = (events || []).filter(e => e.email === r.email && e.type === 'purchased');
      const intent = carts.length ? '加购未付' : (bought.length ? '老客' : '浏览未买');
      const abandonedValue = carts.reduce((s, e) => s + (e.value || 0), 0);
      const score = Math.min(0.99, 0.4 + (r.ordersCount || 0) * 0.05 + (carts.length ? 0.3 : 0) + ((r.totalSpent || 0) > 500 ? 0.15 : 0));
      const risk = score > 0.8 ? '高' : score > 0.6 ? '中' : '低';
      const price = (r.totalSpent || 0) > 1000 ? '高' : (r.totalSpent || 0) > 200 ? '中' : '低';
      return {
        id: 'aud_' + (r.id || r.email),
        name: r.name || (r.email || '').split('@')[0],
        email: r.email,
        intent, risk, price,
        score: +score.toFixed(2),
        abandoned_value: +abandonedValue.toFixed(2),
        source: 'store',
        locale: r.locale || null,   // 收件人语种（邮件本地化依据）
        country: r.country || null,
        created_at: Date.now(),
        at_risk_at: Date.now(),
        // 人口/画像维度：Shopify 标准客户数据无这些字段，留空；tagsForAudienceRow 防御跳过。
        // 连接器若返回（如 CRM metafield 透传），原样落入供打分。
        gender: tagsMod.normalizeGender(r.gender) || null,
        age_range: r.age_range || null,
        device: r.device || null,
        customer_segment: tagsMod.normalizeSegment(r.customer_segment) || null
      };
    }

    // —— 店后台连接器状态（绝不含密钥/域名）——
    if (pathname === '/api/store/connectors' && method === 'GET') {
      if (!connectors) return sendJson(res, 200, { configured: false, types: [] });
      const health = await connectors.health().catch(e => ({ ok: false, detail: e.message }));
      const meta = await connectors.getShopMeta().catch(() => null);
      return sendJson(res, 200, { configured: true, types: connectors.type === 'multi' ? connectors.connectors.map(c => c.type) : [connectors.type], health, shop: meta });
    }

    // —— 拉取：从已配置店后台读取【用户信息 + 行为】并写入受众（安全整改：连接器是服务端全局配置，
    //        任意注册用户拉取 = 把店主客户 PII 拖进自己租户再导出，故仅管理员可用；名单替换只清管理员域）——
    if (pathname === '/api/store/pull' && method === 'POST') {
      if (!isAdminReq(req)) return sendJson(res, 403, { error: '店后台拉取仅管理员可用（连接器为服务端全局配置）' });
      if (!connectors) return sendJson(res, 400, { configured: false, error: '未接入任何店后台；请在 config.json 配置 shopify 或 stores' });
      const recipients = await connectors.listCustomers({}).catch(e => { throw new Error('拉取用户失败: ' + e.message); });
      const events = await connectors.listBehaviorEvents({}).catch(() => []);
      const audience = recipients.map(r => recipientToAudience(r, events));
      store.replaceAudienceForUser(audience, req.userId, scopeOpts(req));
      tagsMod.scoreAudience(store, audience);   // ① 拉取同步时打分（PRD §0.3：同步时 scoring）
      // 行为事件落库（供后续归因/KPI；事件同样打归属）
      for (const e of events) store.addEvent({ type: e.type, audience_id: (audience.find(a => a.email === e.email) || {}).id || null, user_id: req.userId || null, value: e.value, ts: e.ts });
      logEvent('store_pull', { recipients: audience.length, events: events.length, userId: req.userId });
      return sendJson(res, 200, { pulled: audience.length, events: events.length, recipients: audience.slice(0, 20), configured: true });
    }

    // —— 配置（密钥只存服务端 .server，绝不回传） ——
    // 安全整改：全局服务端配置（密钥 / AI·ESP 端点 / 发信模式 / 引擎参数）仅管理员可写——
    // 此前任意注册用户可改全局 aiBaseUrl/espApiUrl 指向自己的服务器窃取真实 AI key / SMTP 授权码
    //（密钥外送），或把 mode 改成 real 用全局 ESP 群发。普通登录用户只能写自己的 user 级 prefs。
    function applyUserPrefs(body, req) {
      if (!(body.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs))) return false;
      const cur = store.getUserPrefs(req.userId);
      const merged = { ...cur };
      for (const [k, v] of Object.entries(body.prefs).slice(0, 16)) {
        const key = String(k || '').trim().slice(0, 40);
        if (!key) continue;
        const val = String(v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v))).trim().slice(0, 200);
        if (val === '') delete merged[key];
        else merged[key] = val;
      }
      store.setUserPrefs(req.userId, merged);
      return true;
    }
    if (pathname === '/api/config' && method === 'POST') {
      const body = await readBody(req);
      if (!isAdminReq(req)) {
        const saved = applyUserPrefs(body, req);
        if (saved) logEvent('user_prefs_saved', { userId: req.userId, scope: 'user' });
        return sendJson(res, 200, { status: cfg.status(config), scope: 'user' });
      }
      if (typeof body.mode === 'string') config.mode = body.mode === 'real' ? 'real' : 'demo';
      // 空串=不变更（掩码「未修改」约定）：AI/ESP 密钥已由环境变量接管，防止保存其他项时误清密钥
      if (typeof body.aiKey === 'string' && body.aiKey.trim()) config.aiKey = body.aiKey.trim();
      if (typeof body.espKey === 'string' && body.espKey.trim()) config.espKey = body.espKey.trim();
      if (typeof body.espFrom === 'string') config.espFrom = body.espFrom.trim();
      // ESP 供应商变量：resend（默认）| brevo（api-key 头 + /v3/smtp/email）| smtp（163/QQ 等，授权码作密码）
      if (typeof body.espProvider === 'string' && ['resend', 'brevo', 'smtp'].includes(body.espProvider.trim())) config.espProvider = body.espProvider.trim();
      if (typeof body.espApiUrl === 'string') config.espApiUrl = body.espApiUrl.trim();
      if (typeof body.espSenderName === 'string') config.espSenderName = body.espSenderName.trim().slice(0, 40);
      if (typeof body.smtpHost === 'string') config.smtpHost = body.smtpHost.trim();
      if (Number.isFinite(body.smtpPort)) config.smtpPort = Math.max(1, Math.min(65535, body.smtpPort | 0));
      if (typeof body.smtpUser === 'string') config.smtpUser = body.smtpUser.trim();
      if (typeof body.smtpPass === 'string') config.smtpPass = body.smtpPass.trim();
      if (typeof body.aiModel === 'string') config.aiModel = body.aiModel.trim();
      if (typeof body.aiProvider === 'string') config.aiProvider = body.aiProvider.trim();
      if (typeof body.aiBaseUrl === 'string') config.aiBaseUrl = body.aiBaseUrl.trim();
      // 邮件图像 AI（emailgen 复用）
      if (typeof body.visionKey === 'string') config.visionKey = body.visionKey.trim();
      if (typeof body.visionBaseUrl === 'string') config.visionBaseUrl = body.visionBaseUrl.trim();
      if (typeof body.visionModel === 'string') config.visionModel = body.visionModel.trim();
      // 兼容别名（wanx*）
      if (typeof body.wanxKey === 'string') config.wanxKey = body.wanxKey.trim();
      if (typeof body.wanxBaseUrl === 'string') config.wanxBaseUrl = body.wanxBaseUrl.trim();
      if (typeof body.wanxModel === 'string') config.wanxModel = body.wanxModel.trim();
      // CartBack 对外公网基址（邮件内联图片 src 用）
      if (typeof body.publicBaseUrl === 'string') config.publicBaseUrl = body.publicBaseUrl.trim();
      // 店铺品牌 / 默认跳转
      if (typeof body.shopBrand === 'string') config.shopBrand = body.shopBrand.trim();
      if (typeof body.shopCartUrl === 'string') config.shopCartUrl = body.shopCartUrl.trim();
      if (typeof body.shopDefaultLocale === 'string') config.shopDefaultLocale = body.shopDefaultLocale.trim();
      // G0 白名单（品牌名/专有名词，含中文品牌名；白名单内不拦截）
      if (Array.isArray(body.g0Whitelist)) {
        config.g0Whitelist = body.g0Whitelist
          .map(s => String(s).trim()).filter(Boolean).filter(s => s.length <= 40).slice(0, 50);
      }
      // Wave 5 偏好写入：body.prefs（{tone, discount_habit, signature, ...}）→ user 级持久化，
      // GET /api/state 顶层 prefs 合并返回（与 g0Whitelist 等全局键并列，互不影响）。
      // 语义：键级合并更新；value 置空串 = 删除该键；≤16 键、键名 ≤40 字、值 ≤200 字。（管理员路径复用同一实现）
      if (applyUserPrefs(body, req)) {
        logEvent('user_prefs_saved', { userId: req.userId, scope: 'admin' });
      }
      if (Number.isFinite(body.aiContextWindowTokens)) config.aiContextWindowTokens = Math.max(2048, Math.min(1000000, body.aiContextWindowTokens | 0));
      if (Number.isFinite(body.aiMaxOutputTokens)) config.aiMaxOutputTokens = Math.max(64, Math.min(32768, body.aiMaxOutputTokens | 0));
      if (Number.isFinite(body.aiContextSafetyMargin)) config.aiContextSafetyMargin = Math.max(128, Math.min(65536, body.aiContextSafetyMargin | 0));
      if (Number.isFinite(body.aiRecentTurns)) config.aiRecentTurns = Math.max(2, Math.min(100, body.aiRecentTurns | 0));
      if (Number.isFinite(body.aiSummaryTriggerRatio)) config.aiSummaryTriggerRatio = Math.max(0.25, Math.min(0.95, body.aiSummaryTriggerRatio));
      if (Number.isFinite(body.aiMaxCallsPerTurn)) config.aiMaxCallsPerTurn = Math.max(1, Math.min(8, body.aiMaxCallsPerTurn | 0));
      if (typeof body.aiCriticMode === 'string' && ['always', 'suspicious', 'off'].includes(body.aiCriticMode)) config.aiCriticMode = body.aiCriticMode;
      // 供应商专属请求参数（对象透传给 LLMClient.extraBody；null 清空）
      if (body.aiExtraBody === null) config.aiExtraBody = null;
      else if (body.aiExtraBody && typeof body.aiExtraBody === 'object' && !Array.isArray(body.aiExtraBody)) {
        config.aiExtraBody = Object.fromEntries(Object.entries(body.aiExtraBody).slice(0, 16).map(([k, v]) => [String(k).slice(0, 64), v]));
      }
      if (Number.isFinite(body.sendRateLimitPerMin)) config.sendRateLimitPerMin = Math.max(0, Math.min(1000, body.sendRateLimitPerMin | 0));
      if (Number.isFinite(body.attributionWindowDays)) config.attributionWindowDays = Math.max(1, Math.min(60, body.attributionWindowDays | 0));
      if (Number.isFinite(body.emailTimeoutDays)) config.emailTimeoutDays = Math.max(1, Math.min(30, body.emailTimeoutDays | 0));
      syncAgentConfig();
      cfg.save(config);
      return sendJson(res, 200, { status: cfg.status(config) });
    }

    // —— ⑤ 归因回执 webhook（PRD §5；豁免全局鉴权，x-webhook-secret 校验）——
    // 三种形态：
    //  A. Resend 回执：{type:'email.opened'|'email.clicked'|'email.bounced'|'email.delivered', data:{message_id, email?}}
    //     message_id → emailed 事件(esp_id) 反查 draft+audience；bounced → email_status 剔除
    //  B. Shopify 订单：{source:'shopify', event:'orders/create'|'orders/update', order:{id, email, total_price, discount_codes, financial_status}}
    //     discount_codes 命中本系统优惠码 → convert（order_id 幂等）；update 退款 → GMV 扣减
    //  C. 旧版简易格式（保留兼容）：{type:'open'|'click'|'convert', draft_id?, coupon?, audience_id?, value?}
    const RESEND_EVENT_MAP = {
      'email.sent': null, 'email.delivered': 'delivered', 'email.opened': 'open',
      'email.clicked': 'click', 'email.bounced': 'bounced', 'email.complained': 'complaint'
    };
    function resolveByEspId(messageId) {
      if (!messageId) return null;
      const ev = store.getEvents().find(e => e.type === 'emailed' && e.esp_id === messageId);
      return ev || null;
    }
    function resolveAudienceByEmail(email) {
      if (!email) return null;
      const target = String(email).toLowerCase();
      return store.getAudience().find(a => String(a.email || '').toLowerCase() === target) || null;
    }
    if (pathname === '/api/attribution' && method === 'POST') {
      const whSecret = req.headers['x-webhook-secret'];
      if (!config.webhookSecret || !authMod.secretEqual(whSecret, config.webhookSecret)) {
        return sendJson(res, 401, { error: 'bad webhook secret' });
      }
      // 安全整改：webhook 写入的事件按 draft/campaign/audience 反查归属，避免产生无归属数据
      function resolveEventOwner(draftId, audienceId) {
        if (draftId) {
          const d = store.getDraft(draftId);
          if (d && d.user_id != null) return d.user_id;
          const c = store.getCampaign(draftId);
          if (c && c.user_id != null) return c.user_id;
        }
        if (audienceId) {
          const a = store.getAudience().find(x => x.id === audienceId);
          if (a && a.user_id != null) return a.user_id;
        }
        return null;
      }
      const body = await readBody(req);
      const rawType = String(body.type || body.event || '');

      // —— A. Resend 回执 ——
      if (rawType.startsWith('email.')) {
        const mapped = RESEND_EVENT_MAP[rawType] !== undefined ? RESEND_EVENT_MAP[rawType] : 'open';
        if (!mapped) return sendJson(res, 200, { ok: true, ignored: rawType });
        const data = body.data || {};
        const emailed = resolveByEspId(data.message_id || data.messageId);
        const draftId = emailed ? emailed.draft_id : (body.draft_id || null);
        const audienceId = emailed ? emailed.audience_id : ((resolveAudienceByEmail(data.email_address || data.email) || {}).id || body.audience_id || null);
        if (mapped === 'bounced' && audienceId) {
          store.suppressAudienceEmail(audienceId);   // 卫生：自动剔除后续名单，保护域名信誉
          metricsInc('attr_bounced');
          logEvent('attribution_bounced', { draft_id: draftId, audience_id: audienceId });
        }
        store.addEvent({ type: mapped, draft_id: draftId, audience_id: audienceId, user_id: resolveEventOwner(draftId, audienceId), value: body.value || 0, esp_id: data.message_id || null });
        metricsInc('attr_' + mapped);
        logEvent('attribution', { source: 'resend', type: mapped, draft_id: draftId, audience_id: audienceId });
        return sendJson(res, 200, { ok: true });
      }

      // —— B. Shopify 订单（优惠码核销 / 退款扣减）——
      const isShopify = body.source === 'shopify' || /^orders\/(create|update)$/.test(rawType) || (body.order && (body.order.discount_codes || body.order.financial_status));
      if (isShopify) {
        const order = body.order || body;
        const orderId = String(order.id || order.order_id || body.order_id || '');
        const codes = (order.discount_codes || order.discountCodes || []).map(c => String(c).trim().toLowerCase());
        const financial = String(order.financial_status || body.financial_status || '').toLowerCase();

        // 退款扣减：orders/update（financial_status=refunded / 显式 refund）→ 命中 convert 事件清零
        if (/orders\/update/.test(rawType) || financial === 'refunded' || body.refund) {
          const conv = store.findEventByOrderId(orderId);
          if (conv && conv.type === 'convert' && !conv.refunded) {
            store.updateEvent(conv.id, { value: 0, refunded: 1 });
            metricsInc('attr_refund');
            logEvent('attribution_refund', { order_id: orderId, event_id: conv.id, deducted: conv.value });
            return sendJson(res, 200, { ok: true, refunded: true, deducted: conv.value });
          }
          return sendJson(res, 200, { ok: true, refunded: false, reason: conv ? 'already_refunded' : 'no_convert_found' });
        }

        // 优惠码核销 → convert（不限窗口；order_id 幂等，宁漏勿错不跨码归因）
        // Wave 4 F3③：码匹配扩展到批次（campaign.discount.code）；批次 scope 事件的 draft_id = campaign.id（与 sends 同口径）
        if (!codes.length) return sendJson(res, 200, { ok: true, ignored: 'no discount codes' });
        const drafts = store.getDrafts();
        const hitDraft = drafts.find(d => d.coupon && codes.includes(String(d.coupon).toLowerCase()));
        const hitCamp = !hitDraft ? store.findCampaignByCoupon(codes[0]) : null;
        if (!hitDraft && !hitCamp) return sendJson(res, 200, { ok: true, ignored: 'code not ours' });
        if (orderId && store.findEventByOrderId(orderId)) {
          return sendJson(res, 200, { ok: true, deduped: true });   // 同单只归因一次
        }
        const aud = resolveAudienceByEmail(order.email);
        const value = parseFloat(order.total_price) || 0;
        const couponHit = hitDraft ? hitDraft.coupon : hitCamp.discount.code;
        store.addEvent({ type: 'convert', draft_id: hitDraft ? hitDraft.id : hitCamp.id, audience_id: (aud || {}).id || null, user_id: resolveEventOwner(hitDraft ? hitDraft.id : hitCamp.id, (aud || {}).id || null), value, order_id: orderId || null });
        if (aud) tagsMod.weightForConversion(store, aud.id);   // ⑤ 标签加权：convert → w += 2
        benchmarkMod.rebuildBenchmark(store);
        emitRecoverReceipt({
          draftId: hitDraft ? hitDraft.id : null, campaignId: hitCamp ? hitCamp.id : null,
          audience: aud, coupon: couponHit, value
        });
        metricsInc('attr_convert');
        logEvent('attribution', { source: 'shopify', type: 'convert', draft_id: hitDraft ? hitDraft.id : hitCamp.id, order_id: orderId, value, audience_id: (aud || {}).id || null });
        return sendJson(res, 200, { ok: true, attributed: true });
      }

      // —— C. 旧版简易格式（兼容演示模式/既有测试）——
      let draftId = body.draft_id || (body.data && body.data.draft_id);
      const type = ['open', 'click', 'convert', 'delivered', 'bounced'].includes(body.type) ? body.type
        : (body.event === 'open' ? 'open' : body.event === 'click' ? 'click' : body.event === 'convert' ? 'convert' : 'open');
      // 优惠码核销归因：按 coupon 反查 draft（订单回传）；Wave 4：批次码同样可核销（scope = campaign.id）
      if (!draftId && body.coupon) {
        const d = store.getDrafts().find(x => x.coupon === body.coupon);
        if (d) draftId = d.id;
        else {
          const c = store.findCampaignByCoupon(body.coupon);
          if (c) draftId = c.id;
        }
      }
      if (type === 'convert' && body.order_id && store.findEventByOrderId(String(body.order_id))) {
        return sendJson(res, 200, { ok: true, deduped: true });
      }
      const ev = store.addEvent({ type, draft_id: draftId, audience_id: body.audience_id || null, user_id: resolveEventOwner(draftId, body.audience_id || null), value: body.value || 0, order_id: body.order_id ? String(body.order_id) : null });
      if (type === 'convert' && body.audience_id) tagsMod.weightForConversion(store, body.audience_id);
      if (type === 'convert' && draftId) {
        // Wave 4 F3③：conversion 到达 → 回流报喜 + estGmv 翻转写回（draft_id 也可能是批次 scope id）
        const scopeCamp = store.getCampaign(draftId);
        emitRecoverReceipt({
          draftId: scopeCamp ? null : draftId, campaignId: scopeCamp ? scopeCamp.id : null,
          audienceId: body.audience_id || null, coupon: body.coupon || null, value: body.value || 0
        });
      }
      if (type === 'bounced' && body.audience_id) store.suppressAudienceEmail(body.audience_id);
      metricsInc(type === 'convert' ? 'attr_convert' : 'attr_' + type);
      logEvent('attribution', { source: 'legacy', type, draft_id: draftId, value: body.value || 0 });
      return sendJson(res, 200, { ok: true, event_id: ev.id });
    }

    // —— 监控指标（架构 §7 B6）——
    if (pathname === '/api/metrics' && method === 'GET') {
      const m = loadMetrics();
      const total = m.send_real + m.send_sim || 0;
      return sendJson(res, 200, {
        ...m,
        failRate: total ? +((m.send_fail || 0) / total).toFixed(3) : 0,
        guardrailHitRate: (m.guardrail_L0 + m.guardrail_L2 + m.guardrail_L4 + m.guardrail_L3) || 0
      });
    }

    // —— 重置（整改 1c 安全：本地模式保持原行为清全部+重建种子；登录用户只清自己的 acts/drafts，店铺级 audience/events 无权清）——
    if (pathname === '/api/reset' && method === 'POST') {
      if (req.authMode === 'local') {
        store.reset();
        tagsMod.scoreAudience(store, store.getAudience());   // 重置后重打种子标签
      } else {
        store._write('acts', store._read('acts').filter(a => !a.user_id || a.user_id !== req.userId));
        store._write('drafts', store._read('drafts').filter(d => !d.user_id || d.user_id !== req.userId));
      }
      logEvent('reset', { authMode: req.authMode, userId: req.userId });
      return sendJson(res, 200, { ok: true });
    }

    // —— 导出（安全整改：acts/drafts/audience/events 全部按当前用户域导出，防任意账号拖走全部客户 PII）——
    if (pathname === '/api/export' && method === 'GET') {
      const so = scopeOpts(req);
      return sendJson(res, 200, {
        acts: store.getActsByUser(req.userId, so), drafts: store.getDraftsByUser(req.userId, so),
        audience: store.getAudienceForUser(req.userId, so), events: store.getEventsForUser(req.userId, so), kpis: store.getKpis(config.mode, req.userId, so)
      });
    }

    // —— PRD v5 新增端点 ——
    // 健康检查（底座）：含存储后端 / 队列 / 熔断快照，供部署编排与异常条
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true, uptime_s: Math.floor(process.uptime()),
        mode: config.mode,
        aiConfigured: Boolean(config.aiKey), espConfigured: espReady(),
        storage: store.b ? store.b.kind : 'unknown',
        queue: queue.stats(),
        breakers: breakers.snapshotAll()
      });
    }

    // 异步任务轮询（前端 202 入队后查进度；安全整改：任务按归属可见——payload 反查 draft/campaign 归属，系统任务仅管理员）
    const jm = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (jm && method === 'GET') {
      const job = store.getJob(jm[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      const p = job.payload || {};
      let jobOwner = p.user_id != null ? p.user_id : (p.userId != null ? p.userId : null);
      if (jobOwner == null && p.draftId) { const d = store.getDraft(p.draftId); jobOwner = d ? (d.user_id != null ? d.user_id : null) : null; }
      if (jobOwner == null && p.campaignId) { const c = store.getCampaign(p.campaignId); jobOwner = c ? (c.user_id != null ? c.user_id : null) : null; }
      const jobVisible = jobOwner != null ? jobOwner === req.userId : isAdminReq(req);
      if (!jobVisible) return sendJson(res, 404, { error: 'job not found' });
      return sendJson(res, 200, {
        id: job.id, type: job.type, status: job.status, retry_count: job.retry_count,
        result: job.result || null, error: job.error || null,
        created_at: job.created_at, updated_at: job.updated_at
      });
    }

    // 海报生成入队（换一批/重试也走这里；dedupe: posters:{draftId}）
    if (pathname === '/api/posters' && method === 'POST') {
      const body = await readBody(req);
      const draft = store.getDraft(body.draftId);
      if (!canSeeRow(draft, req)) return sendJson(res, 404, { error: 'draft not found' });
      const { job } = queue.enqueue({ type: 'posters', payload: { draftId: draft.id, user_id: draft.user_id != null ? draft.user_id : req.userId, regenerate: Boolean(body.regenerate) }, dedupeKey: 'posters:' + draft.id + ':' + (body.regenerate ? Date.now() : 'base') });
      return sendJson(res, 202, { job_id: job.id, queued: true });
    }

    // 受众圈选条件预览（确认卡展示：条件 + 命中人数 + 预估 GMV；安全整改：命中概览按用户域）
    if (pathname === '/api/audience/preview' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, audienceConditions(String(body.audience || '').slice(0, 200), scopeOpts(req)));
    }

    // 消费者标签读取 / 手动维护（manual 来源不被 scoring/attribution 覆盖；安全整改：仅本人受众可读写）
    const tm = pathname.match(/^\/api\/audience\/([\w-]+)\/tags$/);
    if (tm && method === 'GET') {
      const aud = store.getAudienceForUser(req.userId, scopeOpts(req)).find(a => a.id === tm[1]);
      if (!aud) return sendJson(res, 404, { error: 'audience not found' });
      return sendJson(res, 200, { audience_id: tm[1], tags: store.getAudienceTags(tm[1]) });
    }
    if (tm && method === 'PUT') {
      const body = await readBody(req);
      const aud = store.getAudienceForUser(req.userId, scopeOpts(req)).find(a => a.id === tm[1]);
      if (!aud) return sendJson(res, 404, { error: 'audience not found' });
      const list = Array.isArray(body.tags) ? body.tags.slice(0, 20) : [];
      const ALLOWED = ['price_sensitivity', 'intent', 'category_like', 'style_preference', 'gender', 'age_range', 'device', 'customer_segment', 'language'];
      for (const t of list) {
        if (!t || !ALLOWED.includes(t.tag_type)) continue;
        // 归一到合法取值，归一失败不写入
        let tagValue = String(t.tag_value || '').slice(0, 40);
        if (t.tag_type === 'style_preference') {
          const normalized = tagsMod.normalizeStyle(tagValue);
          if (!normalized) continue;
          tagValue = normalized;
        } else if (t.tag_type === 'gender') {
          const normalized = tagsMod.normalizeGender(tagValue);
          if (!normalized) continue;
          tagValue = normalized;
        } else if (t.tag_type === 'customer_segment') {
          const normalized = tagsMod.normalizeSegment(tagValue);
          if (!normalized) continue;
          tagValue = normalized;
        } else if (t.tag_type === 'language') {
          const normalized = tagsMod.localeToLanguage(tagValue);
          if (!normalized) continue;
          tagValue = normalized;
        }
        store.upsertAudienceTag({
          audience_id: tm[1], tag_type: t.tag_type,
          tag_value: tagValue,
          weight: Math.max(0, Math.min(10, Number(t.weight) || 5)),
          source: 'manual'
        });
      }
      logEvent('tags_manual', { audience_id: tm[1], count: list.length });
      return sendJson(res, 200, { audience_id: tm[1], tags: store.getAudienceTags(tm[1]) });
    }

    // 标签效果聚合（数据页「标签效果」区块：Top5 + 样本数；安全整改：只在本人受众域内聚合）
    if (pathname === '/api/tags/effect' && method === 'GET') {
      const ids = new Set(store.getAudienceForUser(req.userId, scopeOpts(req)).map(a => a.id));
      return sendJson(res, 200, { effect: tagsMod.tagEffect(store, { minSample: 1, audienceIds: ids }).slice(0, 10) });
    }

    // —— ⑥ 竞品雷达：源管理（user_id 隔离）——
    if (pathname === '/api/competitors' && method === 'GET') {
      const sources = store.listCompetitorSources(req.userId);
      return sendJson(res, 200, {
        sources,
        collection_address: competitorsMod.collectionAddress(req.userId, config.espFrom),
        cards_count: store.listStrategyCards(req.userId).length
      });
    }
    if (pathname === '/api/competitors' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return sendJson(res, 400, { error: '竞品名称不能为空' });
      const s = store.upsertCompetitorSource({
        user_id: req.userId, name,
        mailbox: String(body.mailbox || '').trim().slice(0, 120) || null,
        status: 'active', last_collected_at: null
      });
      logEvent('competitor_source_add', { source_id: s.id, userId: req.userId });
      return sendJson(res, 200, { source: s, sources: store.listCompetitorSources(req.userId) });
    }
    const cdm = pathname.match(/^\/api\/competitors\/([\w-]+)$/);
    if (cdm && method === 'DELETE') {
      store.deleteCompetitorSource(cdm[1], req.userId);
      return sendJson(res, 200, { ok: true, sources: store.listCompetitorSources(req.userId) });
    }

    // —— ⑥ 收集入口：手动粘贴 MVP（session 鉴权）+ 转发制 inbound（webhook secret）二合一 ——
    // 鉴权：登录会话；或 x-webhook-secret / ?token=（转发邮箱 inbound webhook 无会话）
    if (pathname === '/api/competitors/inbound' && method === 'POST') {
      const inboundAuth = authMod.secretEqual(req.headers['x-webhook-secret'], config.webhookSecret)
        || authMod.secretEqual(parsed.query.token, config.webhookSecret);
      let userId = req.userId || null;
      if (!userId && !inboundAuth) return sendJson(res, 403, { error: 'unauthorized' });
      if (!userId && inboundAuth) userId = String(parsed.query.uid || 'inbound');
      const body = await readBody(req);
      const rawEmail = String(body.raw_email || body.raw || '').slice(0, 50000);
      const competitorName = String(body.competitor_name || body.name || '').trim().slice(0, 60);
      if (!rawEmail) return sendJson(res, 400, { error: '缺少邮件原文（raw_email）' });
      // 安全整改：普通用户每日 AI 额度（竞品拆解一次 = 1 次；inbound webhook 走 secret 不受此限）
      if (req.userId && !isAdminReq(req) && !llmQuotaTry(req.userId, 1)) {
        return sendJson(res, 429, { error: '今日 AI 使用额度已用完（每用户每日 ' + (config.userLlmDailyLimit || 0) + ' 次），请明天再试或联系管理员。' });
      }
      // 预过滤（规则）：退订链接 AND 促销词 → 营销邮件；订单/物流通知 → 丢弃
      const pf = competitorsMod.prefilter(rawEmail);
      metricsInc(pf.keep ? 'competitor_kept' : 'competitor_dropped');
      if (!pf.keep) {
        logEvent('competitor_prefilter_drop', { reason: pf.reason });
        return sendJson(res, 200, { kept: false, reason: pf.reason, message: '已丢弃：' + pf.reason + '（仅收营销邮件）' });
      }
      // 拆解（LLM 一次调用；AI 离线降级启发式；G6：学结构不抄文案）
      const llmJSON = config.aiKey ? async (messages) => {
        const r = await breakers.get('llm').exec(() => makeLlmClient().chatStructured({ messages, maxTokens: 1024 }));
        return { reply: r.reply, needs: r.needs, jsonOk: r.jsonOk, raw: r.raw };
      } : null;
      const { card, provider, warning } = await competitorsMod.extractStrategyCard({ rawEmail, competitorName, llmJSON });
      if (warning) logEvent('competitor_extract_fallback', { warning });
      const saved = store.upsertStrategyCard({
        user_id: userId,
        competitor_name: card.competitor_name || competitorName || null,
        theme_formula: card.theme_formula || null,
        angle: card.angle || null,
        discount_range: card.discount_range || null,
        timing: card.timing || null,
        frequency: card.frequency || null,
        visual_style: card.visual_style || null,
        keywords: competitorsMod.cardKeywords(card),
        raw_email: rawEmail,          // G6：仅存 30 天，g6_purge job 清除（保留卡片）
        collected_at: Date.now(),
        embedding_id: null            // P2：text-embedding-v4 检索
      });
      // 关联源最近收集时间
      const src = store.listCompetitorSources(userId).find(s => s.name === (saved.competitor_name || competitorName));
      if (src) store.upsertCompetitorSource({ ...src, last_collected_at: Date.now() });
      metricsInc('strategy_cards_created');
      logEvent('strategy_card_created', { card_id: saved.id, provider, userId });
      return sendJson(res, 200, { kept: true, card: publicCard(saved), provider });
    }

    // —— ⑥ 策略卡列表（G6：原文不出库——任何响应都不含 raw_email）——
    if (pathname === '/api/strategy-cards' && method === 'GET') {
      return sendJson(res, 200, { cards: store.listStrategyCards(req.userId).map(publicCard) });
    }
    const scm = pathname.match(/^\/api\/strategy-cards\/([\w-]+)$/);
    if (scm && method === 'DELETE') {
      store.deleteStrategyCard(scm[1], req.userId);
      return sendJson(res, 200, { ok: true, cards: store.listStrategyCards(req.userId).map(publicCard) });
    }

    // —— ④ 按人群/语言预览（邮件编辑器：变体样例 + 语言分布 + G0 拦截名单）——
    const pm = pathname.match(/^\/api\/draft\/([\w-]+)\/preview$/);
    if (pm && method === 'GET') {
      const draft = store.getDraft(pm[1]);
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      if (!canSeeRow(draft, req)) return sendJson(res, 404, { error: 'draft not found' });
      const recipients = resolveRecipients(draft).filter(r => r.email_status !== 'email_invalid' && r.email_status !== 'unsubscribed');
      const rendered = await renderForDraft(draft, recipients);
      const tiers = render.TIERS.map(tier => {
        const same = rendered.messages.filter(m => m.tier === tier);
        const m = same[0];
        return m
          ? { tier, count: same.length, subject: m.subject, body: m.body, locale: m.locale, sample: (m.recipient || {}).name || '', blocked: m.blocked }
          : { tier, count: 0 };
      });
      return sendJson(res, 200, {
        draft_id: draft.id,
        audience_conditions: draft.audience_conditions || audienceConditions(draft.audience, ownerScope(draft.user_id)),
        tiers,                                   // 「按人群预览」：每档一条样例（{{}} 已按样例收件人展开）
        languages: render.languageDistribution(recipients),   // 「语言预览」：分布
        g0_blocked: draft.g0_blocked || [],      // 被拦截邮件（标红 + 原因）
        stats: rendered.stats
      });
    }

    // —— 邮件公开端点（页脚热区目标，Figma 446:4589）——
    // View in browser：浏览器内查看整封邮件（邮件客户端点开，无会话，故豁免鉴权）
    const evm = pathname.match(/^\/api\/email\/view\/([\w-]+)$/);
    if (evm && method === 'GET') {
      const d = store.getDraft(evm[1]);
      if (!d || !d.html || String(d.html).startsWith('ERROR')) {
        return sendJson(res, 404, { error: 'draft not found' });
      }
      // 安全整改：html 由 LLM 生成链路产出（会参考竞品邮件原文，存在提示注入面），且本端点无鉴权、
      // 与 API 同源——同 EditModal 预览 iframe 的 sandbox 思路，用 CSP 禁脚本/表单/内嵌，保留图片样式与链接。
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self' https: http: data:; script-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(applyFooterLinks(d.html, evm[1]));
      return;
    }

    // Unsubscribe：退订落地页；带 e 参数时把该收件人标记为已退订（后续发送剔除）
    if (pathname === '/api/email/unsubscribe' && method === 'GET') {
      const draftId = parsed.query.d || '';
      const email = String(parsed.query.e || '').trim().toLowerCase();
      let marked = false;
      if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        const aud = store.getAudience().find(a => (a.email || '').toLowerCase() === email);
        if (aud && aud.email_status !== 'unsubscribed') {
          store.unsubscribeAudienceEmail(aud.id);
          marked = true;
        }
        logEvent('email_unsubscribed', { draft_id: draftId, email, marked });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Unsubscribed — CartBack</title><style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1e293b;background:#fcfdff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#fff;border:1px solid #dde2e8;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.06);padding:40px 48px;text-align:center;max-width:420px}h1{font-size:20px;margin:0 0 10px}p{color:#8a95a0;font-size:13.5px;margin:0}</style></head>' +
        `<body><div class="card"><h1>You're unsubscribed &#10003;</h1><p>${marked ? 'This address will no longer receive recovery emails from CartBack.' : 'You will no longer receive recovery emails from CartBack.'}</p></div></body></html>`
      );
      return;
    }

    // —— 图片服务（邮件预览/海报用） ——
    // 安全（P1 修复）：只允许 output/ 目录树内的文件，防绝对路径穿越读取任意文件
    const imgMatch = pathname.match(/^\/api\/image\/(.+)$/);
    if (imgMatch && method === 'GET') {
      const imgPath = decodeURIComponent(imgMatch[1]);
      const fs = require('fs');
      const path = require('path');
      const OUTPUT_ROOT = path.join(__dirname, 'output');
      const fullPath = path.resolve(imgPath);
      const rel = path.relative(OUTPUT_ROOT, fullPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return sendJson(res, 403, { error: 'forbidden: image path outside output directory' });
      }
      if (!fs.existsSync(fullPath)) return sendJson(res, 404, { error: 'image not found', path: fullPath });
      const ext = path.extname(fullPath).toLowerCase();
      // webp：商品库上传允许 webp（lib/products.js 嗅探白名单），这里必须配对返回真实 MIME
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    return sendJson(res, 404, { error: 'route not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

// —— 安全整改：进程兜底（公网部署的可用性）——
// async 处理器里任何未被路由内 try 捕获的异常（如早前的畸形 cookie URIError）会变成
// unhandledRejection，Node 默认直接退出 = 单请求远程 DoS。此处记录并保持存活；根因仍须逐个修复。
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ t: 'ey', ts: Date.now(), type: 'unhandled_rejection', error: String(reason && reason.message || reason) }));
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ t: 'ey', ts: Date.now(), type: 'uncaught_exception', error: String(err && err.message || err) }));
});

const PORT = process.env.PORT || 4173;
server.listen(PORT, () => {
  console.log(`CartBack v3 本地服务已启动: http://localhost:${PORT}`);
  console.log(`模式: ${config.mode} | AI: ${config.aiKey ? '已配置' : '未配置(桩模型)'} | ESP: ${config.espKey ? '已配置' : '仿真'}`);
  console.log(`本地令牌: ${config.localToken}`);

  // —— 周期任务（PRD §0.5 jobs / G6 / ⑤ 标签窗口反哺）——
  // 老库种子维度回填：schema 升级后存量种子行新列是 NULL，按姓名回填（幂等，只在缺值时写）。
  // 回填改了行 → 需重打分让 style/age_range/device 等标签补出来（dimsChanged 触发重打）。
  const dimsChanged = store.backfillSeedDimensions();
  // 受众标签补打：首次启动（无标签）/ 老库升级新增维度 / 种子维度刚回填。
  // 用 meta 标记 + dimsChanged 控制只跑一次；upsertAudienceTag 同源取高、manual 不覆盖，幂等安全。
  if (store.getAllAudienceTags().length === 0) {
    tagsMod.scoreAudience(store, store.getAudience());
  } else if (dimsChanged || store.getMeta('tag_dims_v2_migrated') !== '1') {
    tagsMod.scoreAudience(store, store.getAudience());
    store.setMeta('tag_dims_v2_migrated', '1');
  }
  // G6：竞品原文 30 天清除（每小时检查一次）
  setInterval(() => queue.enqueue({ type: 'g6_purge', payload: {} }), 3600 * 1000);
  // ⑤ 窗口期满未转化 → 标签 −0.5（每 6 小时检查一次）
  setInterval(() => queue.enqueue({ type: 'tag_expiry', payload: {} }), 6 * 3600 * 1000);
  // —— Wave 5 A4：僵尸会话收口（每小时扫描；启动即跑一次兜底重启间隙）——
  queue.enqueue({ type: 'zombie_sweep', payload: {} });
  setInterval(() => queue.enqueue({ type: 'zombie_sweep', payload: {} }), 3600 * 1000);
  // —— Wave 3 I2：启动对账停发日历（窗口已过 → 日历冻结批次自动顺延恢复）并重排其发送 job ——
  const restoredBoot = campaignsMod.reconcileBlackout(store);
  for (const camp of restoredBoot) {
    if (camp.scheduled_at) {
      queue.enqueue({
        type: 'send_campaign', payload: { campaignId: camp.id },
        dedupeKey: 'send_campaign:' + camp.id + ':' + camp.scheduled_at, runAfter: camp.scheduled_at
      });
    }
  }
  if (restoredBoot.length) logEvent('blackout_reconcile_boot', { restored: restoredBoot.length });
});
