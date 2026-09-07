'use strict';
/**
 * lib/render.js — 个性化渲染管线（PRD §0.2 产品心脏 / §4 功能④）
 *
 * 固定顺序不可变：
 *   收件人切片(locale/tags) → 变体选择(按标签) → 语种渲染(en直出/非en翻译缓存)
 *   → 模板本地展开({{name}}/{{offer}}/单层if，零 LLM) → G0 正则拦截(含白名单) → 发送
 *
 * 裁决逻辑：LLM 只负责生成「模板/变体」（O(变体数)），发送时按收件人属性本地展开（零 LLM）
 * ——成本可控、输出稳定。不引第三方模板引擎（Liquid 等），极简占位符 + 单层 if 够用即止。
 *
 * 本模块零网络依赖：翻译/变体生成以注入函数传入，便于单测与降级。
 */

// —— 语种回落链：customer.locale → country 映射 → en（PRD §4.2）——
const COUNTRY_LOCALE = {
  CN: 'zh', TW: 'zh', HK: 'zh',
  US: 'en', GB: 'en', AU: 'en', CA: 'en',
  FR: 'fr', DE: 'de', ES: 'es', IT: 'it', PT: 'pt', BR: 'pt',
  JP: 'ja', KR: 'ko', RU: 'ru', SA: 'ar', AE: 'ar', MX: 'es'
};

/** 收件人语种：locale 优先（取前 2 位主码），其次 country 映射，最后 'en' */
function resolveLocale(recipient, fallback = 'en') {
  const loc = (recipient && recipient.locale || '').trim();
  if (loc) {
    const primary = loc.toLowerCase().split(/[-_]/)[0];
    if (primary) return primary;
  }
  const country = (recipient && recipient.country || '').trim().toUpperCase();
  if (country && COUNTRY_LOCALE[country]) return COUNTRY_LOCALE[country];
  return fallback || 'en';
}

// —— 变体分档（硬编码三档，PRD §4.1）——
// price_sensitivity=high → 折扣主打；intent=hot → 紧迫（弱折扣）；其余 → 标准
const TIERS = ['discount', 'urgency', 'standard'];

/**
 * 按收件人标签选变体 tier。标签取 audience_tags（[{tag_type, tag_value, weight}]），
 * 无标签时按 audience 的 intent/risk 字段近似映射（种子/导入数据）。
 */
function tierOf(recipient, tags = []) {
  const byType = {};
  for (const t of tags || []) {
    if (!byType[t.tag_type] || (t.weight || 0) > (byType[t.tag_type].weight || 0)) byType[t.tag_type] = t;
  }
  const price = byType.price_sensitivity && byType.price_sensitivity.tag_value;
  if (price === 'high') return 'discount';
  const intent = byType.intent && byType.intent.tag_value;
  if (intent === 'hot') return 'urgency';
  // 兜底：老字段近似（audience.risk 高 ≈ hot；price 高 ≈ 折扣敏感）
  if (!Object.keys(byType).length) {
    if ((recipient && recipient.price) === '高' || (recipient && recipient.price) === 'high') return 'discount';
    if ((recipient && recipient.risk) === '高' || (recipient && recipient.risk) === 'high') return 'urgency';
  } else if (intent === 'hot' || price === 'mid') {
    // 已有标签但未命中 high/hot → standard
    return 'standard';
  }
  return 'standard';
}

function pickVariant(recipient, variants, tags) {
  const tier = tierOf(recipient, tags);
  const hit = (variants || []).find(v => v.tier === tier);
  return {
    tier,
    variant: hit || (variants || []).find(v => v.tier === 'standard') || (variants || [])[0] || null
  };
}

// —— 模板本地展开（零 LLM）：{{var}} + 单层 {{#if var}}...{{/if}} ——
const TEMPLATE_VARS = ['name', 'product', 'offer', 'coupon', 'discount', 'brand'];

