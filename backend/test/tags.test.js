'use strict';
/**
 * 消费者标签链路测试（PRD §0.5 / §1 打分 / §5 标签反哺 / render tier 消费）
 * 覆盖：打分规则（intent 时效分层）→ manual 权威不被机器覆盖 → 归因加权（+2/−0.5 截断）
 *       → tagDistribution → tagEffect 聚合 → render.tierOf 按标签选变体 tier。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const tags = require('../lib/tags');
const { tierOf, pickVariant } = require('../lib/render');

// Windows 下 SQLite WAL 句柄释放略滞后：单钩子先 close 再删目录
function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-tags-'));
  const store = new Store({ dbFile: path.join(dir, 't.sqlite') });
  store.init();
  const cleanup = () => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { store, cleanup };
}

const DAY = 86400000;

test('tags：打分规则 — intent 时效分层 hot/warm/cold，price/category 规则', () => {
  const now = Date.now();
  // 强意图 + 7 天内 → hot
  const hot = tags.tagsForAudienceRow({ id: 'a1', intent: '加购未付', at_risk_at: now - 3 * DAY });
  assert.equal(hot.find(t => t.tag_type === 'intent').tag_value, 'hot');
  assert.equal(hot.find(t => t.tag_type === 'intent').weight, 8);
  // 强意图但 8-30 天 → warm（时效压过意图）
  const warm = tags.tagsForAudienceRow({ id: 'a2', intent: '弃购', at_risk_at: now - 15 * DAY });
  assert.equal(warm.find(t => t.tag_type === 'intent').tag_value, 'warm');
  assert.equal(warm.find(t => t.tag_type === 'intent').weight, 5);
  // 弱意图 + 7 天内 → warm（仅访问不算 hot）
  const weak = tags.tagsForAudienceRow({ id: 'a3', intent: '仅访问', at_risk_at: now - 1 * DAY });
  assert.equal(weak.find(t => t.tag_type === 'intent').tag_value, 'warm');
  // >30 天 → cold
  const cold = tags.tagsForAudienceRow({ id: 'a4', intent: '加购未付', at_risk_at: now - 40 * DAY });
  assert.equal(cold.find(t => t.tag_type === 'intent').tag_value, 'cold');
  assert.equal(cold.find(t => t.tag_type === 'intent').weight, 2);
  // price 高/低/缺省
  assert.equal(tags.tagsForAudienceRow({ id: 'a5', intent: '弃购', price: '高' }).find(t => t.tag_type === 'price_sensitivity').tag_value, 'high');
  assert.equal(tags.tagsForAudienceRow({ id: 'a6', intent: '弃购', price: 'low' }).find(t => t.tag_type === 'price_sensitivity').tag_value, 'low');
  const mid = tags.tagsForAudienceRow({ id: 'a7', intent: '弃购' });
  assert.equal(mid.find(t => t.tag_type === 'price_sensitivity').tag_value, 'mid');
  // category_like：有品类才打，无品类不造数
  assert.ok(!mid.some(t => t.tag_type === 'category_like'));
  const cat = tags.tagsForAudienceRow({ id: 'a8', intent: '弃购', category: '跑鞋' });
  assert.equal(cat.find(t => t.tag_type === 'category_like').tag_value, '跑鞋');
});

test('tags：scoreAudience 批量入库 source=scoring；manual 权威不被机器覆盖', () => {
  const { store, cleanup } = tempStore('scoring-manual');
  try {
    const rows = [
      { id: 'u1', intent: '加购未付', at_risk_at: Date.now(), price: '高' },
      { id: 'u2', intent: '仅访问', at_risk_at: Date.now() - 60 * DAY }
    ];
    const n = tags.scoreAudience(store, rows);
    assert.ok(n >= 4);
    const u1 = store.getAudienceTags('u1');
    assert.ok(u1.every(t => t.source === 'scoring'));
    assert.equal(u1.find(t => t.tag_type === 'intent').tag_value, 'hot');

    // 商家手工改判 u1 意图为 cold（manual 权威）
    store.upsertAudienceTag({ audience_id: 'u1', tag_type: 'intent', tag_value: 'cold', weight: 9, source: 'manual' });
    // 重新同步打分：manual 不得被 scoring 覆盖
    tags.scoreAudience(store, rows);
    const after = store.getAudienceTags('u1');
    const intent = after.find(t => t.tag_type === 'intent');
    assert.equal(intent.tag_value, 'cold');
    assert.equal(intent.source, 'manual');
  } finally { cleanup(); }
});

test('tags：归因反哺 — convert +2 / expiry −0.5 / 截断 [0,10] / manual 不动', () => {
  const { store, cleanup } = tempStore('weight');
  try {
    store.upsertAudienceTag({ audience_id: 'w1', tag_type: 'intent', tag_value: 'hot', weight: 8, source: 'scoring' });
    store.upsertAudienceTag({ audience_id: 'w1', tag_type: 'price_sensitivity', tag_value: 'high', weight: 7, source: 'scoring' });
    store.upsertAudienceTag({ audience_id: 'w1', tag_type: 'category_like', tag_value: '跑鞋', weight: 5, source: 'manual' });

    tags.weightForConversion(store, 'w1');
    let rows = store.getAudienceTags('w1');
    assert.equal(rows.find(t => t.tag_type === 'intent').weight, 10);      // 8+2
    assert.equal(rows.find(t => t.tag_type === 'price_sensitivity').weight, 9); // 7+2
    assert.equal(rows.find(t => t.tag_type === 'category_like').weight, 5);     // manual 不动
    assert.ok(rows.find(t => t.tag_type === 'intent').source === 'attribution');

    tags.weightForConversion(store, 'w1');   // 再 +2 → 顶格 10
    tags.weightForExpiry(store, 'w1');       // −0.5 → 9.5
    rows = store.getAudienceTags('w1');
    assert.equal(rows.find(t => t.tag_type === 'intent').weight, 9.5);

    // 低权重向下截断到 0
    store.upsertAudienceTag({ audience_id: 'w2', tag_type: 'intent', tag_value: 'cold', weight: 0.3, source: 'scoring' });
    tags.weightForExpiry(store, 'w2');
    assert.equal(store.getAudienceTags('w2').find(t => t.tag_type === 'intent').weight, 0);
  } finally { cleanup(); }
});

test('tags：tagDistribution — 计数/均权聚合，按 count 降序', () => {
  const { store, cleanup } = tempStore('dist');
  try {
    const rows = [
      { id: 'd1', intent: '加购未付', at_risk_at: Date.now(), price: '高' },
      { id: 'd2', intent: '加购未付', at_risk_at: Date.now(), price: '低' },
      { id: 'd3', intent: '仅访问', at_risk_at: Date.now(), price: '高' }
    ];
    tags.scoreAudience(store, rows);
    const dist = tags.tagDistribution(store, rows);
    assert.equal(dist[0].key === undefined, true);
    assert.equal(dist[0].count, 2);            // intent=hot 两人
    assert.ok(dist[0].tag_key !== undefined || dist[0].tag_type === 'intent');
    const byKey = Object.fromEntries(dist.map(d => [`${d.tag_type}=${d.tag_value}`, d]));
    assert.equal(byKey['intent=hot'].count, 2);
    assert.equal(byKey['intent=warm'].count, 1);
    assert.equal(byKey['price_sensitivity=high'].count, 2);
    assert.ok(['price_sensitivity=high', 'intent=hot'].includes(dist[0].tag_type + '=' + dist[0].tag_value));
  } finally { cleanup(); }
});

test('tags：tagEffect — 转化聚合 convert_rate/gmv + minSample 过滤', () => {
  const { store, cleanup } = tempStore('effect');
  try {
    const rows = [
      { id: 'e1', intent: '加购未付', at_risk_at: Date.now(), price: '高' },
      { id: 'e2', intent: '加购未付', at_risk_at: Date.now(), price: '低' },
      { id: 'e3', intent: '仅访问', at_risk_at: Date.now(), price: '高' }
    ];
    tags.scoreAudience(store, rows);
    // e1 转化 $88；e3 转化 $10
    store.addEvent({ type: 'convert', audience_id: 'e1', value: 88, ts: Date.now() });
    store.addEvent({ type: 'convert', audience_id: 'e3', value: 10, ts: Date.now() });
    const effect = tags.tagEffect(store, {});
    const hot = effect.find(a => a.tag_type === 'intent' && a.tag_value === 'hot');
    assert.equal(hot.sample, 2);
    assert.equal(hot.converts, 1);
    assert.equal(hot.gmv, 88);
    assert.equal(hot.convert_rate, 0.5);
    // minSample=3：样本不足 → 该标签不出数
    const strict = tags.tagEffect(store, { minSample: 3 });
    assert.ok(!strict.find(a => a.tag_type === 'intent'));
  } finally { cleanup(); }
});

test('tags：render.tierOf 消费标签选 tier（high→discount / hot→urgency / 兜底 standard）', () => {
  // 价格敏感 high → discount tier（最高优先）
  assert.equal(tierOf({}, [{ tag_type: 'price_sensitivity', tag_value: 'high', weight: 7 }, { tag_type: 'intent', tag_value: 'hot', weight: 8 }]), 'discount');
  // 意图 hot（无 high 价感）→ urgency
  assert.equal(tierOf({}, [{ tag_type: 'intent', tag_value: 'hot', weight: 8 }]), 'urgency');
  // 无标签 → 受众老字段近似：price 高 → discount；risk 高 → urgency
  assert.equal(tierOf({ price: '高' }, []), 'discount');
  assert.equal(tierOf({ risk: '高' }, []), 'urgency');
  assert.equal(tierOf({}, []), 'standard');
  // 同类型多标签取 weight 最高者
  assert.equal(tierOf({}, [
    { tag_type: 'intent', tag_value: 'cold', weight: 2 },
    { tag_type: 'intent', tag_value: 'hot', weight: 8 }
  ]), 'urgency');
  // pickVariant：命中 tier 变体；无对应变体回落 standard
  const variants = [
    { tier: 'discount', subject: 'D' },
    { tier: 'urgency', subject: 'U' },
    { tier: 'standard', subject: 'S' }
  ];
  assert.equal(pickVariant({}, variants, [{ tag_type: 'price_sensitivity', tag_value: 'high', weight: 7 }]).variant.subject, 'D');
  assert.equal(pickVariant({}, variants, []).variant.subject, 'S');
  // variants 缺 standard → 回落首个
  assert.equal(pickVariant({}, [{ tier: 'urgency', subject: 'U' }], []).variant.subject, 'U');
});
