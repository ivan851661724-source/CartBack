'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE } = require('../lib/igde');
const flow = require('../lib/conversation-v6');
const { makeAcceptanceAct } = require('../lib/acceptance/assert');
function act() { const a = makeAcceptanceAct('v6'); flow.initialize(a); return a; }
function engine(env) { return new IGDE({ aiEnabled: true, callAI: async () => env, criticMode: 'off' }); }

test('send approval content hash binds the frozen cart URL', () => {
  const draft = { subject: 'Reminder', body: 'Your cart', mailgen_meta: { cart_url: 'https://original.example/cart' } };
  const approved = flow.copyHash(draft);
  draft.mailgen_meta.cart_url = 'https://replacement.example/cart';
  assert.notEqual(flow.copyHash(draft), approved);
});

test('high-discount proposals warn about profit without committing the candidate', async () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '10% off', evidence: '10% off' }], '10% off');
  const r = await engine({ changes: [{ op: 'propose', slot: 'offer', value: '90% off', evidence: '90% off' }] }).handle(a, '改成90% off怎么样');
  assert.equal(a.needs.offer.value, '10% off');
  assert.equal(a.flow_state.candidates[0].new, '90% off');
  assert.match(r.reply, /可能显著降低利润/);
});

test('common natural audience phrases resolve behavior without ignoring additional constraints', () => {
  const rows = [{ id: 1, intent: '加购未付' }, { id: 2, intent: '下单未付' }];
  for (const label of ['加购了没付款的客人', '加购了没结账的人']) {
    assert.deepEqual(flow.resolveAudience(label, rows).recipients.map(r => r.id), [1]);
    assert.equal(flow.resolveAudience('买过鞋子的' + label, rows).resolved, false);
  }
});

test('explicit no-offer wording commits the canonical decision without another confirmation', async () => {
  const a = act();
  const result = await engine({ changes: [{ op: 'set', slot: 'offer', value: '无优惠', evidence: '先不放优惠吧' }], reply: '好的，不放优惠' }).handle(a, '先不放优惠吧');
  assert.equal(a.needs.offer.value, '无优惠');
  assert.equal(a.flow_state.candidates.length, 0);
  assert.match(result.reply, /已保存/);
});

test('an unambiguous no-offer instruction also corrects an unnecessary model proposal', async () => {
  const a = act();
  await engine({ changes: [{ op: 'propose', slot: 'offer', value: '无优惠', evidence: '先不放优惠吧' }] }).handle(a, '先不放优惠吧');
  assert.equal(a.needs.offer.value, '无优惠'); assert.equal(a.flow_state.candidates.length, 0);
});

test('suggesting no offer remains a proposal', () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'propose', slot: 'offer', value: '无优惠', evidence: '考虑无优惠' }], '考虑无优惠');
  assert.equal(a.needs.offer, null); assert.equal(a.flow_state.candidates.length, 1);
});

test('pending choices do not suppress unrelated model answers', async () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'propose', slot: 'offer', value: '免邮', evidence: '免邮' }], '免邮怎么样');
  const r = await engine({ intent: 'query', reply: '这里支持邮件预览和受众管理。', changes: [] }).handle(a, '你有哪些功能');
  assert.match(r.reply, /邮件预览和受众管理/);
  assert.equal(a.flow_state.candidates.length, 1);
});

test('stale discount claims in generated previews fall back to current facts', () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '90% off', evidence: '90% off' }], '90% off');
  const card = flow.previewCard(engine({}), a, 'zh', { subject: '专属福利', body: '现在下单可享九折优惠' });
  assert.doesNotMatch(card.body, /九折/);
  assert.match(card.body, /90%/);
  assert.ok(card.copy_warning);
});

