'use strict';
/**
 * 需求① 回归（2026-10-07）：
 *  - 频控误判修复：无触达记录（含 0 人名单）不再判「已被触达」
 *  - 全员被触达 → 不再硬拒，改为自动预约：item 带 retryAt（= 最早触达 + 72h），checklist.freqRetryAt 同值
 *  - buildPlanCard 默认码：codeDefault → discount.default + 「默认码」文案
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const execution = require('../lib/execution');

function fakeStore({ drafts = [], events = [] } = {}) {
  return { getDrafts: () => drafts, getEvents: () => events };
}

test('frequencyFilter：无触达记录 + 0 人名单 → 不误判、无 retryAt', () => {
  const f = execution.frequencyFilter(fakeStore(), [], { audience: '加购未付客户', user_id: 'u1' });
  assert.equal(f.skipped, 0);
  assert.equal(f.allow.length, 0);
  assert.equal(f.retryAt, null);
});

test('frequencyFilter：部分触达 → 剔除且不预约；全员触达 → retryAt = 最早触达 + 窗口', () => {
  const now = Date.now();
  const WIN = 72 * 3600 * 1000;
  const r1 = { id: 'a1' }, r2 = { id: 'a2' };
  const draft = { id: 'd1', audience: '加购未付客户', user_id: 'u1' };
  const store = fakeStore({
    drafts: [draft],
    events: [
      { type: 'emailed', ts: now - 1000, draft_id: 'd1', audience_id: 'a1' },
      { type: 'emailed', ts: now - 2000, draft_id: 'd1', audience_id: 'a2' },
    ],
  });
  const part = execution.frequencyFilter(store, [r1, r2, { id: 'a3' }], draft);
  assert.equal(part.skipped, 2);
  assert.deepEqual(part.allow.map(x => x.id), ['a3']);
  assert.equal(part.retryAt, null);

  const all = execution.frequencyFilter(store, [r1, r2], draft);
  assert.equal(all.allow.length, 0);
  assert.equal(all.retryAt, now - 2000 + WIN);   // 最早触达（a2, now-2000）+ 72h
});

test('evaluateChecklist：无触达 0 人名单频次项 pass；全员触达项带 retryAt 且 reason 说自动预约', async () => {
  const store = fakeStore();
  const act = { execution_snapshot: { audience: 'x', discount: { code_status: 'none' }, estGmv: {} } };
  const draft = { audience: '加购未付客户', brand: 'TestShop', user_id: 'u1' };
  const cl0 = await execution.evaluateChecklist({ act, draft, store, config: {}, connector: null, recipients: [] });
  const freq0 = cl0.items.find(i => i.gate === 'frequency');
  assert.equal(freq0.pass, true, '无触达记录的 0 人名单不应判「已被触达」');

  const now = Date.now();
  const WIN = 72 * 3600 * 1000;
  const store2 = fakeStore({
    drafts: [draft],
    events: [{ type: 'emailed', ts: now - 5000, draft_id: draft.id, audience_id: 'r1' }],
  });
  const cl1 = await execution.evaluateChecklist({ act, draft, store: store2, config: {}, connector: null, recipients: [{ id: 'r1', email: 'a@b.co' }] });
  const freq1 = cl1.items.find(i => i.gate === 'frequency');
  assert.equal(freq1.pass, false);
  assert.equal(freq1.retryAt, now - 5000 + WIN);
  assert.equal(cl1.freqRetryAt, now - 5000 + WIN);
  assert.match(freq1.reason, /自动预约/);
});

test('buildPlanCard：codeDefault → discount.default=true 且文案标「默认码」；快照保留 default 标记', () => {
  const card = execution.buildPlanCard({
    base: { audience: '加购未付客户', discountNum: 10, subject: 's', body: 'b' },
    code: 'LEOSPHONECASE10OFF', codeStatus: 'created', codeDefault: true,
    reachCount: 5, brand: "Leo's PhoneCase",
  });
  assert.equal(card.discount.default, true);
  assert.match(card.discount.text, /默认码/);
  const snap = execution.serializeSnapshot(card);
  assert.equal(snap.discount.default, true);
});
