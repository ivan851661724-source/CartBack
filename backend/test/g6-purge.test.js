'use strict';
/**
 * G6 竞品合规测试（PRD §6.5：学结构不抄文案；原文仅存 30 天，保留卡片；原文不出库）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const competitorsMod = require('../lib/competitors');

const RAW = 'Subject: 40% OFF flash sale\n\nBig discounts today only. Unsubscribe: https://x.example/u';

function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-g6-' + name + '-'));
  const store = new Store({ dbFile: path.join(dir, 'g6.sqlite') });
  store.init();
  const cleanup = () => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { store, cleanup };
}

test('G6：30 天内的原文保留；到期清除原文但保留卡片本体', () => {
  const { store, cleanup } = tempStore('purge');
  try {
    const fresh = store.upsertStrategyCard({
      user_id: 'u1', competitor_name: 'Fresh', theme_formula: 'promo_hook',
      raw_email: RAW, collected_at: Date.now() - 5 * 86400000
    });
    const stale = store.upsertStrategyCard({
      user_id: 'u1', competitor_name: 'Stale', theme_formula: 'story_hook',
      raw_email: RAW, collected_at: Date.now() - 31 * 86400000
    });
    const r = competitorsMod.g6Purge(store);   // 默认 30 天
    assert.equal(r.purged, 1);
    assert.equal(store.getStrategyCard(fresh.id).raw_email, RAW);   // 未到期保留
    const after = store.getStrategyCard(stale.id);
    assert.equal(after.raw_email, null);        // 到期原文清除
    assert.equal(after.theme_formula, 'story_hook');   // 卡片本体保留（学到的结构不丢）
  } finally { cleanup(); }
});

test('G6：原文不出库——策略卡对外形态（publicCard 语义）不含 raw_email', () => {
  const { store, cleanup } = tempStore('noleak');
  try {
    store.upsertStrategyCard({
      user_id: 'u1', competitor_name: 'BrandX', theme_formula: 'promo_hook',
      raw_email: RAW, collected_at: Date.now()
    });
    // server 端 publicCard(c) 的核心契约：序列化结果不含 raw_email，只含 raw_retained 标志
    const card = store.listStrategyCards('u1')[0];
    const pub = JSON.parse(JSON.stringify(card, (k, v) => (k === 'raw_email' ? undefined : v)));
    assert.ok(!('raw_email' in pub));
    assert.ok(pub.theme_formula);   // 结构字段可出
  } finally { cleanup(); }
});

test('G6：预过滤——营销邮件保留，订单/物流/无退订/无促销丢弃', () => {
  const marketing = 'Enjoy 25% OFF this weekend only! Shop now. Unsubscribe: https://x.example/u';
  assert.deepEqual(competitorsMod.prefilter(marketing), { keep: true, reason: 'marketing' });
  assert.equal(competitorsMod.prefilter('Your order shipped. Tracking 1Z999. Unsubscribe: https://x/u').keep, false);
  assert.equal(competitorsMod.prefilter('Just a newsletter about our brand story. Unsubscribe: https://x/u').keep, false);
  assert.equal(competitorsMod.prefilter('40% OFF everything right now!').keep, false);   // 无退订链接
  assert.equal(competitorsMod.prefilter('Unsubscribe: https://x/u').keep, false);        // 太短
});

test('G6：拆解降级链——LLM 离线走启发式，输出策略卡（结构，非原文）', async () => {
  const { card, provider } = await competitorsMod.extractStrategyCard({
    rawEmail: 'Flash sale! 30% off with code X. Ends in 24h! Unsubscribe: https://x/u',
    competitorName: 'Nova',
    llmJSON: null
  });
  assert.equal(provider, 'heuristic');
  assert.equal(card.discount_range, '30%');
  assert.equal(card.theme_formula, 'promo_hook');
  assert.equal(card.competitor_name, 'Nova');
  // LLM 失败同样降级启发式（不阻塞收集）
  const failed = await competitorsMod.extractStrategyCard({
    rawEmail: 'Flash sale! 30% off with code X. Ends in 24h! Unsubscribe: https://x/u',
    llmJSON: async () => { throw new Error('llm down'); }
  });
  assert.equal(failed.provider, 'heuristic');
  assert.ok(failed.card.theme_formula);
});

test('G6：收集地址按 user 派生（转发制；域名取已验证发件域名）', () => {
  const addr = competitorsMod.collectionAddress('usr_abc123def', 'send@mystore.com');
  assert.match(addr, /^scan\+usrabc123def@mystore\.com$/);
  const fallback = competitorsMod.collectionAddress('usr_x', '');
  assert.match(fallback, /@inbound\.cartback\.demo$/);
});
