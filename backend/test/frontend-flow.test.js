'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(relative) {
  const filename = path.resolve(__dirname, '../../frontend/src', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const out = { exports: {} };
  const localRequire = (name) => name.startsWith('.') ? load(path.join(path.dirname(relative), name + '.ts')) : require(name);
  new Function('require', 'module', 'exports', code)(localRequire, out, out.exports);
  return out.exports;
}

test('saving mail copy surfaces failures and only returns a persisted draft', async () => {
  const original = global.fetch;
  try {
    const client = load('lib/api.ts');
    global.fetch = async () => Response.json({ error: '存储失败' }, { status: 500 });
    await assert.rejects(client.saveDraftCopy('d', 'Updated', 'Body', 4), /存储失败/);
    global.fetch = async () => Response.json({ ok: true });
    await assert.rejects(client.saveDraftCopy('d', 'Updated', 'Body', 4), /保存/);
    global.fetch = async (_url, opts) => { assert.equal(opts.method, 'PUT'); assert.equal(JSON.parse(opts.body).expected_business_version, 4); return Response.json({ ok: true, draft: { id: 'd', subject: 'Updated' } }); };
    assert.equal((await client.saveDraftCopy('d', 'Updated', 'Body', 4)).draft.subject, 'Updated');
  } finally { global.fetch = original; }
});

test('conversation number follows creation order rather than the total chat count', () => {
  const { conversationNumber } = load('lib/chat-flow.ts');
  const acts = [{ id: 'third', created_at: 3 }, { id: 'first', created_at: 1 }, { id: 'second', created_at: 2 }];
  assert.equal(conversationNumber(acts, 'first'), 1);
  assert.equal(conversationNumber(acts, 'second'), 2);
});

test('outside-window plans can be scheduled while other failed checks still block', () => {
  const { planSendState } = load('lib/chat-flow.ts');
  const window = { gate: 'window', pass: false, label: '时段', reason: '不在发送时段' };
  const state = planSendState({ all_pass: false, items: [window, { gate: 'amount_code', pass: true, label: '金额' }] });
  assert.equal(state.canSend, true);
  assert.equal(state.scheduled, true);
  assert.equal(state.items[0].pass, true);
  assert.equal(state.items[0].label, '定时发送');
  assert.deepEqual(state.failItems, []);
  const hidden = planSendState({ all_pass: false, items: [window, { gate: 'unsubscribe', pass: false, label: '退订链接报错' }] });
  assert.equal(hidden.canSend, true);
  assert.equal(hidden.items.length, 1);
  assert.equal(planSendState({ all_pass: false, items: [window, { gate: 'frequency', pass: false, label: '频次' }] }).canSend, false);
});

test('conversation creation rejects server failures before exposing an act', async () => {
  const original = global.fetch;
  try {
    const client = load('lib/api.ts');
    for (const status of [409, 500]) {
      global.fetch = async () => Response.json({ error: '当前会话正在处理，请稍后重试' }, { status });
      await assert.rejects(client.createAct(), /当前会话正在处理，请稍后重试/);
    }
    global.fetch = async () => Response.json({});
    await assert.rejects(client.createAct(), /会话/);
    const act = { id: 'created', needs: {}, messages: [] };
    global.fetch = async () => Response.json({ act, chips: ['开始'], welcome: true });
    assert.deepEqual((await client.createAct()).act, act);
  } finally { global.fetch = original; }
});

test('audience shortcut labels resolve their groups and retain additional filters', () => {
  const { intentToAudience } = load('lib/constants.ts');
  const { resolveAudience } = require('../lib/conversation-v6');
  const rows = ['弃购', '下单未付', '加购未付', '沉睡', '流失', '老客', '浏览未买'].map((intent, id) => ({ id, intent, country: id % 2 ? 'GB' : 'US' }));
  for (const [intent, ids] of [['弃购', [0, 1, 2]], ['沉睡', [3, 4, 5]]]) {
    const label = intentToAudience(intent);
    const result = resolveAudience(label, rows);
    assert.equal(result.resolved, true);
    assert.deepEqual(result.recipients.map(r => r.id), ids);
    assert.deepEqual(resolveAudience('美国' + label, rows).recipients.map(r => r.id), ids.filter(id => rows[id].country === 'US'));
    assert.equal(resolveAudience('购买过鞋子的' + label, rows).resolved, false);
  }
});