test('no-offer fallback retains saved brand and product in the configured email language', () => {
  const a = act();
  flow.applyChanges(a, ['brand', 'category', 'offer'].map((slot, i) => ({ op: 'set', slot, value: ['NovaHome', '瑜伽裤', '无优惠'][i], evidence: ['NovaHome', '瑜伽裤', '无优惠'][i] })), 'NovaHome 瑜伽裤 无优惠');
  const card = flow.previewCard(engine({}), a, 'zh');
  assert.match(card.body, /NovaHome/); assert.match(card.body, /瑜伽裤/);
  assert.doesNotMatch(card.body, /%|免邮/); assert.equal(card.product, '瑜伽裤');
});

test('a changed audience retains a visibly obsolete preview without making it preparable', () => {
  const a = act();
  flow.previewCard(engine({}), a, 'en', { subject: 'Old preview', body: 'Saved copy' });
  flow.applyChanges(a, [{ op: 'set', slot: 'audience', value: '老客', evidence: '老客' }], '老客');
  assert.equal(a.plan_card, null);
  assert.equal(a.flow_state.previous_preview.subject, 'Old preview');
  assert.equal(a.flow_state.previous_preview.obsolete, true);
});

test('high discount choices remain saved and immediately explain the profit impact', async () => {
  const a = act();
  const result = await engine({ changes: [{ op: 'set', slot: 'offer', value: '90% off', evidence: '90% off' }] }).handle(a, '90% off');
  assert.equal(a.needs.offer.value, '90% off');
  assert.match(result.reply, /利润|毛利/);
});

test('v6 accepting and clearing AOV candidates removes both stored aliases', () => {
  const a = act();
  a.memory.extras = [{ key: '客单价', value: '45美元', at: 1 }, { key: 'aov', value: '80美元', at: 2 }];
  flow.applyChanges(a, [{ op: 'propose', slot: 'aov', value: '100美元', evidence: '100美元' }], '考虑100美元');
  flow.resolveCandidate(a, a.flow_state.candidates[0].id, true);
  assert.deepEqual(a.memory.extras.map(e => [e.key, e.value]), [['客单价', '100美元']]);
  flow.applyChanges(a, [{ op: 'clear', slot: 'aov', evidence: '撤销客单价' }], '撤销客单价');
  assert.deepEqual(a.memory.extras, []);
});

