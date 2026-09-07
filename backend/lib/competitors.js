'use strict';
/**
 * lib/competitors.js — 竞品邮件雷达（PRD §6 / 加速器）
 *
 * 链路：收集（手动粘贴 MVP → 转发制 inbound webhook）→ 预过滤（规则）→
 *       拆解（LLM 出策略卡，允许 null；降级 = 启发式）→ 检索接入③ → G6 合规。
 *
 * G6 合规（缺一不放行）：学结构不抄文案——落库前把原文压成结构卡；原文（raw_email）
 * 仅存 30 天，由 g6Purge 定时清除（保留卡片）；user_id 隔离；跨店只出匿名统计。
 */

// —— ② 预过滤（纯规则）：营销邮件 = 退订链接 AND 促销词；订单/物流通知 → 丢弃 ——
const PROMO_WORDS = /(sale|discount|% ?off|promo|coupon|code|deal|offer|free shipping|flash|新品|折扣|优惠|券|促销|折|满减|限时)/i;
const UNSUB_RE = /(unsubscribe|退订|取消订阅|opt[- ]?out|邮件列表|newsletter.*manage|manage preferences)/i;
const TRANSACTIONAL_RE = /(order (confirmed|shipped|delivered|update)|tracking number|invoice|receipt|物流|订单已|发货|签收|发票|回执)/i;

/**
 * @returns {{keep: boolean, reason: string}}
 *   keep=true  → 营销邮件，进入拆解
 *   keep=false → 丢弃（transactional / non-promo / too_short）
 */
function prefilter(rawEmail) {
  const text = String(rawEmail || '');
  if (text.length < 40) return { keep: false, reason: 'too_short' };
  if (TRANSACTIONAL_RE.test(text)) return { keep: false, reason: 'transactional' };
  if (!UNSUB_RE.test(text)) return { keep: false, reason: 'no_unsubscribe' };
  if (!PROMO_WORDS.test(text)) return { keep: false, reason: 'no_promo' };
  return { keep: true, reason: 'marketing' };
}

// —— ③ 启发式拆解降级（AI 离线时兜底；字段允许 null）——
function heuristicCard(rawEmail) {
  const text = String(rawEmail || '');
  const discountMatch = text.match(/(\d{1,2})\s?%\s?off/i) || text.match(/off\s?(\d{1,2})\s?%/i) || text.match(/(\d{1,2})折/);
  const moneyMatch = text.match(/\$\s?(\d+)/);
  const promo = /flash|24\s?h|48\s?h|today|ends|最后|限时|仅今/i.test(text);
  const countdown = /countdown|timer|ending soon|倒计时/i.test(text);
  return {
    competitor_name: null,
    theme_formula: promo ? 'promo_hook' : 'story_hook',
    angle: /new arrival|新品/.test(text) ? 'new_arrival' : 'discount_led',
    discount_range: discountMatch ? `${discountMatch[1]}%` : (moneyMatch ? `$${moneyMatch[1]}` : null),
    timing: promo ? (countdown ? 'countdown_urgency' : 'short_window') : 'regular_send',
    frequency: null,
    visual_style: null
  };
}

/**
 * LLM 拆解（qwen3.7-plus 一次调用出策略卡 JSON，允许 null 字段；失败降级启发式）。
 * llmJSON(messages) → chatStructured 结果（server 注入）。
 */
