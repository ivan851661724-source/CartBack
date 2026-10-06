'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE } = require('../lib/igde');
const { makeAcceptanceAct } = require('../lib/acceptance/assert');
const { buildResumedAct } = require('../lib/zombie');
const { applyAgentProfilePatch, applyMemoryPatch } = require('../lib/context');

function act(conflict = false) {
  const a = makeAcceptanceAct('safety'); a.stage = 'S1';
  for (const [slot, value] of Object.entries({ audience: '18-24岁女性', reason: '忘记结账', offer: '免邮' })) {
    a.needs[slot] = { value, source: 'explicit', at: 1 };
  }
  if (conflict) a.memory.conflicts = [{ slot: 'audience', old: '18-24岁女性', new: '25-34岁女性', asked: true, at: 1 }];
  return a;
}
test('rejecting an audience conflict keeps the original audience', async () => {
  for (const text of ['不改', '不要改', '还是原来那拨人']) {
    const a = act(true); await new IGDE({ aiEnabled: false }).handle(a, text);
    assert.equal(a.needs.audience.value, '18-24岁女性', text);
    assert.equal(a.memory.conflicts.length, 0);
  }
});
test('force and write requests keep unresolved conflicts actionable', async () => {
  for (const text of ['别问了', '好，帮我写一封']) {
    const a = act(true);
    const r = await new IGDE({ aiEnabled: true }).handle(a, text);
    assert.equal(r.planCard, null);
    assert.equal(r.askedSlot, 'audience');
    assert.ok(r.chips.length);
    assert.equal(a.memory.conflicts.length, 1);
  }
});
test('force completion still intercepts excessive discounts', async () => {
  const a = act(); a.needs.offer = null;
  const r = await new IGDE({ aiEnabled: true }).handle(a, '别问了，折扣给90%');
  assert.equal(a.needs.offer, null);
  assert.ok(a.pending_ops.e1);
  assert.deepEqual(r.chips, ['换成替代方案', '就要这个折扣']);
});
test('force completion admits the current brand before inferring missing needs', async () => {
  const a = act(); a.memory.s1_turns = 12;
  await new IGDE({ aiEnabled: true }).handle(a, '品牌叫Acme');
  assert.equal(a.memory.extras.find(e => e.key === 'brand')?.value, 'Acme');
  assert.equal(a.stage, 'S2');
});
test('tours do not use collection attempts', async () => {
  const a = act(); const e = new IGDE({ aiEnabled: false });
  for (let i = 0; i < 12; i++) await e.handle(a, '介绍一下其他功能');
  assert.equal(a.memory.s1_turns, 0);
});
test('resuming resets conversation counters while retaining business memory', () => {
  const a = act(); Object.assign(a.memory, { s1_turns: 12, loop_breaks: 2, goal_bare: 2, ask_count: { goal: 9 }, clarif_count: { audience: 1 }, extras: [{ key: 'brand', value: 'Acme' }] });
  const r = buildResumedAct(a);
  assert.equal(r.memory.s1_turns, 0); assert.equal(r.memory.loop_breaks, 0);
  assert.equal(r.memory.goal_bare, 0); assert.equal(r.memory.ask_count.goal, 0);
  assert.equal(r.memory.clarif_count.audience, 0);
  assert.equal(r.memory.extras[0].value, 'Acme');
});
test('temporary campaign information cannot become a permanent shop profile', () => {
  const r = applyAgentProfilePatch({}, { product: { value: '鞋子', evidence: '推广鞋子' } }, { userText: '这次我们要推广鞋子' });
  assert.equal(r.profile.product, undefined);
});
test('grounded quotes cannot authorize unrelated memory values', () => {
  const raw = { value: '50% off', evidence: '以后默认免邮' };
  assert.equal(applyAgentProfilePatch({}, { default_offer: raw }, { userText: raw.evidence }).stats.accepted, 0);
  const a = act();
  assert.equal(applyMemoryPatch(a, { facts: [{ key: 'offer', ...raw }] }, { userText: raw.evidence }).accepted, 0);
  assert.equal(applyAgentProfilePatch({}, { default_offer: { value: '包邮', evidence: raw.evidence } }, { userText: raw.evidence }).profile.default_offer, '包邮');
});
test('a policy correction replaces the conflicting constraint and keeps unrelated rules', () => {
  const r = applyAgentProfilePatch({ constraints: ['不打折', '邮件不要出现中文'] }, { constraints: { value: '允许打折', evidence: '以后改成允许打折' } }, { userText: '以后改成允许打折' });
  assert.deepEqual(r.profile.constraints, ['邮件不要出现中文', '允许打折']);
});
test('correction evidence mentioning a retained rule does not delete that rule', () => {
  const text = '以后改成允许打折，邮件不要出现中文继续保留';
  const r = applyAgentProfilePatch({ constraints: ['不打折', '邮件不要出现中文'] }, { constraints: { value: '允许打折', evidence: text } }, { userText: text });
  assert.deepEqual(r.profile.constraints, ['邮件不要出现中文', '允许打折']);
});
test('prohibited offers cannot be remembered as positive defaults', () => {
  for (const text of ['以后不允许免邮', '以后禁止提供免邮', '以后不得使用免邮']) {
    const r = applyAgentProfilePatch({}, { default_offer: { value: '免邮', evidence: text } }, { userText: text });
    assert.equal(r.profile.default_offer, undefined, text);
  }
});
test('force completion after model failure uses the honest degraded response', async () => {
  const a = act();
  const r = await new IGDE({ aiEnabled: true, callAI: async () => { throw new Error('offline'); } }).handle(a, '别问了');
  assert.equal(r.engine, 'degraded');
  assert.equal(r.planCard, null);
  assert.ok(!/在下面的确认卡里核对|改完点确认/.test(r.reply));
});