test('estimates read the most recent persisted AOV alias without mutating extras', () => {
  const extras = [{ key: '客单价', value: '45美元', at: 1 }, { key: 'aov', value: '100美元', at: 2 }];
  assert.deepEqual(require('../lib/execution').parseAov(extras), { aov: 100, source: 'store' });
  assert.equal(extras[0].key, '客单价');
});
test('v6 readiness requires audience and an offer decision, not reason and goal', () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'set', slot: 'audience', value: '加购未付', evidence: '加购未付' }, { op: 'set', slot: 'offer', value: '无优惠', evidence: '无优惠' }], '加购未付，无优惠');
  assert.equal(flow.readiness(a).prepare, true);
  assert.equal(a.needs.reason, null); assert.equal(a.needs.goal, null);
  assert.ok(flow.availableActions(a).some(x => x.kind === 'preview_email'));
});
test('v6 no-answer and impatience never create default needs', async () => {
  const a = act();
  await engine({ reply: '先看预览。', changes: [], intent: 'preview' }).handle(a, '别问了，先写邮件');
  assert.equal(a.needs.audience, null); assert.equal(a.needs.reason, null);
  assert.equal(a.needs.offer, null); assert.equal(a.needs.goal, null);
  assert.equal(a.execution_snapshot, undefined);
});
test('v6 pending proposals survive unrelated queries and can be rejected individually', () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'set', slot: 'audience', value: '加购未付', evidence: '加购未付' }], '加购未付');
  flow.applyChanges(a, [{ op: 'propose', slot: 'audience', value: '老客', evidence: '老客' }, { op: 'propose', slot: 'offer', value: '免邮', evidence: '免邮' }], '老客也考虑，免邮也考虑');
  flow.applyChanges(a, [], '你有什么功能'); assert.equal(a.memory.conflicts.length, 2);
  const c = a.memory.conflicts[0]; flow.resolveCandidate(a, c.id, false);
  assert.equal(a.needs.audience.value, '加购未付'); assert.equal(a.memory.conflicts.length, 1);
});
test('v6 actions reject stale revision and business revision ignores queries', () => {
  const a = act(); const v = a.business_version;
  flow.applyChanges(a, [], '你是谁'); assert.equal(a.business_version, v);
  const token = flow.availableActions(a).find(x => x.kind === 'preview_email');
  flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '免邮', evidence: '免邮' }], '免邮');
  assert.throws(() => flow.validateAction(a, token), /已经更新|失效/);
});
test('v6 clears are not restored by legacy monotonic store merge', () => {
  const { mergeMonotonicAct } = require('../lib/needs');
  const a = act(); flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '九折', evidence: '九折' }], '九折');
  const old = structuredClone(a);
  flow.applyChanges(a, [{ op: 'clear', slot: 'offer', evidence: '优惠重新想想' }], '优惠重新想想');
  mergeMonotonicAct(a, old); assert.equal(a.needs.offer, null); assert.equal(a.filled_count, 0);
});
test('v6 raw model failures preserve input without keyword guessing', async () => {
  const a = act(); const e = new IGDE({ aiEnabled: true, callAI: async () => { throw new Error('timeout'); } });
  const r = await e.handle(a, '我上次说九折吗？');
  assert.equal(a.needs.offer, null); assert.equal(r.engine, 'degraded');
  assert.ok(a.messages.some(m => m.content === '我上次说九折吗？'));
});
test('v6 meaningful changes invalidate execution while a query preserves it', () => {
  const a = act(); a.execution_snapshot = { draft_id: 'old' }; a.stage = 'S3';
  flow.applyChanges(a, [], '你记得什么'); assert.ok(a.execution_snapshot);
  flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '免邮', evidence: '免邮' }], '改用免邮');
  assert.equal(a.execution_snapshot, null); assert.notEqual(a.stage, 'S3');
});
test('recipient selection never falls back to all recipients or adds unsupported filters', () => {
  const rows = [{ id: 'a', intent: '加购未付' }, { id: 'b', intent: '浏览未买' }];
  assert.deepEqual(flow.resolveAudience('加购未付客户', rows).recipients.map(x => x.id), ['a']);
  assert.equal(flow.resolveAudience('没买过耳机的上个月客户', rows).resolved, false);
  assert.equal(flow.resolveAudience('老客', rows).recipients.length, 0);
});

test('v6 unspecified discounts never acquire the legacy 10 percent default', () => {
  for (const value of ['折扣', '优惠码', '折扣力度未定', '优惠待定']) assert.equal(flow.offerDecided(value), false, value);
  assert.equal(flow.offerDecided('九折'), true);
});

test('reaffirming the existing value rejects its candidate without deleting other candidates', () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '10% off', evidence: '10% off' }], '10% off');
  flow.applyChanges(a, [{ op: 'propose', slot: 'offer', value: '免邮', evidence: '免邮' }, { op: 'propose', slot: 'audience', value: '老客', evidence: '老客' }], '免邮给老客怎么样');
  flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '10% off', evidence: '10% off' }], '还是10% off');
  assert.deepEqual(a.flow_state.candidates.map(c => c.slot), ['audience']);
});

test('send approval binds content, business version and frozen recipient IDs', () => {
  const a = act(); const draft = { id: 'd', subject: 's', body: 'b', mailgen_meta: { business_version: a.business_version, recipient_ids: ['r'] } };
  a.flow_state.approval = { draftId: 'd', version: a.business_version, copyHash: flow.copyHash(draft) };
  assert.equal(flow.sendApprovalCurrent(a, draft), true);
  const edit = structuredClone(draft); edit.body = 'changed'; assert.equal(flow.sendApprovalCurrent(a, edit), false);
  const expanded = structuredClone(draft); expanded.mailgen_meta.recipient_ids.push('new'); assert.equal(flow.sendApprovalCurrent(a, expanded), false);
  a.business_version++; assert.equal(flow.sendApprovalCurrent(a, draft), false);
});

