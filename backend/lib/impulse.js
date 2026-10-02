'use strict';
/**
 * lib/impulse.js — Wave 5 E1 冲动折扣拦截（唯一权威；引擎短轮与测试共用）。
 *
 * 产品口径（PRD E1，P1）：
 *  - 命中即拦：offer 折扣 ≥ 阈值（% off；常态 25，大促季放宽到 40），
 *    或消息含全量触达意图（「给全部客户发」「清库存」「所有客户」）。
 *  - 拦截 ≠ 拒绝：不直接入 offer 槽，先给拦截建议（替代方案 + 理由与毛利影响一句话），
 *    chips ['换成替代方案','就要这个折扣']；用户选替代 → 替代值入 offer；坚持原意 → 照做入槽 + 审计留痕。
 *  - 大促季放宽：停发日历命中区间 ±SALE_WINDOW_DAYS 内阈值放宽到 E1_THRESHOLD_SALE，并在提示中说明。
 *
 * 本模块零网络依赖：store 注入（仅读 blackouts）；阈值一律读 lib/config 单处常量。
 */

const { E1_THRESHOLD, E1_THRESHOLD_SALE, SALE_WINDOW_DAYS } = require('./config');

// 全量触达意图（强信号整短语；「清库存」是典型冲动场景）
const MASS_RE = /(给全部客户发|全部客户都发|发给全部客户|全部客户|所有客户|发给所有客户|全部老客|清库存|清仓|全量触达|全量发)/i;

// 替代方案池（阶梯券 / 赠品 / 门槛券 限时 48h；替代 chip 缺省落第一项）
const ALTERNATIVES = [
  '阶梯券 满 59 减 10（限时 48 小时）',
  '买就送小赠品（成本可控不伤毛利）',
  '门槛券 8.5 折（限时 48 小时）'
];

/** 从原话解析折扣力度（% off 口径）：「40% off」→40；「6 折」「85 折」→ 40 / 15；无折扣 null */
function parseTextPercent(text) {
  const t = String(text || '');
  const pctM = t.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (pctM) {
    const v = parseFloat(pctM[1]);
    return v > 0 && v < 100 ? v : null;
  }
  const zheM = t.match(/(\d{1,3}(?:\.\d+)?)\s*折/);
  if (zheM) {
    const raw = parseFloat(zheM[1]);
    const zhe = raw > 10 ? raw / 10 : raw;      // 「85 折」= 8.5 折
    if (zhe <= 0 || zhe >= 10) return null;
    return +((10 - zhe) * 10).toFixed(1);
  }
  return null;
}

/**
 * 大促季判定：停发日历（blackouts）命中区间 ±days 天内视为大促季（黑五等大促前后商家本就放大折扣）。
 */
function inSaleWindow(store, { now, days } = {}) {
  const at = Number(now) || Date.now();
  const d = Number(days) > 0 ? Number(days) : SALE_WINDOW_DAYS;
  const pad = d * 86400000;
  return (store.getBlackouts() || []).some(r => {
    const from = Number(r.from) || 0;
    const to = Number(r.to) || 0;
    return at >= from - pad && at <= to + pad;
  });
}

/**
 * E1 检测（单处权威）。
 * @returns {hit, kind:'discount'|'mass', percent, offerRaw, threshold, saleRelaxed}
 *   hit=false → 本句放行（正常流水线）；hit=true → 引擎拦截（offer 不入槽，先给建议）。
 */
function detectImpulse(text, { offerRaw = '', saleWindow = false, threshold = null, saleThreshold = null } = {}) {
  const t = String(text || '');
  const mass = MASS_RE.test(t);
  const percent = parseTextPercent(t);
  const base = Number(threshold) > 0 ? Number(threshold) : E1_THRESHOLD;
  const sale = Number(saleThreshold) > 0 ? Number(saleThreshold) : E1_THRESHOLD_SALE;
  const thresholdUsed = saleWindow ? sale : base;
  const overThreshold = percent != null && percent >= thresholdUsed;
  if (!mass && !overThreshold) return { hit: false, kind: null, percent, offerRaw: offerRaw || '', threshold: thresholdUsed, saleRelaxed: saleWindow };
  return {
    hit: true,
    kind: overThreshold ? 'discount' : 'mass',
    percent,
    // insist 落槽值：优先词表抽取的 offer 原文（含单位），否则按力度合成
    offerRaw: (offerRaw && String(offerRaw).trim()) || (percent != null ? `${percent}% off` : ''),
    threshold: thresholdUsed,
    saleRelaxed: Boolean(saleWindow)
  };
}

/** 拦截建议话术（替代方案 + 理由与毛利影响一句话 + 大促放宽说明）；确定性组装，不进 LLM。 */
function composeIntercept(det) {
  const d = det || {};
  const pct = Number(d.percent) || 0;
  const reason = d.kind === 'discount'
    ? `${pct}% off 会把毛利直接打穿（每单让利 ${pct}%），且大折扣捞回来的多半是本来就会买的人，等于自降客单买必然单。`
    : '全量触达会把刚买过的人和未购人群一起打扰，退订率涨、域名信誉掉，回头生意更难做。';
  const saleNote = d.saleRelaxed
    ? `已按大促季口径把线放宽到 ${d.threshold}%，这个力度仍超线。`
    : '';
  const alts = ALTERNATIVES.map((a, i) => `${'①②③'[i]} ${a}`).join('；');
  return `先等等——${reason}${saleNote}给你三个更稳的替代：${alts}。选哪个？也可以坚持原方案。`;
}

/** 决议：用户点名某个替代（赠品/门槛/阶梯）→ 对应项；只说「换成替代方案」→ 缺省第一项。 */
function pickAlternative(text) {
  const t = String(text || '');
  if (/赠品|小样|送礼/.test(t)) return ALTERNATIVES[1];
  if (/门槛/.test(t)) return ALTERNATIVES[2];
  return ALTERNATIVES[0];
}

/** 决议短语（ insist 先判：坚持原折扣优先于替代） */
const INSIST_RE = /(就要这个折扣|就要.{0,8}(折|折扣|力度)|坚持|不改了?|就这个|照这个|原折扣|还是\s*\d{1,2}\s*%|就这么定)/i;
const ALTERNATIVE_RE = /(换成替代|用替代|替代方案|就要替代|要替代|用阶梯|阶梯券|满.{0,4}减|赠品|门槛券?|用门槛)/i;
const DENY_RE = /(先不|算了|不要了|不搞了|取消|再想想|暂不)/i;

module.exports = {
  MASS_RE,
  ALTERNATIVES,
  INSIST_RE,
  ALTERNATIVE_RE,
  DENY_RE,
  parseTextPercent,
  inSaleWindow,
  detectImpulse,
  composeIntercept,
  pickAlternative
};
