'use strict';
/**
 * lib/notify.js — Wave 4 F3 主动回执：数字聚合与通知文案的唯一权威（零依赖）。
 *
 * 口径铁律：
 *  - 所有数字只算实发（sends 表是唯一口径；campaign_id 语义：批次发送 = campaign.id，单方案草稿 = draft id）；
 *  - 无 sends 支撑的通知不产数字（aggregateReceipt 无实发 → null，调用方跳过）；
 *  - 打开/点击/回流按「收件人去重」计数（同一人开/点 N 次仍算 1，与 getKpis 草稿去重口径一致）；
 *  - campaign.stats.net = Σ 订单金额 × (1 − 折扣力度%) —— 净回流 = 订单金额 − 折扣成本估算；退款单（refunded）不计。
 *
 * 本模块零依赖：store 以参数注入（只调公开读接口），文案组装确定性（不进 LLM）。
 */

/** sends 收件人 → audience 行映射（email 小写键；audience 是收件人属性的权威源） */
function audienceByEmail(store) {
  const map = new Map();
  for (const a of store.getAudience()) {
    if (a && a.email) map.set(String(a.email).toLowerCase(), a);
  }
  return map;
}

/** 实发收件人的 audience id 集合（sends 唯一口径：只统计真正发出去的人） */
function sentAudienceIds(store, scopeId) {
  const sends = store.getSends({ campaign_id: scopeId }).filter(s => s.status === 'sent');
  const byEmail = audienceByEmail(store);
  const ids = new Set();
  for (const s of sends) {
    const a = byEmail.get(String(s.recipient || '').toLowerCase());
    if (a) ids.add(a.id);
  }
  return { sends, ids };
}

function round2(n) { return +(Number(n) || 0).toFixed(2); }

/**
 * 24h 回执聚合（sends + events；scope = 批次或草稿，二选一）。
 * 返回 null = 该批次/草稿没有实发记录（不产数字、不发通知）。
 */
function aggregateReceipt(store, { campaignId, draftId, actId } = {}) {
  const scopeId = campaignId || draftId;
  if (!scopeId) return null;
  const { sends, ids } = sentAudienceIds(store, scopeId);
  if (!sends.length) return null;
  const evs = store.getEvents().filter(e => e.draft_id === scopeId && ids.has(e.audience_id));
  const opened = new Set(evs.filter(e => e.type === 'open').map(e => e.audience_id));
  const clicked = new Set(evs.filter(e => e.type === 'click').map(e => e.audience_id));
  const converts = evs.filter(e => e.type === 'convert' && !e.refunded);
  const recovered = new Set(converts.map(e => e.audience_id));
  const gmv = converts.reduce((s, e) => s + (Number(e.value) || 0), 0);
  return {
    scope_id: scopeId,
    draft_id: draftId || null,
    campaign_id: campaignId || null,
    act_id: actId || null,
    sent: sends.length,
    opened: opened.size,
    clicked: clicked.size,
    recovered: recovered.size,
    gmv: round2(gmv),
    unopened: Math.max(0, sends.length - opened.size)
  };
}

/** T+0 发送回执（一句话；数字 = 实发数） */
function buildT0Notification({ name, agg, code } = {}) {
  const n = agg || {};
  const codeText = code ? `（码 ${code}）` : '';
  return {
    type: 't0',
    title: '发送回执',
    body: `「${name}」已发出 ${n.sent || 0} 封${codeText}。24 小时后我给你汇总打开、点击和回流。`,
    draft_id: n.draft_id || null, campaign_id: n.campaign_id || null, act_id: n.act_id || null
  };
}

