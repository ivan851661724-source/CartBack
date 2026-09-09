'use strict';
/**
 * lib/variants.js — 标签驱动的三档变体生成（PRD §4.1 / 功能③输入）
 *
 * 裁决逻辑：qwen3.7-plus 一次调用出 variants[3]（{tier, subject, body}），只换角度不换事实；
 * AI 离线 / 输出非法 → 全落本地标准三档（fail-closed 到确定性文案，绝不阻塞发送）。
 * 模板占位符（{{name}}/{{coupon}}…）在变体内合法，发送时由 render.js 本地展开。
 */

const { TIERS } = require('./render');

/** 变体形态校验：3 条、tier 合法（缺失用 standard 补）、subject/body 非空字符串 */
function validateVariants(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const tier = TIERS.includes(v.tier) ? v.tier : 'standard';
    const subject = typeof v.subject === 'string' ? v.subject.trim() : '';
    const body = typeof v.body === 'string' ? v.body.trim() : '';
    if (!subject || !body) continue;
    out.push({ tier, subject, body });
  }
  // 同 tier 取第一条
  const seen = new Set();
  const uniq = out.filter(v => (seen.has(v.tier) ? false : (seen.add(v.tier), true)));
  return uniq.length ? uniq : null;
}

/** 补齐缺失档位（以标准档为底，保证三档全量——「变体失败全落标准变体」） */
function completeTiers(variants, standardBase) {
  const out = [];
  for (const tier of TIERS) {
    const hit = (variants || []).find(v => v.tier === tier);
    out.push(hit || { tier, subject: standardBase.subject, body: standardBase.body });
  }
  return out;
}

/** 本地标准三档（确定性、零 LLM）：AI 离线降级 + LLM 输出的缺档补底 */
function standardVariants(draft = {}) {
  const brand = draft.brand || 'CartBack';
  const discountNum = Number(draft.discount) || 10;
  const discount = Number.isInteger(discountNum) ? String(discountNum) : String(+discountNum.toFixed(1)); // "12.0"→"12"
  const coupon = draft.coupon || '';
  const product = draft.product || 'your cart';
  const couponLine = coupon ? `Use code ${coupon} at checkout` : 'Your discount is applied automatically at checkout';
  return [
    {
      tier: 'discount',
      subject: `${discount}% OFF waiting for you — {{name}}, don't pay full price`,
      body: `Hi {{name}},\n\nThe items in your ${product} at ${brand} are still reserved — and we'd rather you have them for less.\n\n` +
        `${discount}% OFF is yours: ${couponLine}.\n\n{{#if coupon}}Code: {{coupon}}\n{{/if}}Back to your cart and lock in the savings.`
    },
    {
      tier: 'urgency',
      subject: '{{name}}, your cart is about to expire',
      body: `Hi {{name}},\n\nQuick heads-up: your ${product} at ${brand} won't stay reserved much longer.\n\n` +
        `Stock is limited and your cart is the only thing holding your items.\n\n{{#if coupon}}Code {{coupon}} works if you check out today.\n{{/if}}Finish checkout before it's gone.`
    },
    {
      tier: 'standard',
      subject: 'You left something behind at ' + brand,
      body: `Hi {{name}},\n\nYour ${product} is still saved at ${brand} — whenever you're ready.\n\n` +
        `${couponLine}.\n\n{{#if coupon}}Your code: {{coupon}}\n{{/if}}Pick up right where you left off.`
    }
  ];
}

/** 标签分布 → 一句话画像（供 system 注入；空分布返回空串，标准三档不受影响） */
function tagMixSummary(tagDist = []) {
  const list = (Array.isArray(tagDist) ? tagDist : []).slice(0, 6);
  if (!list.length) return '';
  return list.map(d => `${d.tag_type}=${d.tag_value}×${d.count}(均权${d.avg_weight})`).join('、');
}

/**
 * LLM 生成三档变体（一次调用）。llmJSON(messages) → {reply, jsonOk, raw} 由 server 注入
 * （chatStructured 封装）；本函数只关心其返回 JSON 的 variants 字段。
 * strategyHints：竞品套路卡（⑥ 检索注入，只注入结构线索，不注入原文——G6）。
 * tagDist：受众实时标签分布（tags.tagDistribution），生成端据此倾斜三档措辞权重；
 *          空/离线时退化为纯 needs 驱动（标准三档兜底不变）。
 * @returns {{variants, provider: 'llm'|'fallback_standard', warning?: string}}
 */
