'use strict';
/**
 * ModelGateway（llm.js client 多 provider 分发）+ 基准库（benchmark）单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LLMClient, client: llmClient, PROVIDER_PRESETS } = require('../lib/llm');
const benchmarkMod = require('../lib/benchmark');
const { Store } = require('../lib/store');

test('ModelGateway：client() 按 provider 分发 baseUrl/模型，keys[provider] 优先', () => {
  const c = llmClient('qwen', { apiKey: 'k-global', keys: { qwen: 'k-qwen' }, model: 'qwen3.6-flash' });
  assert.ok(c instanceof LLMClient);
  assert.equal(c.baseUrl, PROVIDER_PRESETS.qwen.baseUrl);
  assert.equal(c.model, 'qwen3.6-flash');
  assert.equal(c.apiKey, 'k-qwen');
  // 未命中 keys[provider] 回落全局 key；模型缺省用 provider 默认
  const d = llmClient('deepseek', { apiKey: 'k-global' });
  assert.equal(d.baseUrl, PROVIDER_PRESETS.deepseek.baseUrl);
  assert.equal(d.model, PROVIDER_PRESETS.deepseek.defaultModel);
  // custom 无 baseUrl → 快速失败
  assert.throws(() => llmClient('custom', {}), /baseUrl/);
  // 未知 provider 按 custom 处理
  assert.throws(() => llmClient('nope', {}), /baseUrl/);
});

function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-bench-' + name + '-'));
  const store = new Store({ dbFile: path.join(dir, 'b.sqlite') });
  store.init();
  const cleanup = () => {
    try { if (store.b) store.b.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { store, cleanup };
}

test('基准库：样本 ≥5 才出数；折扣档/品类键正确；检索按品类+折扣命中', () => {
  const { store, cleanup } = tempStore('agg');
  try {
    assert.equal(benchmarkMod.discountTier(35), 'high');
    assert.equal(benchmarkMod.discountTier(15), 'mid');
    assert.equal(benchmarkMod.discountTier(5), 'low');
    assert.equal(benchmarkMod.categoryOf('加购未付客户'), 'cart');
    assert.equal(benchmarkMod.categoryOf('浏览未买'), 'browse');

    // 构造 6 个已发送草稿 + 每个一条 convert（样本 6 ≥5 → 出数）
    for (let i = 0; i < 6; i++) {
      const d = store.upsertDraft({
        id: 'dr_b' + i, audience: '加购未付', discount: 12, status: 'sent',
        sent_at: Date.now() - 86400000, created_at: Date.now() - 2 * 86400000, cost: 0.1
      });
      const [a] = store.addAudience([{ name: 'A' + i, email: `a${i}@x.com`, intent: '加购未付', risk: '高', price: '高', abandoned_value: 100, locale: 'en' }]);
      store.addEvent({ type: 'emailed', draft_id: d.id, audience_id: a.id, ts: Date.now() });
      store.addEvent({ type: 'convert', draft_id: d.id, audience_id: a.id, value: 50 });
    }
    // 样本不足的桶（1 条）不出数
    const d2 = store.upsertDraft({ id: 'dr_rare', audience: '沉睡老客', discount: 40, status: 'sent', sent_at: Date.now() - 86400000, created_at: Date.now(), cost: 0.1 });
    const [rare] = store.addAudience([{ name: 'R', email: 'r@x.com', intent: '沉睡', risk: '低', price: '低', abandoned_value: 10, locale: 'en' }]);
    store.addEvent({ type: 'emailed', draft_id: d2.id, audience_id: rare.id, ts: Date.now() });

    // 无 emailed 事件的转化不得灌水样本（分母 = 触达人数，非互动人数）
    const [ghost] = store.addAudience([{ name: 'G', email: 'g@x.com', intent: '加购未付', risk: '高', price: '高', abandoned_value: 10, locale: 'en' }]);
    store.addEvent({ type: 'convert', draft_id: 'dr_b0', audience_id: ghost.id, value: 99 });

    const lib = benchmarkMod.rebuildBenchmark(store);
    const cart = lib.rows.find((r) => r.category === 'cart');
    assert.ok(cart, 'cart 桶出数');
    assert.equal(cart.sample, 6, '分母=emailed 触达人数，无触达事件的转化不进样本');
    assert.equal(cart.converts, 6);
    assert.equal(cart.rate, 1);
    assert.equal(cart.discount_tier, 'mid');
    assert.ok(!lib.rows.some((r) => r.category === 'dormant'), '样本 <5 不出数');
    // 持久化到 meta（匿名聚合，无邮箱字段）
    const stored = benchmarkMod.getBenchmark(store);
    assert.ok(stored.rows.length >= 1);
    assert.ok(!JSON.stringify(stored).includes('@x.com'), '匿名：不含任何邮箱');

    // 检索：品类+折扣档匹配优先
    const hits = benchmarkMod.queryBenchmark(stored, { audience: '加购未付', discount: 12, k: 3 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].category, 'cart');
    // 无关查询不命中
    assert.equal(benchmarkMod.queryBenchmark(stored, { audience: '浏览未买', discount: 50 }).length, 0);
  } finally { cleanup(); }
});
