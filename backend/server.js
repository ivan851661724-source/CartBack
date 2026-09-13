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
queue.register('posters', (j) => processPosterJob(j));
queue.register('g6_purge', () => competitorsMod.g6Purge(store));
queue.register('tag_expiry', () => applyTagExpiryWeights());
queue.recover();

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

async function generateMailHtml(draft, card) {
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
    // 折扣数值口径唯一：优先方案卡 discountNum（producePlanCard 统一产生，% off），文本兜底解析；默认与 variants/render 一致（10）
    discount: Number(card.discountNum) || parseFloat(card.discount) || 10,
    brand: (card.brand || config.shopBrand || 'CartBack') + '',
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
    // 受众标签分布快照（圈中人群的性别/年龄段/机型/分层/风格品类代表值）——
    // mailgen 据此填充 UserRecord 画像（文案 toneHint + 图片人群风格），此前恒为硬编码默认值
    tag_distribution: Array.isArray(draft.tag_distribution) ? draft.tag_distribution : [],
    // 配置注入（零重复录入）
    ai_config,
    // 公网基址：邮件内联图片 src 用 ${publicBaseUrl}/api/image/<path>，留空则退回本地路径（仅预览可用）
    public_base_url: config.publicBaseUrl || '',
    // 品牌统一用商家名（覆盖方案卡里 per-profile 的测试品牌）
    shop_brand: config.shopBrand || '',
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
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
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

// 真实模型教练：一次返回回复、needs patch 与来源待校验的 memory patch。
// opts.onReplyToken 存在时走真流式（边生成边上屏），否则保持一次性结构化调用。
async function llmCoach(messages, opts) {
  if (!config.aiKey) throw new Error('AI 未配置');
  const client = makeLlmClient();
  const r = (opts && opts.onReplyToken)
    ? await client.streamChatStructured({ messages, maxTokens: config.aiMaxOutputTokens, onReplyToken: opts.onReplyToken })
    : await client.chatStructured({ messages, maxTokens: config.aiMaxOutputTokens });
  return {
    reply: r.reply,
    needs: r.needs,
    memoryPatch: r.memoryPatch,
    profilePatch: r.profilePatch,
    usage: r.usage,
    requestCount: r.requestCount,
    jsonOk: r.jsonOk
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

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
      from: c.espFrom,
      to: [r.email],
      subject: r.subject,
      text: r.body
    };
    // HTML 邮件仅对生成过 html 的变体附上（mailgen html 为标准档直出；其余档用纯文本，避免跨变体串内容）
    if (r.html) msg.html = r.html;
    else if (!r.tier || r.tier === 'standard') {
      if (draft.html && !String(draft.html).startsWith('ERROR')) msg.html = draft.html;
    }
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
  const sender = { name: c.espSenderName || 'CartBack', email: c.espFrom };
  const ids = [];
  let batches = 0;
  for (const r of messages) {
    const body = {
      sender,
      to: [{ email: r.email }],
      subject: String(r.subject || '').slice(0, 200),
      textContent: String(r.body || '').slice(0, 20000),
    };
    const html = r.html || ((!r.tier || r.tier === 'standard') && draft.html && !String(draft.html).startsWith('ERROR') ? draft.html : '');
    if (html) body.htmlContent = html;
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
    const html = r.html || ((!r.tier || r.tier === 'standard') && draft.html && !String(draft.html).startsWith('ERROR') ? draft.html : '');
    const out = await sendSmtp({
      host: c.smtpHost, port: c.smtpPort, user: c.smtpUser, pass: c.smtpPass,
      from: c.espFrom, senderName: c.espSenderName,
      to: r.email, subject: r.subject, text: r.body, html,
    });
    ids.push((out && out.messageId) || 'smtp-' + Date.now().toString(36));
    if (messages.length > 1) await sleep(500);
  }
  return { id: ids.join(','), ids, batches: messages.length };
}

// 依据方案卡受众描述解析真实收件人（P0 真实源未接前用假种子/导入名单）
function matchAudienceByDesc(desc) {
  const all = store.getAudience();
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
  return filterTargetable(matchAudienceByDesc(draft.audience)).slice(0, 200);
}

// PRD §1 过滤口径：真实邮箱 且 未转化 且 挽回窗口 30 天（与确认卡展示的圈选条件同源，说到做到）
const RECOVERY_WINDOW_MS = 30 * 86400000;
function filterTargetable(list) {
  const byId = new Map(store.getAudience().map(a => [a.id, a]));
  const converted = new Set();
  for (const e of store.getEvents()) {
    if (e.type !== 'convert' || !e.audience_id) continue;
    const a = byId.get(e.audience_id);
    if (a && a.email) converted.add(String(a.email).toLowerCase());
  }
  const cutoff = Date.now() - RECOVERY_WINDOW_MS;
  return (list || [])
    .filter(a => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email || ''))
    .filter(a => (a.at_risk_at || a.created_at || 0) >= cutoff)
    .filter(a => !converted.has(String(a.email).toLowerCase()));
}