/**
 * 收件人称呼的语种安全化（G0 配套规则）：
 * 非中文语种邮件里出现中文姓名必然被 G0 拦截——此类收件人改用邮箱前缀称呼；
 * 中文语种（zh*）收件人保留原姓名。
 */
function safeName(recipient, locale = 'en') {
  const raw = (recipient && recipient.name) || (recipient && recipient.email ? String(recipient.email).split('@')[0] : '') || 'there';
  if (/^zh/.test(locale)) return raw;
  if (/[\u4e00-\u9fff]/.test(raw)) {
    const local = recipient && recipient.email ? String(recipient.email).split('@')[0] : '';
    if (local && !/[\u4e00-\u9fff]/.test(local)) return local;
    return 'there';
  }
  return raw;
}

/** 组装展开上下文：收件人属性 × 草稿事实（PRD §4.3） */
function buildContext(recipient, draft = {}) {
  return {
    name: (recipient && recipient.name) || (recipient && recipient.email ? recipient.email.split('@')[0] : '') || 'there',
    product: draft.product || draft.audience || 'your cart items',
    offer: draft.offer || (draft.discount ? `${draft.discount}% OFF` : ''),
    coupon: draft.coupon || '',
    discount: draft.discount || '',
    brand: draft.brand || 'CartBack'
  };
}

function expandTemplate(text, ctx) {
  if (!text) return '';
  let out = String(text);
  // 单层 if：{{#if field}}inner{{/if}} —— field 真值才保留 inner；不支持嵌套（够用即止）
  out = out.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (m, field, inner) => {
    if (!Object.prototype.hasOwnProperty.call(ctx, field)) return '';
    return ctx[field] ? inner : '';
  });
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key] == null ? '' : ctx[key]) : '';
  });
  return out;
}

// —— G0 语种拦截（PRD §4.4 / 闸门 G0）：逐封正则扫，白名单内放行 ——
const CJK_RE = /[\u4e00-\u9fff]+/g;

/**
 * 扫描一段文本。白名单（品牌名/专有名词，可含中文）先剔除再扫，命中返回 CJK 运行数组。
 * @returns {{blocked: boolean, hits: string[]}}
 */
function g0ScanText(text, whitelist = []) {
  let src = String(text || '');
  for (const term of whitelist || []) {
    if (!term) continue;
    src = src.split(String(term)).join('\u0000'); // 白名单词挖空，防其内部 CJK 误报
  }
  const hits = src.match(CJK_RE) || [];
  return { blocked: hits.length > 0, hits };
}

/**
 * 对一封邮件（主题/正文/优惠码说明）做 G0 终审。
 * @returns {{blocked: boolean, hits: string[]}} hits 形如 ["subject:你好", "body:中文"]
 */
function g0Intercept({ subject = '', body = '', couponNote = '' }, whitelist = []) {
  const hits = [];
  for (const [field, text] of [['subject', subject], ['body', body], ['coupon', couponNote]]) {
    const r = g0ScanText(text, whitelist);
    for (const h of r.hits) hits.push(`${field}:${h}`);
  }
  return { blocked: hits.length > 0, hits };
}

// —— 语种渲染：en 直出；非 en 翻译 + 同 draft 同语言缓存（PRD §4.2）——
/**
 * translateFn(text, targetLocale) → Promise<string>（server 注入 qwen-mt；测试注入桩）。
 * cache: Map，键 `d:{draftId}:{locale}:{hash}`；缓存命中零调用。
 * 翻译失败 → 回落 en 原文（G0 拦截保底，不抛错阻塞发送）。
 */