/** T+24h 回执汇总 + 下一步建议（打开/点击/回流 + 换主题行建议） */
function buildT24Notification({ name, agg } = {}) {
  const a = agg || {};
  let suggest;
  if (a.recovered > 0) {
    suggest = a.unopened > 0
      ? `要给没打开的 ${a.unopened} 人换主题行再打一轮吗？`
      : '这批都在回流窗口里，先不动，有新订单我再报喜。';
  } else if (a.unopened > 0) {
    suggest = `要给没打开的 ${a.unopened} 人换主题行再打一轮吗？`;
  } else {
    suggest = '打开的人还没下单，要不要换个钩子（加码 / 限时）再追一轮？';
  }
  return {
    type: 't24',
    title: '24 小时回执',
    body: `「${name}」发出 ${a.sent || 0} 封：打开 ${a.opened || 0}、点击 ${a.clicked || 0}、回流 ${a.recovered || 0} 单（$${round2(a.gmv)}）。${suggest}`,
    chips: ['再打一轮', '换主题行', '先不动'],
    draft_id: a.draft_id || null, campaign_id: a.campaign_id || null, act_id: a.act_id || null
  };
}

/** 回流报喜（conversion 到达即时生成） */
function buildRecoverNotification({ name, email, coupon, value, campaignName, draftName, agg } = {}) {
  const who = name || email || '顾客';
  const scopeText = campaignName ? `已回填到「${campaignName}」统计。`
    : (draftName ? `已回填到「${draftName}」方案。` : '');
  const a = agg || {};
  return {
    type: 'recover',
    title: '回流报喜',
    body: `顾客 ${who} 用码 ${coupon || '（原价回流）'} 回来了，订单金额 $${round2(value)}。${scopeText}`,
    chips: ['再打一轮', '先不动'],
    draft_id: a.draft_id || null, campaign_id: a.campaign_id || null, act_id: a.act_id || null
  };
}

/**
 * 批次统计（publicCampaign.stats 的数据源；打开/点击/回流按实发收件人去重）。
 * net = Σ 订单金额 × (1 − 折扣力度%)（订单金额 − 折扣成本估算；退款单不计）。
 */
function campaignStats(store, camp) {
  const { sends, ids } = sentAudienceIds(store, camp.id);
  const evs = store.getEvents().filter(e => e.draft_id === camp.id && ids.has(e.audience_id));
  const opened = new Set(evs.filter(e => e.type === 'open').map(e => e.audience_id));
  const clicked = new Set(evs.filter(e => e.type === 'click').map(e => e.audience_id));
  const converts = evs.filter(e => e.type === 'convert' && !e.refunded);
  const pct = Math.max(0, Number((camp.discount && camp.discount.percent_off) || camp.percent_off) || 0);
  const gmv = converts.reduce((s, e) => s + (Number(e.value) || 0), 0);
  const net = converts.reduce((s, e) => s + (Number(e.value) || 0) * (1 - pct / 100), 0);
  return {
    opened: opened.size,
    clicked: clicked.size,
    recovered: new Set(converts.map(e => e.audience_id)).size,
    gmv: round2(gmv),
    net: round2(net)
  };
}

/**
 * estGmv 预估 → 实际翻转数据（写回 act.plan_card.actual 供前端翻转展示）。
 * 口径：该 act 名下全部草稿 + 批次（scope id）的 convert 事件求和（退款单不计）。
 */
function actActual(store, actId) {
  if (!actId) return null;
  const draftIds = new Set(store.getDrafts().filter(d => d.act_id === actId).map(d => d.id));
  const campIds = new Set(store.getCampaignsByAct(actId).map(c => c.id));
  const converts = store.getEvents().filter(e =>
    e.type === 'convert' && !e.refunded && (draftIds.has(e.draft_id) || campIds.has(e.draft_id)));
  const gmv = converts.reduce((s, e) => s + (Number(e.value) || 0), 0);
  return { orders: converts.length, gmv: round2(gmv), currency: 'USD', source: 'actual', at: Date.now() };
}

module.exports = {
  aggregateReceipt,
  buildT0Notification,
  buildT24Notification,
  buildRecoverNotification,
  campaignStats,
  actActual
};
