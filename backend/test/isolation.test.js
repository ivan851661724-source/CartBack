'use strict';
/**
 * 数据隔离测试（PRD 闸门 G6 user_id 隔离 / 铁律 1 manual 标签保护 / 加权截断）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const tagsMod = require('../lib/tags');
const competitorsMod = require('../lib/competitors');

function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-iso-' + name + '-'));
  const store = new Store({ dbFile: path.join(dir, 'iso.sqlite') });
  store.init();
  const cleanup = () => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { store, cleanup };
}

test('⑥ 竞品数据 user_id 隔离：A 看不见 B 的源与卡，也删不掉 B 的', () => {
  const { store, cleanup } = tempStore('user');
  try {
    store.upsertCompetitorSource({ user_id: 'userA', name: 'BrandA', status: 'active' });
    store.upsertCompetitorSource({ user_id: 'userB', name: 'BrandB', status: 'active' });
    const cardA = store.upsertStrategyCard({ user_id: 'userA', competitor_name: 'BrandA', theme_formula: 'promo_hook' });
    store.upsertStrategyCard({ user_id: 'userB', competitor_name: 'BrandB', theme_formula: 'story_hook' });

    assert.equal(store.listCompetitorSources('userA').length, 1);
    assert.equal(store.listCompetitorSources('userA')[0].name, 'BrandA');
    assert.equal(store.listStrategyCards('userA').length, 1);

    // A 删 B 的卡/源：无效果
    store.deleteStrategyCard(cardA.id, 'userB');
    store.deleteCompetitorSource(store.listCompetitorSources('userB')[0].id, 'userA');
    assert.equal(store.listStrategyCards('userA').length, 1);
    assert.equal(store.listCompetitorSources('userB').length, 1);

    // ⑥ 检索只在自己 user_id 范围内
    const hits = competitorsMod.topCards(store, 'userA', { audience: 'promo', discount: 25, k: 3 });
    assert.ok(hits.every(c => c.user_id === 'userA'));
  } finally { cleanup(); }
});

test('铁律 1：manual 标签不被 scoring/attribution 覆盖（manual 改后不再被机器写）', () => {
  const { store, cleanup } = tempStore('tags-manual');
  try {
    const [a] = store.addAudience([{ name: 'Ann', email: 'ann@x.com', intent: '加购未付', risk: '高', price: '高', abandoned_value: 100 }]);
    tagsMod.scoreAudience(store, [a]);
    // 商家手动改标签 → source=manual
    store.upsertAudienceTag({ audience_id: a.id, tag_type: 'price_sensitivity', tag_value: 'low', weight: 3, source: 'manual' });
    // 再跑 scoring：manual 的 price_sensitivity 不得回写
    tagsMod.scoreAudience(store, [a]);
    const ps = store.getAudienceTags(a.id).filter(t => t.tag_type === 'price_sensitivity');
    assert.equal(ps.length, 1);                        // 不新增重复行
    assert.equal(ps[0].source, 'manual');
    assert.equal(ps[0].tag_value, 'low');
    // attribution 加权也绕不开 manual
    store.weightAudienceTags(a.id, +2);
    const ps2 = store.getAudienceTags(a.id).find(t => t.tag_type === 'price_sensitivity');
    assert.equal(ps2.source, 'manual');
    assert.equal(ps2.weight, 3);
    // 非 manual 的 intent 标签被正常加权并转为 attribution 来源
    const intent = store.getAudienceTags(a.id).find(t => t.tag_type === 'intent');
    assert.equal(intent.source, 'attribution');
    assert.ok(intent.weight > tagsMod.tagsForAudienceRow(a).find(t => t.tag_type === 'intent').weight);
  } finally { cleanup(); }
});

test('⑤ 标签加权：convert +2 / 期满 −0.5，截断 [0,10]', () => {
  const { store, cleanup } = tempStore('tags-weight');
  try {
    const [a] = store.addAudience([{ name: 'Bob', email: 'bob@x.com', intent: '浏览未买', risk: '低', price: '低', abandoned_value: 10 }]);
    tagsMod.scoreAudience(store, [a]);
    const before = store.getAudienceTags(a.id);
    assert.ok(before.every(t => t.weight <= 10 && t.weight >= 0));
    // 连续转化加权 → 触顶 10 不越界
    for (let i = 0; i < 6; i++) tagsMod.weightForConversion(store, a.id);
    assert.ok(store.getAudienceTags(a.id).every(t => t.weight <= 10));
    assert.equal(store.getAudienceTags(a.id)[0].weight, 10);
    // 窗口期满衰减 → 触底 0 不越界
    for (let i = 0; i < 30; i++) tagsMod.weightForExpiry(store, a.id);
    assert.ok(store.getAudienceTags(a.id).every(t => t.weight >= 0));
  } finally { cleanup(); }
});

test('⑤ bounced 剔除：email_status=email_invalid 的收件人不再进入发送名单', async () => {
  const render = require('../lib/render');
  const { store, cleanup } = tempStore('tags-bounce');
  try {
    const [a] = store.addAudience([{ name: 'Chen', email: 'chen@x.com', intent: '加购未付', risk: '高', price: '中', abandoned_value: 50, locale: 'en' }]);
    store.suppressAudienceEmail(a.id);
    const aud = store.getAudience().find(x => x.id === a.id);
    assert.equal(aud.email_status, 'email_invalid');
    // 渲染管线切片直接剔除（发不出、也数不进 renderable）
    const r = await render.renderCampaign({
      draft: { id: 'd', coupon: 'C', discount: 10 },
      variants: [{ tier: 'standard', subject: 'hi', body: 'body' }],
      recipients: [aud],
      whitelist: []
    });
    assert.equal(r.stats.excluded, 1);
    assert.equal(r.stats.renderable, 0);
  } finally { cleanup(); }
});

test('replaceAudience 清理孤儿标签：被替换掉的用户标签不残留', () => {
  const { store, cleanup } = tempStore('orphan-tags');
  try {
    const list = store.addAudience([
      { name: 'A', email: 'a@x.com', intent: '加购未付', risk: '高', price: '高', abandoned_value: 10 },
      { name: 'B', email: 'b@x.com', intent: '浏览未买', risk: '低', price: '低', abandoned_value: 10 }
    ]);
    tagsMod.scoreAudience(store, list);
    assert.equal(store.getAllAudienceTags().length, 4);   // 2 人 × 2 类
    // 店铺全量替换：只保留 A
    store.replaceAudience([list[0]]);
    const remain = store.getAllAudienceTags();
    assert.equal(remain.length, 2);
    assert.ok(remain.every(t => t.audience_id === list[0].id));
  } finally { cleanup(); }
});

test('⑤ tagEffect：按标签聚合转化率，样本不足不出数（null）', () => {
  const { store, cleanup } = tempStore('tags-effect');
  try {
    const list = store.addAudience([
      { name: 'A', email: 'a@x.com', intent: '加购未付', risk: '高', price: '高', abandoned_value: 10 },
      { name: 'B', email: 'b@x.com', intent: '加购未付', risk: '高', price: '高', abandoned_value: 10 },
      { name: 'C', email: 'c@x.com', intent: '加购未付', risk: '高', price: '高', abandoned_value: 10 }
    ]);
    tagsMod.scoreAudience(store, list);
    store.addEvent({ type: 'convert', audience_id: list[0].id, value: 30 });
    const effect = tagsMod.tagEffect(store, { minSample: 1 });
    const priceHigh = effect.find(e => e.tag_type === 'price_sensitivity' && e.tag_value === 'high');
    assert.equal(priceHigh.sample, 3);
    assert.equal(priceHigh.converts, 1);
    assert.equal(priceHigh.convert_rate, 0.333);
    assert.equal(priceHigh.gmv, 30);
  } finally { cleanup(); }
});
