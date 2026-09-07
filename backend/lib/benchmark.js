'use strict';
/**
 * lib/benchmark.js — 行业基准库（PRD §5.7 / §0.3 匿名统计）
 *
 * 口径：品类(受众 intent 组) × 标签组合 × 折扣档 → 转化率；样本 ≥5 才出数；
 * 只出聚合（不含任何邮箱/姓名），跨店可用。持久化到 meta（量小，JSON 即可）；
 * 检索用关键词重叠打分（量小时足够；接 text-embedding-v4 + rerank 的 RAG 为 P2，
 * 语义同「跳过注入直接生成」的降级路径兼容）。
 */

/** 折扣档：≥30 high / 10–29 mid / <10 low */
function discountTier(discount) {
  const d = Number(discount) || 0;
  if (d >= 30) return 'high';
  if (d >= 10) return 'mid';
  return 'low';
}

/** 品类代理：现 schema 无独立品类字段，用受众 intent 组作品类级聚合键（PRD 允许品类级粗粒度） */
function categoryOf(audienceDesc) {
  const s = String(audienceDesc || '');
  if (/加购/.test(s)) return 'cart';
  if (/弃购|下单未付/.test(s)) return 'checkout';
  if (/浏览/.test(s)) return 'browse';
  if (/老客|沉睡|流失/.test(s)) return 'dormant';
  return 'other';
}

/**
 * 全量重建基准库（发送/归因后调用；数据量小，全量重算 O(n) 可接受）。
 * 输出 [{category, tags_key, discount_tier, sample, converts, rate}]，仅 sample ≥5。
 */
function rebuildBenchmark(store, opts = {}) {
  const minSample = opts.minSample || 5;
  const drafts = store.getDrafts();
  const events = store.getEvents();
  const audienceById = new Map(store.getAudience().map(a => [a.id, a]));

  // 每个 (category, tags_key, discount_tier) 桶：sample=实际触达人数（emailed 事件），converts=其中转化数。
  // 分母必须是触达人数而非「有互动的人数」，否则转化率系统性偏高、误导折扣决策。
  const buckets = {};
  const windowDays = opts.windowDays || 30;
  const windowMs = windowDays * 86400000;
  for (const d of drafts) {
    if (!['sent', 'recovering'].includes(d.status) || !d.sent_at) continue;
    if (Date.now() - d.sent_at > windowMs) continue;
    const category = categoryOf(d.audience);
    const tier = discountTier(d.discount);
    // 触达名单 = 该草稿的 emailed 事件（无 per-recipient 事件的旧草稿无法归因，跳过）
    const evs = events.filter(e => e.draft_id === d.id);
    const reachedIds = [...new Set(evs.filter(e => e.type === 'emailed' && e.audience_id).map(e => e.audience_id))];
    for (const aid of reachedIds) {
      const a = audienceById.get(aid);
      if (!a) continue;
      const tags = store.getAudienceTags(aid);
      const tagsKey = tags.length
        ? tags.map(t => `${t.tag_type}:${t.tag_value}`).sort().join('|')
        : 'untagged';
      const key = `${category}||${tagsKey}||${tier}`;
      if (!buckets[key]) buckets[key] = { category, tags_key: tagsKey, discount_tier: tier, sample: 0, converts: 0, gmv: 0 };
      buckets[key].sample++;
      const conv = evs.find(e => e.type === 'convert' && e.audience_id === aid);
      if (conv) { buckets[key].converts++; buckets[key].gmv += conv.value || 0; }
    }
  }
  const rows = Object.values(buckets)
    .map(b => ({ ...b, gmv: +b.gmv.toFixed(2), rate: b.sample >= minSample ? +(b.converts / b.sample).toFixed(3) : null }))
    .filter(b => b.sample >= minSample)
    .sort((a, b) => b.sample - a.sample);
  const lib = { updated_at: Date.now(), rows };
  store.setMeta('benchmark_lib', JSON.stringify(lib));
  return lib;
}

function getBenchmark(store) {
  try { return JSON.parse(store.getMeta('benchmark_lib') || 'null') || { updated_at: 0, rows: [] }; }
  catch (e) { return { updated_at: 0, rows: [] }; }
}

/** 简易检索：品类/折扣档精确匹配优先，标签键重叠计分；量小够用，embedding RAG 为 P2。 */
function queryBenchmark(lib, { audience = '', discount = 0, tags = [], k = 3 } = {}) {
  const category = categoryOf(audience);
  const tier = discountTier(discount);
  const tagSet = new Set(tags.map(t => `${t.tag_type}:${t.tag_value}`));
  const scored = (lib.rows || []).map(r => {
    let score = 0;
    if (r.category === category) score += 2;
    if (r.discount_tier === tier) score += 1;
    const overlap = (r.tags_key.split('|')).filter(x => tagSet.has(x)).length;
    score += overlap;
    return { ...r, score };
  }).filter(r => r.score > 0);
  return scored.sort((a, b) => b.score - a.score || b.sample - a.sample).slice(0, k);
}

module.exports = { discountTier, categoryOf, rebuildBenchmark, getBenchmark, queryBenchmark };