// —— ② 受众圈选条件（确认卡展示用）：需求关键词 → 结构化过滤条件 + 命中概览 ——
function audienceConditions(desc) {
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
  const matched = filterTargetable(matchAudienceByDesc(desc));   // 与发送端同一口径
  return {
    desc: desc || '全部受众',
    filters,
    matchedCount: matched.length,
    estGmv: +matched.reduce((s, a) => s + (a.estGmv || 0), 0).toFixed(2)
  };
}

// —— ③ 72h 频控：同收件人同活动（受众口径）72h 内不重发（PRD §3.4）——
const FREQ_WINDOW_MS = 72 * 3600 * 1000;
function frequencyFilter(recipients, draft) {
  const cutoff = Date.now() - FREQ_WINDOW_MS;
  const campaignKey = (draft.audience || '').toLowerCase();
  const emailedEvents = store.getEvents().filter(e => e.type === 'emailed' && e.ts >= cutoff);
  // 已发过的收件人（72h 内任意草稿）；同活动（同受众口径）的才拦截，跨活动放行
  const draftsById = new Map(store.getDrafts().map(d => [d.id, d]));
  const recentlyEmailed = new Set();
  for (const e of emailedEvents) {
    const d = draftsById.get(e.draft_id);
    if (d && (d.audience || '').toLowerCase() === campaignKey) recentlyEmailed.add(e.audience_id);
  }
  const allow = recipients.filter(r => !recentlyEmailed.has(r.id));
  return { allow, skipped: recipients.length - allow.length };
}

// —— ESP 发信就绪判定（按供应商取凭证；走查部署 P0：smtp 供应商此前被 espKey 门槛永远判成未配置）——
function espReady() {
  if (config.espProvider === 'smtp') {
    return Boolean(config.smtpHost && config.smtpUser && config.smtpPass && config.espFrom);
  }
  return Boolean(config.espKey && config.espFrom);
}

// —— ③ 发送前预检 + 失败分类（PRD §3.4：域名验证/邮箱格式/限额，失败给分类人话提示）——
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
  const valid = all.filter(r => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || '') && r.email_status !== 'email_invalid');
  if (!valid.length) problems.push({ type: 'no_recipients', human: '没有可发送的收件人（邮箱无效或都被退信剔除了）。' });
  const freq = frequencyFilter(valid, draft);
  if (!freq.allow.length) problems.push({ type: 'frequency_capped', human: '这批人 72 小时内已经发过同一场活动，先别打扰了。' });
  if (config.sendRateLimitPerMin > 0 && freq.allow.length > config.sendRateLimitPerMin * 5) {
    problems.push({ type: 'quota_warning', human: `本批 ${freq.allow.length} 人超过当前发送限额建议值，系统会自动分批限速。` });
  }
  const blocking = problems.filter(p => !['quota_warning', 'domain_mismatch'].includes(p.type));
  return {
    ok: blocking.length === 0,
    problems,
    recipients: valid.length,
    skippedByFrequency: freq.skipped,
    sendable: freq.allow.length
  };
}