test('semantic replay preserves unknowns, negation proposals, saved preview and query version', async () => {
  const a = act(); const envelopes = [
    { intent: 'chat', changes: [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }] },
    { intent: 'chat', changes: [{ op: 'set', slot: 'offer', value: '无优惠', evidence: '无优惠' }] },
    { intent: 'preview', preview: { subject: 'Welcome back', body: 'Visit our store when ready.' } },
    { intent: 'query', reply: '当前受众是加购未付客户，无优惠。' },
    { intent: 'chat', profileOperations: [{ op: 'set', field: 'constraints', value: '不允许免邮', evidence: '以后不允许免邮' }] }
  ];
  const e = new IGDE({ aiEnabled: true, callAI: async () => envelopes.shift() });
  await e.handle(a, '加购未付客户'); await e.handle(a, '无优惠');
  assert.equal(a.needs.reason, null); assert.equal(a.needs.goal, null);
  await e.handle(a, '先写一封'); const v = a.business_version;
  assert.equal(a.plan_card.subject, 'Welcome back'); assert.equal(a.execution_snapshot, null);
  await e.handle(a, '记得我的选择吗'); assert.equal(a.business_version, v); assert.ok(a.plan_card);
  await e.handle(a, '以后不允许免邮');
  assert.equal(a.needs.offer.value, '无优惠'); assert.equal(a.flow_state.candidates[0].profileField, 'constraints');
});

test('explicit conversational rejection resolves just the named candidate; deferral preserves it', () => {
  const a = act();
  flow.applyChanges(a, [{ op: 'propose', slot: 'offer', value: '免邮', evidence: '免邮' }, { op: 'propose', slot: 'goal', value: '回访', evidence: '回访' }], '免邮和回访怎么样');
  const offer = a.flow_state.candidates.find(c => c.slot === 'offer');
  flow.applyChanges(a, [{ op: 'resolve', candidateId: offer.id, decision: 'defer', evidence: '以后再说' }], '以后再说');
  assert.equal(a.flow_state.candidates.length, 2);
  flow.applyChanges(a, [{ op: 'resolve', candidateId: offer.id, decision: 'reject', evidence: '不要改' }], '不要改');
  assert.deepEqual(a.flow_state.candidates.map(c => c.slot), ['goal']); assert.equal(a.needs.offer, null);
});

test('clear decisions and pending candidates survive both SQLite and JSON restart', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
  const { Store } = require('../lib/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-v6-roundtrip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const kind of ['sqlite', 'json']) {
    const open = () => {
      const original = Module._load;
      if (kind === 'json') Module._load = function(name, ...args) { if (name === 'node:sqlite') throw new Error('test unavailable platform'); return original.call(this, name, ...args); };
      try { return new Store({ dbFile: path.join(dir, kind + '.sqlite') }); } finally { Module._load = original; }
    };
    let db = open(); db.init(); const a = act();
    flow.applyChanges(a, [{ op: 'set', slot: 'offer', value: '10% off', evidence: '10% off' }], '10% off'); db.upsertAct(a);
    flow.applyChanges(a, [{ op: 'clear', slot: 'offer', evidence: '重新想优惠' }, { op: 'propose', slot: 'goal', value: '回访', evidence: '回访' }], '重新想优惠，回访怎么样'); db.upsertAct(a); db.b.close?.();
    db = open(); db.init(); const saved = db.getAct(a.id);
    assert.equal(saved.needs.offer, null, kind); assert.equal(saved.flow_version, 6);
    assert.equal(saved.flow_state.candidates[0].new, '回访'); assert.equal(saved.business_version, a.business_version); db.b.close?.();
  }
});