async function renderLanguage(variant, locale, { translateFn = null, cache = null, draftId = '' } = {}) {
  const subject = variant.subject || '';
  const body = variant.body || '';
  if (/^en/.test(locale) || !translateFn) {
    return { subject, body, locale: /^en/.test(locale) ? locale : 'en', translated: false };
  }
  const keyOf = (field, text) => `d:${draftId}:${locale}:${field}:${text}`;
  const translate = async (field, text) => {
    if (!text) return '';
    const key = keyOf(field, text);
    if (cache && cache.has(key)) return cache.get(key);
    try {
      const out = await translateFn(text, locale);
      const val = (out && String(out).trim()) ? String(out) : text; // 空翻译回落原文
      if (cache) cache.set(key, val);
      return val;
    } catch (e) {
      return text; // 失败回落 en（PRD：回落 en，G0 拦截保底）
    }
  };
  const [s, b] = await Promise.all([translate('subject', subject), translate('body', body)]);
  return { subject: s, body: b, locale, translated: s !== subject || b !== body };
}

// —— 收件人切片：无效地址 / bounced 剔除 / 按语种分组 ——
function sliceRecipients(recipients = []) {
  const valid = (recipients || []).filter(r =>
    r && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || '') && r.email_status !== 'email_invalid');
  const byLocale = {};
  for (const r of valid) {
    const loc = resolveLocale(r);
    (byLocale[loc] = byLocale[loc] || []).push(r);
  }
  return { valid, excluded: (recipients || []).length - valid.length, byLocale };
}

/** 语言分布（UI「语言预览」用）：[{locale, count}] 按数量降序 */
function languageDistribution(recipients = []) {
  const { valid } = sliceRecipients(recipients);
  const dist = {};
  for (const r of valid) {
    const loc = resolveLocale(r);
    dist[loc] = (dist[loc] || 0) + 1;
  }
  return Object.entries(dist)
    .map(([locale, count]) => ({ locale, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 管线编排：对一批收件人逐一产出 per-recipient 邮件（G0 拦截的不发送只标红）。
 * @param {object} o
 *   draft       { id, coupon, discount, product, offer, brand }
 *   variants    [{tier, subject, body}]（LLM 产物或本地标准三档）
 *   recipients  受众数组（可带 locale/country/email_status）
 *   tagsOf      fn(recipient) → tags（audience_tags 查询注入，默认空）
 *   whitelist   string[] G0 白名单
 *   translateFn / cache  见 renderLanguage
 * @returns {{messages, stats}} messages: [{recipient, email, subject, body, locale, tier, translated, blocked, g0Hits}]
 */
async function renderCampaign(o = {}) {
  const { draft = {}, variants = [], recipients = [] } = o;
  const tagsOf = o.tagsOf || (() => []);
  const whitelist = o.whitelist || [];
  const { valid, excluded } = sliceRecipients(recipients);

  const messages = [];
  for (const r of valid) {
    const tags = tagsOf(r) || [];
    const { tier, variant } = pickVariant(r, variants, tags);
    if (!variant) continue;
    const lang = await renderLanguage(variant, resolveLocale(r), {
      translateFn: o.translateFn, cache: o.cache, draftId: draft.id || ''
    });
    const ctx = buildContext({ ...r, name: safeName(r, lang.locale) }, draft);
    const subject = expandTemplate(lang.subject, ctx);
    const body = expandTemplate(lang.body, ctx);
    const couponNote = draft.coupon ? `${draft.coupon} ${draft.offer || ''}` : (draft.offer || '');
    const g0 = g0Intercept({ subject, body, couponNote }, whitelist);
    messages.push({
      recipient: r, email: r.email,
      subject, body, locale: lang.locale, tier,
      translated: lang.translated,
      blocked: g0.blocked, g0Hits: g0.hits
    });
  }
  return {
    messages,
    stats: {
      total: (recipients || []).length,
      renderable: messages.length,
      excluded,
      blocked: messages.filter(m => m.blocked).length,
      byTier: TIERS.reduce((acc, t) => { acc[t] = messages.filter(m => m.tier === t).length; return acc; }, {})
    }
  };
}

module.exports = {
  TIERS, COUNTRY_LOCALE, CJK_RE,
  resolveLocale, tierOf, pickVariant, safeName,
  buildContext, expandTemplate,
  g0ScanText, g0Intercept,
  renderLanguage, sliceRecipients, languageDistribution, renderCampaign
};