test('no-offer recovery preserves the preview-only API outcome', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => Response.json({ ok: true, preview_only: true, act: { stage: 'S2' }, planCard: { subject: 'Reminder' } });
    const result = await load('lib/api.ts').confirmAct('a', { nohook: true });
    assert.equal(result.kind, 'ok');
    assert.equal(result.previewOnly, true);
    assert.equal(result.act.stage, 'S2');
  } finally { global.fetch = original; }
});
test('persisted code failure restores recovery actions after refresh', () => {
  const { confirmationRecoveryFor } = load('lib/chat-flow.ts');
  const act = { id: 'a', stage: 'S2', code_status: 'failed', planCard: null, memory: { conflicts: [] } };
  assert.equal(confirmationRecoveryFor(act).options.length, 3);
  assert.equal(confirmationRecoveryFor({ ...act, stage: 'S3' }), null);
  assert.equal(confirmationRecoveryFor({ ...act, memory: { conflicts: [{}] } }), null);
});

test('v6 keeps failure recovery with a visible preview and restores prepared cards on revisit', () => {
  const { confirmationRecoveryFor, preparedStateFor, replyChipsFor } = load('lib/chat-flow.ts');
  const a = { id: 'v6', flow_version: 6, stage: 'S2', planCard: { subject: 'Saved' }, flow_state: { resource_error: 'Store unavailable' }, memory: { conflicts: [] } };
  assert.equal(confirmationRecoveryFor(a).reason, 'Store unavailable');
  assert.equal(preparedStateFor(a), null);
  assert.equal(preparedStateFor({ ...a, stage: 'S3' }).planCard.subject, 'Saved');
  assert.deepEqual(replyChipsFor(a, ['好，帮我写一封', '介绍一下其他功能', '其他需求'], null), []);
});
test('polling timeout means pending, never failed or sent', async () => {
  const result = await load('lib/api.ts').pollSendJob('job', 0);
  assert.equal(result.pending, true);
  assert.equal(result.ok, true);
  assert.equal(result.result, undefined);
});
test('job failures and completed sends retain their distinct outcomes', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => Response.json({ status: 'failed', error: 'ESP rejected' });
    assert.deepEqual(await load('lib/api.ts').pollSendJob('job'), { ok: false, error: 'ESP rejected' });
    global.fetch = async () => Response.json({ status: 'done', result: { recipients: 2 } });
    assert.deepEqual(await load('lib/api.ts').pollSendJob('job'), { ok: true, result: { recipients: 2 } });
  } finally { global.fetch = original; }
});
test('completed queue jobs that defer or fail delivery are not reported as sent', async () => {
  const original = global.fetch;
  try {
    for (const result of [{ rescheduled: true }, { deferred: 'blackout' }, { skipped: 'global_paused' }]) {
      global.fetch = async () => Response.json({ status: 'done', result });
      assert.deepEqual(await load('lib/api.ts').pollSendJob('job'), { ok: true, pending: true });
    }
    global.fetch = async () => Response.json({ status: 'done', result: { error: 'snapshot invalidated' } });
    assert.deepEqual(await load('lib/api.ts').pollSendJob('job'), { ok: false, error: 'snapshot invalidated' });
  } finally { global.fetch = original; }
});
test('a future scheduled job returns pending immediately', async () => {
  const original = global.fetch;
  global.fetch = async () => Response.json({ status: 'pending', run_after: Date.now() + 3600000 });
  try { assert.deepEqual(await load('lib/api.ts').pollSendJob('job'), { ok: true, pending: true }); }
  finally { global.fetch = original; }
});
test('gate rejection without an error field must not acknowledge delivery', () => {
  const { sendFailureReason } = load('lib/api.ts');
  assert.match(sendFailureReason({ ok: false, checklist: { items: [{ pass: false, label: '品牌', reason: '品牌未设置' }] } }), /品牌未设置/);
  assert.ok(sendFailureReason({ ok: false }));
  assert.equal(sendFailureReason({ queued: true }), null);
});
test('explicit null invalidates old confirmation card, missing field preserves it', () => {
  const { mergeReplyAct } = load('lib/chat-flow.ts');
  const act = { id: 'a', stage: 'S2', needs: {}, messages: [], planCard: { audience: 'old' } };
  assert.equal(mergeReplyAct(act, { reply: 'clarify', planCard: null }).planCard, null);
  assert.equal(mergeReplyAct(act, { reply: 'partial' }).planCard, act.planCard);
});
test('exit actions require complete needs and an actionable card; conflicts suppress them', () => {
  const { replyChipsFor } = load('lib/chat-flow.ts');
  const act = { id: 'a', stage: 'S2', needs: { audience: 'a', reason: 'r', offer: 'o', goal: 'g' }, messages: [], planCard: null };
  assert.deepEqual(replyChipsFor(act, [], null), []);
  act.planCard = { audience: 'a' };
  assert.equal(replyChipsFor(act, [], null).length, 3);
  act.memory = { conflicts: [{ slot: 'audience', old: 'a', new: 'b' }] };
  assert.deepEqual(replyChipsFor(act, ['好，帮我写一封'], null), []);
  assert.deepEqual(replyChipsFor(act, ['a', 'b'], 'audience'), ['a', 'b']);
  act.memory.conflicts = []; act.needs.goal = '';
  assert.deepEqual(replyChipsFor(act, ['好，帮我写一封'], null), []);
});
test('SSE without done rejects instead of inventing empty needs and S0', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response('data: {"type":"token","value":"partial"}\n\n');
  try { await assert.rejects(load('lib/api.ts').streamMessage('a', 'continue', () => {})); }
  finally { global.fetch = original; }
});
test('a transport failure during confirmation does not invoke legacy unsupported flow', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try { await assert.rejects(load('lib/api.ts').confirmAct('a')); }
  finally { global.fetch = original; }
});
test('unresolved-conflict 409 is surfaced as a state error, not a discount-code failure', async () => {
  const original = global.fetch;
  global.fetch = async () => Response.json({ error: '需求冲突尚未解决' }, { status: 409 });
  try { await assert.rejects(load('lib/api.ts').confirmAct('a'), /需求冲突尚未解决/); }
  finally { global.fetch = original; }
});
test('valid done preserves server stage and needs; code failure keeps recovery options', async () => {
  const original = global.fetch;
  try {
    const result = { reply: 'done', stage: 'S2', needs: { audience: 'returning' }, planCard: null };
    global.fetch = async () => new Response(`data: ${JSON.stringify({ type: 'done', result })}\n\n`);
    assert.deepEqual(await load('lib/api.ts').streamMessage('a', 'continue', () => {}), result);
    global.fetch = async () => Response.json({ code_status: 'failed', reason: 'timeout', options: ['重试建码'] }, { status: 409 });
    const out = await load('lib/api.ts').confirmAct('a');
    assert.equal(out.kind, 'conflict');
    assert.deepEqual(out.options, ['重试建码']);
  } finally { global.fetch = original; }
});
test('done frame carries current memory and version into the next confirmation', async () => {
  const original = global.fetch;
  try {
    const act = { id: 'a', stage: 'S2', needs: { audience: 'new' }, messages: [{ role: 'assistant', content: 'resolved' }], memory: { conflicts: [] }, updated_at: 42 };
    const result = { reply: 'resolved', stage: 'S2', needs: act.needs, planCard: { audience: 'new' } };
    global.fetch = async () => new Response(`data: ${JSON.stringify({ type: 'done', result, act })}\n\n`);
    const reply = await load('lib/api.ts').streamMessage('a', 'change', () => {});
    const merged = load('lib/chat-flow.ts').mergeReplyAct({ ...act, updated_at: 1, memory: { conflicts: [{ slot: 'audience' }] }, messages: [] }, reply);
    assert.equal(merged.updated_at, 42);
    assert.deepEqual(merged.memory.conflicts, []);
    assert.equal(merged.messages.length, 1);
  } finally { global.fetch = original; }
});