// ④ 渲染管线消费方：发送前逐收件人渲染（变体选择→语种→模板展开→G0 拦截）
async function renderForDraft(draft, recipients) {
  const draftFacts = {
    id: draft.id, coupon: draft.coupon, discount: draft.discount,
    // 注意：product 绝不回退到 audience（商家侧中文描述）——进消费者邮件的事实必须无中文，否则 G0 全拦
    product: draft.product || '', offer: draft.offer || '',
    brand: config.shopBrand || 'CartBack'
  };
  const variants = (Array.isArray(draft.variants) && draft.variants.length)
    ? draft.variants
    : variantsMod.standardVariants({ brand: config.shopBrand, discount: draft.discount, coupon: draft.coupon, product: draftFacts.product });
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

// 仿真归因事件（演示模式驱动看板；真实模式仅在有回执时写入）
function scheduleSimEvents(draft, recipients) {
  const now = Date.now();
  recipients.forEach((r, i) => {
    const base = now + i * 1200;
    store.addEvent({ type: 'emailed', draft_id: draft.id, audience_id: r.id, ts: base });
    if (Math.random() < 0.72) store.addEvent({ type: 'open', draft_id: draft.id, audience_id: r.id, ts: base });
    if (Math.random() < 0.34) store.addEvent({ type: 'click', draft_id: draft.id, audience_id: r.id, ts: base + 3000 });
    if (Math.random() < 0.14) {
      const value = +(r.abandoned_value * (0.1 + Math.random() * 0.2)).toFixed(2);
      store.addEvent({ type: 'convert', draft_id: draft.id, audience_id: r.id, value, ts: base + 9000 });
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

async function sendDraft(draft) {
  const all = resolveRecipients(draft).filter(r => r.email_status !== 'email_invalid');
  // 预检不通过（无人可发）直接失败并分类提示
  const check = precheckSend(draft);
  if (!check.ok) {
    draft.status = 'failed';
    draft.fail_reason = (check.problems.find(p => p.type !== 'quota_warning') || {}).human || 'precheck_failed';
    upsertDraftPreservingAsync(draft);
    metricsInc('send_fail');
    logEvent('send_fail', { draft_id: draft.id, reason: draft.fail_reason });
    return { error: draft.fail_reason, problems: check.problems, recipients: 0, cost: 0, estGmv: draft.estGmv };
  }
  const { allow, skipped } = frequencyFilter(all, draft);
  metricsInc('send_volume', allow.length);
  const real = (config.mode === 'real' && espReady());
  draft.status = 'sending'; upsertDraftPreservingAsync(draft);
  if (!real) {
    draft.status = 'sent';
    draft.sent_at = Date.now();
    draft.esp_message_id = 'sim_' + uid();
    draft.cost = +(allow.length * 0.02).toFixed(2); // 仿真混合成本
    draft.skipped_by_frequency = skipped;
    draft.g0_blocked = [];   // 仿真档不做 G0 拦截（内容为商家确认过的原稿）
    upsertDraftPreservingAsync(draft);
    scheduleSimEvents(draft, allow);
    benchmarkMod.rebuildBenchmark(store);
    metricsInc('send_sim');
    logEvent('send', { real: false, recipients: allow.length, skipped_by_frequency: skipped, cost: draft.cost });
    return { real: false, recipients: allow.length, skippedByFrequency: skipped, cost: draft.cost, estGmv: draft.estGmv };
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
      draft.skipped_by_frequency = skipped;
      // 记录 per-recipient 发送事实（频控 / 标签反哺窗口 / ESP 回执映射的依据）
      const espIds = Array.isArray(r.ids) ? r.ids : [];
      for (let i = 0; i < sendable.length; i++) {
        store.addEvent({
          type: 'emailed', draft_id: draft.id,
          audience_id: (sendable[i].recipient || {}).id || null,
          esp_id: espIds[i] || null, ts: Date.now()
        });
      }
      upsertDraftPreservingAsync(draft);
      benchmarkMod.rebuildBenchmark(store);
      metricsInc('send_real');
      logEvent('send', { real: true, recipients: sendable.length, skipped_by_frequency: skipped, g0_blocked: blockedList.length, attempt, cost: draft.cost });
      return { real: true, id: draft.esp_message_id, recipients: sendable.length, skippedByFrequency: skipped, g0Blocked: blockedList.length, cost: draft.cost, estGmv: draft.estGmv };
    } catch (e) { lastErr = e; await sleep(1000 * attempt); }
  }
  draft.status = 'failed';
  draft.fail_reason = String(lastErr && lastErr.message || lastErr);
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
  const r = await sendDraft(draft);
  return r;
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
  if (pathname !== '/api/bootstrap' && !pathname.startsWith('/api/auth/') && pathname !== '/api/attribution' && !pathname.startsWith('/api/image/') && pathname !== '/api/health') {
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
      if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) return sendJson(res, 400, { error: '密码至少 8 位，且同时包含字母和数字' });
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
      return sendJson(res, 200, {
        status: cfg.status(config),
        acts: store.getActsByUser(req.userId),
        drafts: store.getDraftsByUser(req.userId),
        audience: store.getAudience(),
        kpis: store.getKpis(config.mode, req.userId),
        week: store.getKpisWeek(config.mode, req.userId),   // UI v4 整改 2：叙事条本周口径
        trend: store.getTrend(req.userId),
        metrics: loadMetrics(),
        demoAnchorRoi: 24.9
      });
    }

    if (pathname === '/api/agent-profile' && method === 'GET') {
      return sendJson(res, 200, { profile: normalizeAgentProfile(store.getAgentProfile(req.userId)) });
    }
    if (pathname === '/api/agent-profile' && method === 'DELETE') {
      store.deleteAgentProfile(req.userId);
      return sendJson(res, 200, { ok: true, profile: {} });
    }

    // —— 创建引导会话（支持 preset 预选受众：受众模块「点开画像跳配置」）——
    if (pathname === '/api/act' && method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch (e) { body = {}; }
      const act = {
        id: uid('act_'), stage: 'S0', needs: {}, messages: [],
        memory: { facts: [], decisions: [], corrections: [] },
        context_summary: null, summary_cursor: 0, context_version: 1,
        status: 'active', created_at: Date.now(), updated_at: Date.now(),
        user_id: req.userId || null   // 整改 1c：打归属
      };
      const op = igde.opening();
      act.messages.push({ role: 'assistant', content: op.reply, ts: Date.now() });
      // 注入防御：preset.audience 是不可信输入 —— 收口（去控制符/折叠空白/限长），
      // 疑似注入话术（忽略指令/角色切换/索要系统提示词）直接忽略该预选，走正常开场。
      if (body.preset && typeof body.preset.audience === 'string' && body.preset.audience.trim()) {
        const presetAud = igdeMod.clampNeedValue(body.preset.audience);
        if (presetAud && !igdeMod.looksLikeInjection(presetAud)) {
          igde.applyNeeds(act, { audience: presetAud });
          act.stage = 'S1';
          act.messages.push({ role: 'assistant', content: `收到，这次针对【${act.needs.audience}】。还想知道：他们为啥快丢、你希望他们回来干啥、想给什么钩子？`, ts: Date.now() });
        }
      }
      store.upsertAct(act);
      return sendJson(res, 200, { act });
    }

    // —— 新流失主动提醒（环节⑥：监控新弃购/高意向，主动冒给 agent；整改 1c：按当前用户 drafts 判定已覆盖）——
    if (pathname === '/api/opportunities' && method === 'GET') {
      const aud = store.getAudience();
      const high = aud.filter(a => (a.score || 0) >= 0.7);
      const sent = store.getDraftsByUser(req.userId).filter(d => ['sent', 'recovering'].includes(d.status));
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
      if (!act) return sendJson(res, 404, { error: 'act not found' });
      if (act.user_id && act.user_id !== req.userId) return sendJson(res, 404, { error: 'act not found' });
      const body = await readBody(req);
      igde.aiEnabled = !!config.aiKey; // 动态：配了 key 走真模型，否则桩
      syncAgentConfig();
      // 邮件语种 = 店铺默认语种（收件人逐人本地化在发送环节 renderForRecipient 做）
      const r = await igde.handle(act, (body.message || '').toString().slice(0, 2000), {
        locale: config.shopDefaultLocale || 'en',
        agentProfile: store.getAgentProfile(req.userId)
      });
      store.upsertAct(act);
      persistAgentProfile(r, req.userId);
      consumeAgentMeta(r);
      if (r.guardrailHits && r.guardrailHits.length) {
        r.guardrailHits.forEach(h => metricsInc('guardrail_' + h));
        logEvent('guardrail', { hits: r.guardrailHits });
      }
      return sendJson(res, 200, r);
    }

    // —— 对话消息（SSE 交付 · 真流式）：头先写，IGDE 处理过程中逐 token 推帧；
    //    未流出 token（桩模式 / 边界拒绝 / 护栏重生成）时保留 3 字打字机兜底；
    //    护栏替换了乐观流出的预览时发 replace 校正帧；done 帧的 result 永远是权威结果。
    //    失败（error 帧）由前端降级一次性 /message —— handle 抛错时未落库，重发安全。
    const sm2 = pathname.match(/^\/api\/act\/([\w-]+)\/message\/stream$/);
    if (sm2 && method === 'POST') {
      const act = store.getAct(sm2[1]);
      if (!act) return sendJson(res, 404, { error: 'act not found' });
      if (act.user_id && act.user_id !== req.userId) return sendJson(res, 404, { error: 'act not found' });
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
      let streamed = '';      // 已乐观流出的 reply 增量累计
      const onReplyToken = (piece) => { streamed += piece; send({ type: 'token', value: piece }); };
      let result;
      try {
        result = await igde.handle(act, (body.message || '').toString().slice(0, 2000), {
          locale: config.shopDefaultLocale || 'en',
          agentProfile: store.getAgentProfile(req.userId),
          onReplyToken
        });
      } catch (e) {
        send({ type: 'error', error: String(e && e.message || e) });
        res.end();
        return;
      }
      store.upsertAct(act);
      persistAgentProfile(result, req.userId);
      consumeAgentMeta(result);
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
      send({ type: 'done', result });
      res.end();
      return;
    }

    // —— 生成草稿（从方案卡）：× 消费者标签分布 → 变体；检索套路卡/基准注入参考 ——
    if (pathname === '/api/draft' && method === 'POST') {
      const body = await readBody(req);
      const card = body.planCard;
      if (!card) return sendJson(res, 400, { error: 'missing planCard' });
      // 预估可挽回 GMV + 受众圈选条件（确认卡展示）
      const matched = matchAudienceByDesc(card.audience);
      const estGmv = +matched.reduce((s, a) => s + (a.estGmv || 0), 0).toFixed(2);
      const conditions = audienceConditions(card.audience);
      // ⑥ 竞品套路卡检索（G6：只出结构卡，raw_email 绝不外发）+ 基准库 Top-3
      const refCards = competitorsMod.topCards(store, req.userId, { audience: card.audience, discount: card.discount, k: 3 });
      const benchLib = benchmarkMod.getBenchmark(store);
      const benchHits = benchmarkMod.queryBenchmark(benchLib, { audience: card.audience, discount: card.discount, k: 3 });
      // ④ 变体生成：需求（act.needs）× 标签分布 → 一次调用出三档；AI 离线全落标准三档
      const act = body.actId ? store.getAct(body.actId) : null;
      const needs = (act && act.needs) || {};
      const tagDist = tagsMod.tagDistribution(store, matched);
      const draftFacts = {
        brand: config.shopBrand || 'CartBack',
        // 折扣数值唯一出处 = 方案卡 discountNum（% off）；文本「8 折」等已在 producePlanCard 换算
        discount: Number(card.discountNum) || parseFloat(card.discount) || 10,
        coupon: card.coupon,
        product: card.product || '', offer: card.offer || ''
      };
      const llmJSON = config.aiKey ? async (messages) => {
        const r = await breakers.get('llm').exec(() => makeLlmClient().chatStructured({ messages, maxTokens: 2048 }));
        return { reply: r.reply, needs: r.needs, jsonOk: r.jsonOk, raw: r.raw };
      } : null;
      const strategyHints = refCards.map(c => ({ theme_formula: c.theme_formula, angle: c.angle, discount_range: c.discount_range, timing: c.timing }));
      const v = await variantsMod.generateVariants({ draft: draftFacts, needs, llmJSON, strategyHints, tagDist });
      if (v.warning) logEvent('variants_fallback', { warning: v.warning });
      metricsInc(v.provider === 'llm' ? 'variants_llm' : 'variants_standard');
      const draft = {
        id: uid('dr_'), act_id: body.actId || null,
        subject: card.subject, body: card.body, audience: card.audience,
        // 数值口径（% off）：变体/逐收件人渲染统一读数值；「给什么钩子」的展示文案在 planCard.discount
        discount: Number(card.discountNum) || parseFloat(card.discount) || 10,
        coupon: card.coupon, posters: card.posters,
        estGmv, matchedCount: matched.length, sendTiming: card.sendTiming || null,
        tag_distribution: tagDist,   // 圈中受众的标签分布快照（邮件卡展示产品分类/年龄段/机型代表值）
        status: 'draft', created_at: Date.now(), sent_at: null, esp_message_id: null, cost: 0,
        user_id: req.userId || null,
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
        // image_path 为空（万相失败/未配）时留空，EditModal 据此不渲染碎图；
        // html 由 email-builder 兜底始终非空，无需 FALLBACK 占位。
        draft.image_path = draft.image_path || '';
        store.upsertDraft(draft);
      } catch (err) {
        draft.html = 'ERROR: ' + (err.message || err);
        draft.image_path = '';
        store.upsertDraft(draft);
      }

      // 海报已下线（前端不再展示，改展示主图）——不再入队生成，省 LLM/万相算力。
      // /api/posters 路由与 posters 队列 handler 暂留为死代码，待后续整体清理 posters.js。

      return sendJson(res, 200, {
        draft, estGmv, matchedCount: matched.length,
        audience_conditions: conditions,
        tag_distribution: tagDist,
        references: {
          strategy_cards: refCards.map(c => ({ id: c.id, competitor_name: c.competitor_name, theme_formula: c.theme_formula, angle: c.angle })),
          strategy_cards_count: refCards.length,
          benchmark: benchHits
        },
        variants_provider: v.provider
      });
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
      const items = drafts.map(d => ({ ...d, progressSeg: segMap[d.status] || [1,0,0], locale: d.locale || config.shopDefaultLocale || 'en' }));
      return sendJson(res, 200, { drafts: items, stats });
    }

    // —— 发送（PRD §0.6：改 202 入队；预检 + 频控 + 幂等键 send:{userId}:{draftId}）——
    const sm = pathname.match(/^\/api\/draft\/([\w-]+)\/send$/);
    if (sm && method === 'POST') {
      const draft = store.getDraft(sm[1]);
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      if (draft.user_id && req.userId && draft.user_id !== req.userId) return sendJson(res, 404, { error: 'draft not found' });
      // 状态检查前置：已发送/发送中的草稿不接受编辑落库（避免 409 前把编辑内容写进已发出的邮件）
      if (['sent', 'sending', 'queued'].includes(draft.status)) {
        return sendJson(res, 409, { error: '该邮件已发送或正在发送，请勿重复操作' });
      }
      // 前端邮件页编辑：发送前把最新主题/正文落库（P0-1：避免「界面显示新内容、实际发出旧内容」）
      try {
        const body = await readBody(req);
        if (body && typeof body.subject === 'string' && body.subject.trim()) draft.subject = body.subject.trim();
        if (body && typeof body.body === 'string' && body.body.trim()) draft.body = body.body.trim();
        store.upsertDraft(draft);
      } catch (e) { /* 无 body 或非 JSON：维持存储原稿 */ }
      // ③ 发送前预检：ESP 配置 / 发件域名 / 收件人有效性 / 72h 频控，失败分类人话提示
      const check = precheckSend(draft);
      if (!check.ok) {
        const first = check.problems.find(p => !['quota_warning', 'domain_mismatch'].includes(p.type));
        logEvent('send_precheck_fail', { draft_id: draft.id, problems: check.problems });
        return sendJson(res, 400, { error: first ? first.human : '发送预检未通过', problems: check.problems });
      }
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
      logEvent('send_queued', { draft_id: draft.id, job_id: job.id, deduped, sendable: check.sendable, skipped_by_frequency: check.skippedByFrequency });
      return sendJson(res, 202, {
        job_id: job.id, queued: true, deduped,
        check: { recipients: check.recipients, skippedByFrequency: check.skippedByFrequency, sendable: check.sendable, warnings: check.problems.filter(p => ['quota_warning', 'domain_mismatch'].includes(p.type)) },
        draft
      });
    }

    // —— 受众 ——
    if (pathname === '/api/audience' && method === 'GET') {
      return sendJson(res, 200, { audience: store.getAudience() });
    }
    if (pathname === '/api/audience/import' && method === 'POST') {
      const body = await readBody(req);
      const list = parseCsv(body.csv || '');
      if (!list.length) return sendJson(res, 400, { error: '未解析到有效邮箱' });
      store.addAudience(list);
      tagsMod.scoreAudience(store, list);   // ① 同步时打分（source=scoring；manual 不被覆盖）
      return sendJson(res, 200, { imported: list.length, audience: store.getAudience() });
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
      store.addAudience(list);
      tagsMod.scoreAudience(store, list);   // ① 店铺事件同步打分
      logEvent('store_sync', { imported: list.length });
      return sendJson(res, 200, { imported: list.length, audience: store.getAudience().length });
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

    // —— 拉取：从已配置店后台读取【用户信息 + 行为】并写入受众（替换种子）——
    if (pathname === '/api/store/pull' && method === 'POST') {
      if (!connectors) return sendJson(res, 400, { configured: false, error: '未接入任何店后台；请在 config.json 配置 shopify 或 stores' });
      const recipients = await connectors.listCustomers({}).catch(e => { throw new Error('拉取用户失败: ' + e.message); });
      const events = await connectors.listBehaviorEvents({}).catch(() => []);
      const audience = recipients.map(r => recipientToAudience(r, events));
      store.replaceAudience(audience);
      tagsMod.scoreAudience(store, audience);   // ① 拉取同步时打分（PRD §0.3：同步时 scoring）
      // 行为事件落库（供后续归因/KPI）
      for (const e of events) store.addEvent({ type: e.type, audience_id: (audience.find(a => a.email === e.email) || {}).id || null, value: e.value, ts: e.ts });
      logEvent('store_pull', { recipients: audience.length, events: events.length });
      return sendJson(res, 200, { pulled: audience.length, events: events.length, recipients: audience.slice(0, 20), configured: true });
    }

    // —— 配置（密钥只存服务端 .server，绝不回传） ——
    if (pathname === '/api/config' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.mode === 'string') config.mode = body.mode === 'real' ? 'real' : 'demo';
      if (typeof body.aiKey === 'string') config.aiKey = body.aiKey.trim();
      if (typeof body.espKey === 'string') config.espKey = body.espKey.trim();
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
        store.addEvent({ type: mapped, draft_id: draftId, audience_id: audienceId, value: body.value || 0, esp_id: data.message_id || null });
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
        if (!codes.length) return sendJson(res, 200, { ok: true, ignored: 'no discount codes' });
        const drafts = store.getDrafts();
        const hitDraft = drafts.find(d => d.coupon && codes.includes(String(d.coupon).toLowerCase()));
        if (!hitDraft) return sendJson(res, 200, { ok: true, ignored: 'code not ours' });
        if (orderId && store.findEventByOrderId(orderId)) {
          return sendJson(res, 200, { ok: true, deduped: true });   // 同单只归因一次
        }
        const aud = resolveAudienceByEmail(order.email);
        const value = parseFloat(order.total_price) || 0;
        store.addEvent({ type: 'convert', draft_id: hitDraft.id, audience_id: (aud || {}).id || null, value, order_id: orderId || null });
        if (aud) tagsMod.weightForConversion(store, aud.id);   // ⑤ 标签加权：convert → w += 2
        benchmarkMod.rebuildBenchmark(store);
        metricsInc('attr_convert');
        logEvent('attribution', { source: 'shopify', type: 'convert', draft_id: hitDraft.id, order_id: orderId, value, audience_id: (aud || {}).id || null });
        return sendJson(res, 200, { ok: true, attributed: true });
      }

      // —— C. 旧版简易格式（兼容演示模式/既有测试）——
      let draftId = body.draft_id || (body.data && body.data.draft_id);
      const type = ['open', 'click', 'convert', 'delivered', 'bounced'].includes(body.type) ? body.type
        : (body.event === 'open' ? 'open' : body.event === 'click' ? 'click' : body.event === 'convert' ? 'convert' : 'open');
      // 优惠码核销归因：按 coupon 反查 draft（订单回传）
      if (!draftId && body.coupon) {
        const d = store.getDrafts().find(x => x.coupon === body.coupon);
        if (d) draftId = d.id;
      }
      if (type === 'convert' && body.order_id && store.findEventByOrderId(String(body.order_id))) {
        return sendJson(res, 200, { ok: true, deduped: true });
      }
      const ev = store.addEvent({ type, draft_id: draftId, audience_id: body.audience_id || null, value: body.value || 0, order_id: body.order_id ? String(body.order_id) : null });
      if (type === 'convert' && body.audience_id) tagsMod.weightForConversion(store, body.audience_id);
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

    // —— 导出（整改 1c：只导当前用户 acts/drafts，防泄露他人；audience/events 店铺级共享含店铺数据）——
    if (pathname === '/api/export' && method === 'GET') {
      return sendJson(res, 200, {
        acts: store.getActsByUser(req.userId), drafts: store.getDraftsByUser(req.userId),
        audience: store.getAudience(), events: store.getEvents(), kpis: store.getKpis(config.mode, req.userId)
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

    // 异步任务轮询（前端 202 入队后查进度）
    const jm = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (jm && method === 'GET') {
      const job = store.getJob(jm[1]);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
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
      if (!draft) return sendJson(res, 404, { error: 'draft not found' });
      const { job } = queue.enqueue({ type: 'posters', payload: { draftId: draft.id, regenerate: Boolean(body.regenerate) }, dedupeKey: 'posters:' + draft.id + ':' + (body.regenerate ? Date.now() : 'base') });
      return sendJson(res, 202, { job_id: job.id, queued: true });
    }

    // 受众圈选条件预览（确认卡展示：条件 + 命中人数 + 预估 GMV）
    if (pathname === '/api/audience/preview' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, audienceConditions(String(body.audience || '').slice(0, 200)));
    }

    // 消费者标签读取 / 手动维护（manual 来源不被 scoring/attribution 覆盖）
    const tm = pathname.match(/^\/api\/audience\/([\w-]+)\/tags$/);
    if (tm && method === 'GET') {
      return sendJson(res, 200, { audience_id: tm[1], tags: store.getAudienceTags(tm[1]) });
    }
    if (tm && method === 'PUT') {
      const body = await readBody(req);
      const aud = store.getAudience().find(a => a.id === tm[1]);
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

    // 标签效果聚合（数据页「标签效果」区块：Top5 + 样本数）
    if (pathname === '/api/tags/effect' && method === 'GET') {
      return sendJson(res, 200, { effect: tagsMod.tagEffect(store, { minSample: 1 }).slice(0, 10) });
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
      if (draft.user_id && req.userId && draft.user_id !== req.userId) return sendJson(res, 404, { error: 'draft not found' });
      const recipients = resolveRecipients(draft).filter(r => r.email_status !== 'email_invalid');
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
        audience_conditions: draft.audience_conditions || audienceConditions(draft.audience),
        tiers,                                   // 「按人群预览」：每档一条样例（{{}} 已按样例收件人展开）
        languages: render.languageDistribution(recipients),   // 「语言预览」：分布
        g0_blocked: draft.g0_blocked || [],      // 被拦截邮件（标红 + 原因）
        stats: rendered.stats
      });
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
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' }[ext] || 'image/png';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    return sendJson(res, 404, { error: 'route not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
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
});
