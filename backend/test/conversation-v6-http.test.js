'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const net = require('node:net'); const { spawn } = require('node:child_process');
const { Store } = require('../lib/store'); const flow = require('../lib/conversation-v6');
async function fixture(t, config = {}, mailgenHook = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-v6-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'demo', shopBrand: 'TestShop', publicBaseUrl: 'https://shop.test', ...config }));
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  const args = ['server.js'];
  if (mailgenHook) {
    const hook = path.join(dir, 'mailgen-hook.cjs');
    fs.writeFileSync(hook, `
      const mg = require(${JSON.stringify(path.resolve(__dirname, '../dist/mailgen'))});
      mg.run = async p => {
        if (p.image_prompt_override === 'hold-image') {
          process.send({ phase: 'image' }); await new Promise(r => process.once('message', r));
        }
        return { success: true, html: p.copy_passthrough ? '<p>' + p.body + '</p>' : '<p>Unapproved model copy</p>', image_path: 'review-image.png', copy_provider: 'passthrough', image_method: 'test' };
      };
    `);
    args.unshift('--require', hook);
  }
  const child = spawn(process.execPath, args, { cwd: path.resolve(__dirname, '..'), env: { ...process.env, EY_SERVER_DIR: dir, PORT: String(port), CARTBACK_OPEN_LOCAL: '1' }, stdio: mailgenHook ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
  t.after(async () => { child.kill(); await new Promise(r => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${port}`; let token;
  for (let i = 0; i < 60 && !token; i++) { try { token = (await (await fetch(base + '/api/bootstrap')).json()).token; } catch {} if (!token) await new Promise(r => setTimeout(r, 50)); }
  assert.ok(token);
  let cookie = '';
  const api = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-local-token': token, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  const update = (id, change) => { const db = new Store({ dbFile: path.join(dir, 'data.sqlite') }); db.init(); const a = db.getAct(id); change(a); db.upsertAct(a); db.b.close(); return a; };
  const editDraft = (id, change) => { const db = new Store({ dbFile: path.join(dir, 'data.sqlite') }); db.init(); const d = db.getDraft(id); change(d); db.upsertDraft(d); db.b.close(); };
  return { api, update, editDraft, child };
}
test('v6 HTTP: explicit protocol, saved template preview, no execution artifacts, stale action', async t => {
  const { api, update } = await fixture(t);
  assert.equal((await api('/api/act', { flow_version: 99 })).status, 400);
  const created = await api('/api/act', { flow_version: 6 }); const a = created.data.act;
  assert.equal(a.flow_version, 6); assert.deepEqual(a.flow_state.actions, []);
  update(a.id, x => { x.flow_state.intent = true; flow.refreshActions(x); });
  const current = (await api('/api/state')).data.acts.find(x => x.id === a.id);
  const action = current.flow_state.actions.find(x => x.kind === 'preview_email');
  const preview = await api(`/api/act/${a.id}/action`, action); assert.equal(preview.status, 200);
  const state = (await api('/api/state')).data; const saved = state.acts.find(x => x.id === a.id);
  assert.ok(saved.plan_card || saved.planCard); assert.equal(saved.execution_snapshot, null);
  assert.equal(state.drafts.filter(d => d.act_id === a.id).length, 0);
  update(a.id, x => flow.applyChanges(x, [{ op: 'set', slot: 'offer', value: '免邮', evidence: '免邮' }], '免邮'));
  assert.equal((await api(`/api/act/${a.id}/action`, action)).status, 409);
});

test('saving draft copy persists text, rendered preview and revision without sending', async t => {
  const { api, update } = await fixture(t, {}, true);
  const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const ready = update(a.id, x => {
    flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: '无优惠', evidence: '无优惠' }, { op: 'set', slot: 'category', value: '瑜伽裤', evidence: '瑜伽裤' }], '加购未付客户，无优惠，瑜伽裤');
    flow.previewCard(new (require('../lib/igde').IGDE)({}), x, 'en', { subject: 'Original', body: 'Original body' });
  });
  const prepared = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.draft.product, '瑜伽裤');
  assert.equal(prepared.data.draft.mailgen_meta.product_category, 'apparel');
  const id = prepared.data.draft.id;
  const saved = await api(`/api/draft/${id}`, { expected_business_version: prepared.data.act.business_version, subject: 'Updated subject', body: 'Updated body' }, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal(saved.data.draft.subject, 'Updated subject');
  assert.match(saved.data.draft.html, /Updated subject/); assert.match(saved.data.draft.html, /Updated body/);
  assert.equal(saved.data.draft.status, 'draft');
  assert.equal(saved.data.act.flow_state.approval, null);
  const state = (await api('/api/state')).data;
  assert.equal(state.drafts.find(d => d.id === id).subject, 'Updated subject');
  const stale = await api(`/api/draft/${id}`, { expected_business_version: prepared.data.act.business_version, subject: 'Stale', body: 'Stale' }, 'PUT');
  assert.equal(stale.status, 409);
});
test('v6 preparation without a connected shop issues a default code and keeps optional fields empty', async t => {
  const { api, update } = await fixture(t);
  const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const ready = update(a.id, x => flow.applyChanges(x, [
    { op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' },
    { op: 'set', slot: 'offer', value: '10% off', evidence: '10% off' },
    { op: 'set', slot: 'category', value: '手机壳', evidence: '手机壳' },
  ], '加购未付客户，10% off，手机壳'));
  const out = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version });
  assert.equal(out.status, 200);
  const dis = out.data.planCard.discount;
  // 需求②：未连接店铺 → 默认码（品牌+折扣+OFF，如 TESTSHOP10OFF），显式标注 default
  assert.equal(dis.code_status, 'created');
  assert.equal(dis.default, true);
  assert.equal(dis.code, 'TESTSHOP10OFF');
  assert.match(dis.text, /默认码/);
  const saved = (await api('/api/state')).data.acts.find(x => x.id === a.id);
  assert.equal(saved.needs.offer.value, '10% off'); assert.equal(saved.needs.reason, null); assert.equal(saved.needs.goal, null);
  // 闸门⑤：默认码不要求店铺校验（核对单放行，标注默认码）
  const cl = await api(`/api/act/${a.id}/checklist`);
  assert.equal(cl.status, 200);
  const amount = cl.data.checklist.items.find(i => i.gate === 'amount_code');
  assert.equal(amount.pass, true);
  assert.match(amount.reason, /默认码/);
  // 需求①：无触达记录时频次闸不再误判「已被触达」（0 人名单 → pass）
  const freq = cl.data.checklist.items.find(i => i.gate === 'frequency');
  assert.equal(freq.pass, true);
});

test('v6 preview edits persist, advance revision, and cannot be submitted with an old action', async t => {
  const { api, update } = await fixture(t); const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const x = update(a.id, x => { x.flow_state.intent = true; flow.refreshActions(x); });
  const preview = await api(`/api/act/${a.id}/action`, x.flow_state.actions.find(a => a.kind === 'preview_email'));
  const save = preview.data.act.flow_state.actions.find(a => a.kind === 'save_preview');
  const edited = await api(`/api/act/${a.id}/action`, { ...save, subject: 'My subject', body: 'My approved copy' });
  assert.equal(edited.status, 200); assert.equal(edited.data.act.business_version, save.targetVersion + 1);
  const saved = (await api('/api/state')).data.acts.find(x => x.id === a.id);
  assert.equal(saved.plan_card.subject, 'My subject'); assert.equal(saved.plan_card.body, 'My approved copy');
  assert.equal(saved.execution_snapshot, null);
  assert.equal((await api(`/api/act/${a.id}/action`, { ...save, subject: 'Old', body: 'Stale' })).status, 409);
});

test('v6 no-offer preparation does not require optional fields, freezes recipients, and rejects stale sending', async t => {
  const { api, update } = await fixture(t); const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const ready = update(a.id, x => flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: '无优惠', evidence: '无优惠' }], '加购未付客户，无优惠'));
  const out = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version });
  assert.equal(out.status, 200); assert.equal(out.data.act.needs.reason, null); assert.equal(out.data.act.needs.goal, null);
  assert.equal(out.data.draft.discount, 0); assert.equal(out.data.act.flow_state.approval, null);
  assert.ok(Array.isArray(out.data.draft.mailgen_meta.recipient_ids));
  const before = (await api(`/api/draft/${out.data.draft_id}/send`, { expected_business_version: ready.business_version - 1 })).data;
  assert.match(before.error, /变化/);
  update(a.id, x => flow.applyChanges(x, [{ op: 'clear', slot: 'offer', evidence: '优惠撤销' }], '优惠撤销'));
  assert.equal((await api(`/api/draft/${out.data.draft_id}/send`, { expected_business_version: ready.business_version })).status, 409);
});

test('v6 high-discount send requires risk acknowledgement before queueing or editing', async t => {
  const { api, update, editDraft } = await fixture(t); const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const ready = update(a.id, x => flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: '无优惠', evidence: '无优惠' }], '加购未付客户，无优惠'));
  const out = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version });
  editDraft(out.data.draft_id, d => { d.discount = 90; });
  const denied = await api(`/api/draft/${out.data.draft_id}/send`, { expected_business_version: ready.business_version, subject: 'Do not save before approval' });
  assert.equal(denied.status, 409); assert.equal(denied.data.requires_risk_confirmation, true);
  const state = (await api('/api/state')).data; assert.equal(state.acts.find(x => x.id === a.id).flow_state.approval, null);
  assert.notEqual(state.drafts.find(d => d.id === out.data.draft_id).subject, 'Do not save before approval');
});

test('v6 a saved existing coupon is kept as a default code without a store, never replaced with no coupon', async t => {
  const { api, update } = await fixture(t); const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const ready = update(a.id, x => flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: 'SAVE20', evidence: 'SAVE20' }], '加购未付客户，SAVE20'));
  // 需求②：未连接店铺 → 用户指定码名按默认码放行（显式标注 default），不再 409 / 降级无优惠
  const out = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version });
  assert.equal(out.status, 200);
  assert.equal(out.data.planCard.discount.code, 'SAVE20');
  assert.equal(out.data.planCard.discount.default, true);
  assert.equal(out.data.planCard.discount.percent_off, 20);
  assert.equal(out.data.draft.coupon, 'SAVE20');
});

test('v6 manual choices work offline; preparation preserves approved HTML and image writes exclude sends', async t => {
  const { api, child } = await fixture(t, {}, true);
  const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const message = (await api(`/api/act/${a.id}/message`, { message: '先看看' })).data;
  const choices = message.act.flow_state.actions.find(a => a.kind === 'save_choices');
  const selected = (await api(`/api/act/${a.id}/action`, { ...choices, choices: { audience: '加购未付客户', offer: '无优惠', reason: '', goal: '' } })).data.act;
  assert.equal(selected.needs.reason, null); assert.equal(selected.needs.goal, null);
  assert.deepEqual(selected.flow_state.actions.filter(a => ['preview_email', 'tour', 'other'].includes(a.kind)).map(a => a.label), ['好，帮我写一封', '介绍一下其他功能', '其他需求']);
  const preview = (await api(`/api/act/${a.id}/action`, selected.flow_state.actions.find(a => a.kind === 'preview_email'))).data.act;
  const edited = (await api(`/api/act/${a.id}/action`, { ...preview.flow_state.actions.find(a => a.kind === 'save_preview'), subject: 'Approved subject', body: 'Approved exact content' })).data.act;
  const prepared = await api(`/api/act/${a.id}/action`, edited.flow_state.actions.find(a => a.kind === 'prepare_plan'));
  assert.equal(prepared.status, 200); assert.match(prepared.data.draft.html, /Approved exact content/);
  assert.ok(prepared.data.draft.variants.every(v => v.body === 'Approved exact content'));
  assert.equal(prepared.data.act.flow_state.actions.some(a => a.kind === 'save_preview'), false);
  const phase = new Promise(r => child.once('message', r));
  const image = api(`/api/draft/${prepared.data.draft_id}/image`, { prompt: 'hold-image' });
  assert.equal((await phase).phase, 'image');
  const denied = await api(`/api/draft/${prepared.data.draft_id}/send`, { expected_business_version: prepared.data.act.business_version });
  assert.equal(denied.status, 409); assert.match(denied.data.error, /更新|处理/);
  child.send('release'); assert.equal((await image).status, 200);
  const state = (await api('/api/state')).data; const saved = state.drafts.find(d => d.id === prepared.data.draft_id);
  assert.equal(saved.mailgen_meta.flow_version, 6);
  assert.equal(saved.mailgen_meta.business_version, prepared.data.act.business_version + 1);
  assert.deepEqual(saved.mailgen_meta.recipient_ids, prepared.data.draft.mailgen_meta.recipient_ids);
  assert.equal(saved.subject, 'Approved subject'); assert.equal(saved.body, 'Approved exact content');
});

test('profile management deletes only the selected policy and never repopulates deleted memory on recall', async t => {
  const { api, update } = await fixture(t);
  const registered = await api('/api/auth/register', { email: 'memory@example.com', password: 'passw0rd123', name: 'Memory' });
  assert.ok(registered.status === 200 || registered.status === 201);
  const profile = { product: 'Headphones', constraints: ['不允许免邮', '不允许限时促销'] };
  assert.equal((await api('/api/agent-profile', { profile }, 'PUT')).status, 200);
  assert.deepEqual((await api('/api/agent-profile')).data.profile.constraints, profile.constraints);
  const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const pending = update(a.id, x => { x.flow_state.intent = true; x.flow_state.candidates = [{ id: 'policy', slot: 'profile.constraints', profileField: 'constraints', profileOp: 'delete', profilePrevious: '不允许免邮', old: '不允许免邮', new: '' }]; flow.refreshActions(x); });
  assert.equal((await api(`/api/act/${a.id}/action`, pending.flow_state.actions.find(a => a.kind === 'accept_candidate'))).status, 200);
  assert.deepEqual((await api('/api/agent-profile')).data.profile.constraints, ['不允许限时促销']);
  assert.equal((await api('/api/agent-profile', undefined, 'DELETE')).status, 200);
  await api(`/api/act/${a.id}/message`, { message: '还记得我的长期资料吗' });
  assert.deepEqual((await api('/api/agent-profile')).data.profile, {});
});

test('no-offer recovery returns a reviewable neutral preview before preparing a new draft', async t => {
  const { api, update } = await fixture(t, {}, true);
  const a = (await api('/api/act', { flow_version: 6 })).data.act;
  // 触发准备失败改用「免邮」这类尚不支持的优惠资源（10% off 未连店铺现在出默认码，不再 409）
  const ready = update(a.id, x => {
    flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: '免邮', evidence: '免邮' }], '加购未付客户，免邮');
    x.plan_card = { subject: 'Enjoy free shipping', body: 'Free shipping automatically applied.' }; x.stage = 'S2'; flow.refreshActions(x);
  });
  const failed = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version }); assert.equal(failed.status, 409);
  const recovery = await api(`/api/act/${a.id}/confirm`, { expected_business_version: failed.data.act.business_version, nohook: true });
  assert.equal(recovery.status, 200); assert.equal(recovery.data.preview_only, true);
  assert.equal(recovery.data.act.stage, 'S2'); assert.equal(recovery.data.act.execution_snapshot, null);
  assert.equal(recovery.data.planCard.discount.code_status, 'none');
  assert.equal(recovery.data.planCard.discountNum, 0);
  assert.doesNotMatch(recovery.data.planCard.subject + recovery.data.planCard.body, /\d+%\s*off|automatically applied/i);
  assert.equal((await api('/api/state')).data.drafts.filter(d => d.act_id === a.id).length, 0);
  const prepare = recovery.data.act.flow_state.actions.find(a => a.kind === 'prepare_plan');
  const out = await api(`/api/act/${a.id}/action`, prepare); assert.equal(out.status, 200);
  assert.equal(out.data.draft.discount, 0);
  assert.doesNotMatch(out.data.draft.subject + out.data.draft.body + out.data.draft.html, /\d+%\s*off|automatically applied/i);
});

test('preparation delivers the real coupon in reviewed copy, every variant and HTML', async t => {
  const { api, update } = await fixture(t, { stores: [{ type: 'mock' }] }, true);
  for (const text of ['Return to our store and enjoy 10% off.', 'Use {{coupon}} at checkout for {{discount}} off.']) {
    const a = (await api('/api/act', { flow_version: 6 })).data.act;
    const ready = update(a.id, x => {
      flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: '10% off', evidence: '10% off' }], '加购未付客户，10% off');
      x.plan_card = { subject: 'Your cart', body: text }; x.stage = 'S2'; flow.refreshActions(x);
    });
    const out = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version }); assert.equal(out.status, 200);
    const code = out.data.draft.coupon; assert.ok(code);
    assert.ok(out.data.planCard.body.includes(code)); assert.equal(out.data.draft.body, out.data.planCard.body);
    assert.ok(out.data.draft.variants.every(v => v.body.includes(code)));
    assert.ok(out.data.draft.html.includes(code)); assert.doesNotMatch(out.data.planCard.body, /\{\{coupon\}\}|\{\{discount\}\}/);
    assert.equal(out.data.act.flow_state.approval, null);
  }
});

test('explicit v6 aov updates feed estimates and replace the previous alias', async t => {
  const { api, update } = await fixture(t, {}, true);
  const a = (await api('/api/act', { flow_version: 6 })).data.act;
  const ready = update(a.id, x => {
    x.memory.extras = [{ key: '客单价', value: '45美元', at: 1 }];
    flow.applyChanges(x, [{ op: 'set', slot: 'audience', value: '加购未付客户', evidence: '加购未付客户' }, { op: 'set', slot: 'offer', value: '无优惠', evidence: '无优惠' }, { op: 'set', slot: 'aov', value: '100美元', evidence: '客单价100美元' }], '加购未付客户，无优惠，客单价100美元');
  });
  const out = await api(`/api/act/${a.id}/confirm`, { expected_business_version: ready.business_version }); assert.equal(out.status, 200);
  assert.equal(out.data.planCard.estGmv.formula.aov, 100); assert.equal(out.data.planCard.estGmv.source, 'store');
});
