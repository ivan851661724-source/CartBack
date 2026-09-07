'use strict';
/**
 * lib/tags.js — 消费者标签服务（PRD §0.5 audience_tags / §1 打分 / §5 标签反哺）
 *
 * 铁律 1：标签只有三个来源 scoring / attribution / manual——商家对话绝不写标签（本模块
 * 只被「店铺同步打分」与「归因反哺」调用；manual 由用户端点显式写入且不被机器来源覆盖）。
 * 铁律 2 的消费端：发什么内容由标签决定（render.js tierOf 消费 price_sensitivity/intent）。
 */

// —— ① 同步打分（纯规则、可解释，AI 不参与；PRD §1.1）——
// intent：加购未付 > 下单未付 > 浏览未买 > 仅访问；时效 ≤7 天→hot / 8-30 天→warm / 更久→cold
const INTENT_RANK = { '加购未付': 4, '弃购': 4, '下单未付': 3, '浏览未买': 2, '仅访问': 1 };

function intentTagValue(row) {
  const days = Math.max(0, (Date.now() - (row.at_risk_at || row.created_at || Date.now())) / 86400000);
  const strong = INTENT_RANK[row.intent] >= 3;
  if (days <= 7) return strong ? 'hot' : 'warm';
  if (days <= 30) return 'warm';
  return 'cold';
}

function priceTagValue(row) {
  const p = row.price || '';
  if (['高', 'high'].includes(p)) return 'high';
  if (['低', 'low'].includes(p)) return 'low';
  return 'mid';
}

/** 由 audience 行计算标签集（[{tag_type, tag_value, weight}]，source=scoring） */
function tagsForAudienceRow(row) {
  const tags = [];
  const intentValue = intentTagValue(row);
  const intentWeight = intentValue === 'hot' ? 8 : intentValue === 'warm' ? 5 : 2;
  tags.push({ tag_type: 'intent', tag_value: intentValue, weight: intentWeight });
  const priceValue = priceTagValue(row);
  const priceWeight = priceValue === 'high' ? 7 : priceValue === 'mid' ? 4 : 2;
  tags.push({ tag_type: 'price_sensitivity', tag_value: priceValue, weight: priceWeight });
  // category_like：种子/导入数据无品类字段时不造数（允许缺）
  if (row.category) tags.push({ tag_type: 'category_like', tag_value: String(row.category), weight: 3 });
  return tags;
}

/** 店铺同步/导入时调用：为一批 audience 打标签（source=scoring；manual 不被覆盖） */
function scoreAudience(store, rows) {
  let n = 0;
  for (const row of rows || []) {
    for (const t of tagsForAudienceRow(row)) {
      store.upsertAudienceTag({ audience_id: row.id, ...t, source: 'scoring' });
      n++;
    }
  }
  return n;
}

// —— ⑤ 归因加权（PRD §5.6）：convert → 全部标签 w += 2；窗口期满未转化 → w −= 0.5；截断 [0,10] ——
function weightForConversion(store, audienceId) {
  return store.weightAudienceTags(audienceId, +2);
}
function weightForExpiry(store, audienceId) {
  return store.weightAudienceTags(audienceId, -0.5);
}

// —— ③ 生成输入：受众标签分布（需求定「发什么」，标签定「对谁说什么」）——
function tagDistribution(store, recipients) {
  const dist = {};
  for (const r of recipients || []) {
    for (const t of store.getAudienceTags(r.id)) {
      const key = `${t.tag_type}=${t.tag_value}`;
      if (!dist[key]) dist[key] = { tag_type: t.tag_type, tag_value: t.tag_value, count: 0, avg_weight: 0, _w: 0 };
      dist[key].count++;
      dist[key]._w += t.weight || 0;
    }
  }
  return Object.values(dist)
    .map(d => ({ tag_type: d.tag_type, tag_value: d.tag_value, count: d.count, avg_weight: +(d._w / d.count).toFixed(2) }))
    .sort((a, b) => b.count - a.count);
}

// —— ⑤「标签效果」聚合（数据页 Top5 + 样本数）：标签 → 转化率 ——
function tagEffect(store, opts = {}) {
  const minSample = opts.minSample || 1;
  const events = store.getEvents();
  const convertsByAudience = new Map();
  for (const e of events) {
    if (e.type !== 'convert' || !e.audience_id) continue;
    convertsByAudience.set(e.audience_id, (convertsByAudience.get(e.audience_id) || 0) + (e.value || 0));
  }
  const agg = {};
  for (const t of store.getAllAudienceTags()) {
    const key = `${t.tag_type}=${t.tag_value}`;
    if (!agg[key]) agg[key] = { tag_type: t.tag_type, tag_value: t.tag_value, sample: 0, converts: 0, gmv: 0 };
    agg[key].sample++;
    if (convertsByAudience.has(t.audience_id)) {
      agg[key].converts++;
      agg[key].gmv += convertsByAudience.get(t.audience_id);
    }
  }
  return Object.values(agg)
    .map(a => ({
      tag_type: a.tag_type, tag_value: a.tag_value, sample: a.sample, converts: a.converts,
      gmv: +a.gmv.toFixed(2),
      convert_rate: a.sample >= minSample ? +(a.converts / a.sample).toFixed(3) : null // 样本不足不出数
    }))
    .filter(a => a.sample >= minSample)
    .sort((a, b) => (b.convert_rate || 0) - (a.convert_rate || 0));
}

module.exports = {
  INTENT_RANK, tagsForAudienceRow, scoreAudience,
  weightForConversion, weightForExpiry,
  tagDistribution, tagEffect
};