async function generateVariants({ draft = {}, needs = {}, llmJSON = null, strategyHints = [], tagDist = [] }) {
  const base = standardVariants(draft);
  if (!llmJSON) return { variants: base, provider: 'fallback_standard', warning: 'AI 未配置，使用标准三档' };
  const mix = tagMixSummary(tagDist);
  const system =
    '你是跨境电商挽回邮件的文案变体生成器。基于给定【事实】，为三类人群各生成一封邮件变体，返回 JSON。' +
    '铁律：只换角度不换事实——折扣力度、优惠码、品牌名、商品等事实必须与输入一致，禁止编造新事实、禁止夸大。' +
    '面向消费者的邮件必须是英文（或跟随店铺语种），禁止中文。允许使用模板占位符 {{name}}、{{coupon}}、{{brand}}、{{product}} 与单层 {{#if coupon}}…{{/if}}。' +
    '三档：discount=价格敏感人群（折扣主打，优惠码前置）；urgency=高意向人群（紧迫感为主、弱化折扣）；standard=其余人群（中性提醒）。' +
    (mix ? '本次受众的实时标签分布：【' + mix + '】。三档的措辞权重跟着分布倾斜（如 price_sensitivity=high 占比高 → discount 档优惠信息更前置、urgency 档强调库存稀缺但保留事实），铁律不变。' +
      'style_preference 是风格品类（tech/fashion/business/outdoor），据此选内容角度：tech→性能与参数、fashion→款式与搭配、business→效率与专业、outdoor→耐用与探索；只影响举例和措辞角度，不新增事实。' : '') +
    '只返回一个 JSON 对象：{"variants":[{"tier":"discount","subject":"…","body":"…"},{"tier":"urgency",…},{"tier":"standard",…}]}，不要 markdown 代码块。';
  const facts = {
    brand: draft.brand || '', discount: draft.discount || '', coupon: draft.coupon || '',
    product: draft.product || draft.audience || '', pain: needs.pain || '', goal: needs.goal || '',
    audience: needs.audience || '', offer: needs.offer || draft.offer || ''
  };
  const user = '【事实】' + JSON.stringify(facts) + '\n【基准模板（可在此基础上改写角度）】' +
    JSON.stringify(base.map(v => ({ tier: v.tier, subject: v.subject, body: v.body }))) +
    (mix ? '\n【受众标签分布（audience_tags 实时打分，只影响措辞角度）】' + JSON.stringify((tagDist || []).slice(0, 8)) : '') +
    (strategyHints && strategyHints.length
      ? '\n【已验证打法参考（同类竞品策略卡结构线索，仅借鉴角度，禁止照抄任何文案）】' + JSON.stringify(strategyHints)
      : '');
  try {
    const r = await llmJSON([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    let parsed = null;
    if (r && r.jsonOk && r.needs && typeof r.needs.variants !== 'undefined') {
      parsed = r.needs.variants; // chatStructured 会把未知 JSON 键并进 needs 的情况（容错）
    }
    if (!parsed && r && typeof r.reply === 'string') {
      try { parsed = JSON.parse(r.reply).variants; } catch (e) { parsed = null; }
    }
    if (!parsed && r && r.raw && r.raw.choices && r.raw.choices[0]) {
      try { parsed = JSON.parse(r.raw.choices[0].message.content).variants; } catch (e) { parsed = null; }
    }
    const valid = validateVariants(parsed);
    if (valid) return { variants: completeTiers(valid, base[2]), provider: 'llm' };
    return { variants: base, provider: 'fallback_standard', warning: 'LLM 变体输出不合格，全落标准三档' };
  } catch (e) {
    return { variants: base, provider: 'fallback_standard', warning: 'LLM 调用失败，全落标准三档: ' + String(e && e.message || e) };
  }
}

module.exports = { validateVariants, completeTiers, standardVariants, tagMixSummary, generateVariants };