async function extractStrategyCard({ rawEmail, competitorName = '', llmJSON = null }) {
  const system =
    '你是跨境电商营销策略分析师。输入是一封竞品营销邮件原文，请只学「结构/打法」，不要复述文案。' +
    '输出策略卡 JSON（字段允许 null，禁止编造原文没有的信息）：' +
    '{"competitor_name":"品牌名（从原文识别，识别不出用传入名或 null）",' +
    '"theme_formula":"钩子公式（如 discount_urgency / story_hook / new_arrival_teaser / loyalty_reward）",' +
    '"angle":"主角度（如 discount_led / scarcity / free_shipping / vip_exclusive）",' +
    '"discount_range":"折扣力度区间（如 10-20% / $10 off / null）",' +
    '"timing":"发送时机线索（如 countdown_urgency / weekend_sale / null）",' +
    '"frequency":"频率线索（如 weekly / null）",' +
    '"visual_style":"视觉风格关键词（如 bold_red_cta / minimal / null）"}。' +
    '只返回一个 JSON 对象，不要 markdown 代码块、不要解释。';
  const user = (competitorName ? '【竞品名】' + competitorName + '\n' : '') + '【邮件原文】\n' + String(rawEmail || '').slice(0, 6000);
  const heuristicWith = () => ({ ...heuristicCard(rawEmail), competitor_name: competitorName || null });
  if (!llmJSON) return { card: heuristicWith(), provider: 'heuristic' };
  try {
    const r = await llmJSON([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    let parsed = null;
    const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    if (r && r.raw && r.raw.choices && r.raw.choices[0]) parsed = tryParse(r.raw.choices[0].message.content);
    if (!parsed && r && typeof r.reply === 'string') parsed = tryParse(r.reply);
    if (parsed && typeof parsed === 'object' && (parsed.theme_formula || parsed.angle)) {
      return { card: { ...heuristicWith(), ...parsed, competitor_name: parsed.competitor_name || competitorName || null }, provider: 'llm' };
    }
    return { card: heuristicWith(), provider: 'heuristic', warning: 'LLM 拆解输出不合格，降级启发式' };
  } catch (e) {
    return { card: heuristicWith(), provider: 'heuristic', warning: 'LLM 拆解失败，降级启发式: ' + String(e && e.message || e) };
  }
}

// —— ④ 检索接入③：关键词重叠打分 Top-K（量小够用；embedding 检索为 P2）——
function cardKeywords(card) {
  return [card.theme_formula, card.angle, card.timing, card.discount_range]
    .filter(Boolean).map(s => String(s).toLowerCase());
}

function topCards(store, userId, { audience = '', discount = 0, k = 3 } = {}) {
  const { categoryOf, discountTier } = require('./benchmark');
  const wantTier = discountTier(discount);
  const tokens = String(audience || '').split(/\s+/).map(s => s.toLowerCase()).filter(Boolean);
  const descLower = String(audience || '').toLowerCase();
  return store.listStrategyCards(userId)
    .map(c => {
      const kws = cardKeywords(c);
      let score = 0;
      for (const kw of kws) {
        // 拉丁 token 级匹配 + 原串子串回退（中文受众描述没有空白分词）
        if (tokens.some(t => t && (kw.includes(t) || t.includes(kw)))) score++;
        else if (descLower.length >= 2 && (kw.includes(descLower) || descLower.includes(kw))) score++;
      }
      if (c.discount_range && /^\d+/.test(c.discount_range)) {
        const m = Number((c.discount_range.match(/^(\d+)/) || [])[1] || 0);
        if (m && discountTier(m) === wantTier) score += 1;
      }
      return { card: c, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(x => x.card);
}

/** 收集地址（转发制，依赖公网部署）：scan+{uid}@域名；域名取已验证发件域名 espFrom */
function collectionAddress(userId, espFrom = '') {
  const domain = (espFrom || '').split('@')[1] || 'inbound.cartback.demo';
  const short = String(userId || 'anon').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'anon';
  return `scan+${short}@${domain}`;
}

/**
 * G6：清除过期原文（30 天，保留卡片）。由定时 job（queue handler 'g6_purge'）周期调用。
 * @returns {{purged: number}}
 */
function g6Purge(store, maxAgeMs = 30 * 86400000) {
  return { purged: store.purgeExpiredRawEmails(maxAgeMs) };
}

module.exports = {
  PROMO_WORDS, UNSUB_RE, TRANSACTIONAL_RE,
  prefilter, heuristicCard, extractStrategyCard,
  cardKeywords, topCards, collectionAddress, g6Purge
};
