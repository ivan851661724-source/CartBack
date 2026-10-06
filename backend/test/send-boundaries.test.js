'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Store } = require('../lib/store');
const execution = require('../lib/execution');

async function fixture(t, hold = '', real = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-send-boundaries-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ shopBrand: 'ReviewBrand', publicBaseUrl: 'https://review.example', mode: real ? 'real' : 'demo', espKey: 'test', espFrom: 'sender@review.example', espApiUrl: 'https://esp.test/emails', ...(hold === 'banner' || hold === 'code-failure' ? { stores: [{ type: 'mock', createFails: hold === 'code-failure' }] } : {}) }));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let now = Date.now();
  while (execution.localHourIn('America/New_York', now) < 10 || execution.localHourIn('America/New_York', now) >= 18) now += 3600000;
  const hook = path.join(dir, 'hooks.cjs');
  fs.writeFileSync(hook, `
    const root = ${JSON.stringify(path.resolve(__dirname, '..'))};
    let armed = false;
    process.on('message', m => { if (m === 'arm') armed = true; });
    const pause = async phase => { process.send({ phase }); await new Promise(r => process.once('message', r)); };
    const { IGDE } = require(root + '/lib/igde');
    const originalHandle = IGDE.prototype.handle;
    IGDE.prototype.handle = async function(a, text, options) {
      if (text === 'hold') await pause('message');
      return originalHandle.call(this, a, text, options);
    };
    const ex = require(root + '/lib/execution');
    const originalChecklist = ex.evaluateChecklist;
    ex.evaluateChecklist = async function(o) {
      const result = await originalChecklist(o);
      if (armed && process.env.TEST_HOLD === 'checklist' && o.draft.status === 'queued') { armed = false; await pause('checklist'); }
      return result;
    };
    const render = require(root + '/lib/render');
    const originalRender = render.renderCampaign;
    render.renderCampaign = async function(o) {
      const result = await originalRender(o);
      if (armed && process.env.TEST_HOLD === 'render') { armed = false; await pause('render'); }
      return result;
    };
    const originalFetch = global.fetch;
    let failedOnce = false;
    global.fetch = async function(url, options) {
      if (String(url).startsWith('https://esp.test')) {
        process.send({ phase: 'esp', payload: JSON.parse(options.body) });
        if (process.env.TEST_HOLD === 'retry' && !failedOnce) { failedOnce = true; process.send({ phase: 'first-failed' }); return new Response('', { status: 500 }); }
        if (armed && process.env.TEST_HOLD === 'esp') { armed = false; await pause('sending'); }
        return Response.json([{ id: 'test-receipt' }]);
      }
      return originalFetch(url, options);
    };
    const { MockConnector } = require(root + '/lib/storeConnector');
    const originalMeta = MockConnector.prototype.getShopMeta;
    MockConnector.prototype.getShopMeta = async function() {
      if (armed && process.env.TEST_HOLD === 'banner') { armed = false; await pause('banner'); }
      return originalMeta.call(this);
    };
    const mailgen = require(root + '/dist/mailgen');
    const originalMailgen = mailgen.run;
    mailgen.run = async function(...args) {
      if (armed && process.env.TEST_HOLD === 'mailgen') {
        armed = false; await pause('mailgen');
        return { success: true, html: '<p>OLD GENERATED COPY</p>', image_path: '', warnings: [] };
      }
      return originalMailgen.apply(this, args);
    };
  `);
  const child = spawn(process.execPath, ['--require', hook, 'server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, EY_SERVER_DIR: dir, PORT: String(port), CARTBACK_OPEN_LOCAL: '1', CARTBACK_FAKE_NOW: String(now), TEST_HOLD: hold }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages = [], waiters = [];
  child.on('message', m => { const i = waiters.findIndex(w => w.phase === m.phase); if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else messages.push(m); });
  t.after(async () => { child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 1000))]); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${port}`;
  let token;
  for (let i = 0; i < 50 && !token; i++) { try { token = (await (await fetch(base + '/api/bootstrap')).json()).token; } catch {} if (!token) await new Promise(r => setTimeout(r, 50)); }
  assert.ok(token);
  const api = async (p, body) => { const response = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-local-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); const raw = await response.text(); return { status: response.status, json: raw.startsWith('data:') ? null : JSON.parse(raw), raw }; };
  const db = change => { const store = new Store({ dbFile: path.join(dir, 'data.sqlite') }); store.init(); try { return change(store); } finally { store.b.close(); } };
  const act = (await api('/api/act', {})).json.act;
  db(s => { act.stage = 'S2'; act.needs = { audience: '加购未付', reason: '忘记结账', offer: '无额外优惠', goal: '挽回100单' }; s.upsertAct(act); });
  const state = async () => (await api('/api/state')).json;
  const finish = async did => { for (let i = 0; i < 80; i++) { const s = await state(); const d = s.drafts.find(d => d.id === did); if (d && ['sent', 'failed'].includes(d.status)) return d; await new Promise(r => setTimeout(r, 30)); } throw new Error('send did not finish'); };
  return { api, act, db, state, finish, arm: () => child.send('arm'), release: () => child.send('release'), phase: phase => { const i = messages.findIndex(m => m.phase === phase); return i >= 0 ? Promise.resolve(messages.splice(i, 1)[0]) : new Promise(resolve => waiters.push({ phase, resolve })); } };
}

for (const route of ['message', 'message/stream']) test(`creating or resuming conversations cannot close an in-flight ${route}`, async t => {
  const f = await fixture(t);
  const todo = f.db(s => s.addTodo({ user_id: f.act.user_id, act_id: f.act.id, summary: 'resume', reason: 'test' }));
  const pending = f.api(`/api/act/${f.act.id}/${route}`, { message: 'hold' });
  await f.phase('message');
  const created = await f.api('/api/act', {});
  const resumed = await f.api(`/api/todos/${todo.id}/resume`, {});
  f.release(); await pending;
  assert.equal(created.status, 409);
  assert.equal(resumed.status, 409);
  assert.equal((await f.state()).acts.filter(a => a.stage !== 'closed').length, 1);
  const next = await f.api('/api/act', {});
  assert.equal(next.status, 200);
  assert.equal((await f.api(`/api/act/${f.act.id}/${route}`, { message: 'hello' })).status, 409);
});

for (const hold of ['checklist', 'render']) test(`correction during ${hold} cancels delivery`, async t => {
  const f = await fixture(t, hold, hold === 'render');
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  f.arm();
  assert.equal((await f.api(`/api/draft/${cf.json.draft_id}/send`, {})).status, 202);
  await f.phase(hold);
  assert.equal((await f.api(`/api/act/${f.act.id}/message`, { message: '折扣改成15% off' })).status, 200);
  f.release();
  const draft = await f.finish(cf.json.draft_id);
  assert.equal(draft.status, 'failed');
  assert.match(f.db(s => s.getDraft(draft.id)).fail_reason, /作废|变化|更新/);
  assert.equal(f.db(s => s.getSends({ campaign_id: draft.id })).length, 0);
});

test('ESP submission holds the act guard against editing, confirmation and closing', async t => {
  const f = await fixture(t, 'esp', true);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  const todo = f.db(s => s.addTodo({ user_id: f.act.user_id, act_id: f.act.id, summary: 'resume', reason: 'test' }));
  f.arm(); await f.api(`/api/draft/${cf.json.draft_id}/send`, {});
  await f.phase('sending');
  const message = await f.api(`/api/act/${f.act.id}/message`, { message: '折扣改成15% off' });
  const confirm = await f.api(`/api/act/${f.act.id}/confirm`, {});
  const created = await f.api('/api/act', {});
  const resumed = await f.api(`/api/todos/${todo.id}/resume`, {});
  f.release();
  assert.deepEqual([message.status, confirm.status, created.status, resumed.status], [409, 409, 409, 409]);
  assert.equal((await f.finish(cf.json.draft_id)).status, 'sent');
  assert.equal((await f.api('/api/act', {})).status, 200);
});

test('edited fields reach ESP and preview while unchanged variant fields retain their tier copy', async t => {
  const f = await fixture(t, '', true);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  const did = cf.json.draft_id;
  const previous = f.db(s => s.getDraft(did));
  await f.api(`/api/draft/${did}/send`, { subject: 'Merchant edited subject', body: previous.body });
  const esp = await f.phase('esp');
  assert.ok(esp.payload.every(m => m.subject === 'Merchant edited subject'), JSON.stringify(esp.payload));
  const saved = await f.finish(did);
  assert.deepEqual(saved.variants.map(v => v.body), previous.variants.map(v => v.body));
  const preview = await f.api(`/api/draft/${did}/preview`);
  assert.ok(preview.json.tiers.filter(v => v.count > 0).every(v => v.subject === 'Merchant edited subject'));
  assert.equal(saved.html, '', 'edited copy must not attach stale HTML');
  assert.equal(f.db(s => s.getDraft(did)).mailgen_meta.copy_edits.subject, 'Merchant edited subject');
});

test('stale generated HTML cannot override persistent merchant edits in ESP payload', async t => {
  const f = await fixture(t, '', true);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  const did = cf.json.draft_id;
  f.db(s => { const d = s.getDraft(did); d.mailgen_meta = { ...d.mailgen_meta, copy_edits: { subject: 'Saved edited subject', body: 'Saved edited body' } }; d.html = '<p>OLD GENERATED BODY</p>'; s.upsertDraft(d); });
  await f.api(`/api/draft/${did}/send`, {});
  const esp = await f.phase('esp');
  assert.ok(esp.payload.every(m => m.subject === 'Saved edited subject' && m.text.includes('Saved edited body') && !m.html));
  assert.equal((await f.finish(did)).status, 'sent');
});

test('correction during ESP retry backoff prevents the next attempt', async t => {
  const f = await fixture(t, 'retry', true);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  await f.api(`/api/draft/${cf.json.draft_id}/send`, {});
  await f.phase('first-failed');
  assert.equal((await f.api(`/api/act/${f.act.id}/message`, { message: '折扣改成15% off' })).status, 200);
  assert.equal((await f.finish(cf.json.draft_id)).status, 'failed');
  assert.equal(f.db(s => s.getSends({ campaign_id: cf.json.draft_id })).length, 0);
});

test('new-conversation creation rechecks busy acts after awaiting the store banner', async t => {
  const f = await fixture(t, 'banner');
  f.arm();
  const creation = f.api('/api/act', {});
  await f.phase('banner');
  const message = f.api(`/api/act/${f.act.id}/message`, { message: 'hold' });
  await f.phase('message');
  f.release();
  assert.equal((await creation).status, 409);
  await message;
  assert.equal((await f.state()).acts.filter(a => a.stage !== 'closed').length, 1);
});

test('SQLite preserves code failure recovery and draft scheduling, variants and errors', async t => {
  const f = await fixture(t, 'code-failure');
  f.db(s => { const a = s.getAct(f.act.id); a.needs.offer = { value: '10% off', source: 'explicit', at: Date.now() }; s.upsertAct(a); });
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  assert.equal(cf.status, 409);
  const a = (await f.state()).acts.find(a => a.id === f.act.id);
  assert.equal(a.code_status, 'failed');
  assert.equal(a.plan_card, null);
  const variants = [{ tier: 'standard', subject: 'durable', body: 'body' }];
  const scheduled = Date.now() + 3600000;
  f.db(s => s.upsertDraft({ id: 'roundtrip', act_id: f.act.id, status: 'failed', variants, variants_provider: 'llm', fail_reason: 'changed', gate_checklist: [{ pass: false }], scheduled_at: scheduled }));
  const d = f.db(s => s.getDraft('roundtrip'));
  assert.deepEqual(d.variants, variants);
  assert.equal(d.variants_provider, 'llm');
  assert.equal(d.fail_reason, 'changed');
  assert.deepEqual(d.gate_checklist, [{ pass: false }]);
  assert.equal(d.scheduled_at, scheduled);
});

test('edited body is used across tiers and in ESP HTML/text', async t => {
  const f = await fixture(t, '', true);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  const did = cf.json.draft_id;
  const previous = f.db(s => s.getDraft(did));
  await f.api(`/api/draft/${did}/send`, { subject: previous.subject, body: 'Merchant edited body' });
  const esp = await f.phase('esp');
  assert.ok(esp.payload.every(m => m.text.includes('Merchant edited body')), JSON.stringify(esp.payload));
  assert.ok(esp.payload.every(m => !m.html || m.html.includes('Merchant edited body')));
  const saved = await f.finish(did);
  assert.deepEqual(saved.variants.map(v => v.subject), previous.variants.map(v => v.subject));
});

test('an archived confirmed draft remains sendable with an intact snapshot', async t => {
  const f = await fixture(t);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  assert.equal((await f.api('/api/act', {})).status, 200);
  assert.equal((await f.state()).acts.find(a => a.id === f.act.id).stage, 'closed');
  assert.equal((await f.api(`/api/draft/${cf.json.draft_id}/send`, {})).status, 202);
  assert.equal((await f.finish(cf.json.draft_id)).status, 'sent');
});

test('late image generation preserves merchant edits and sent lifecycle facts', async t => {
  const f = await fixture(t, 'mailgen', true);
  const cf = await f.api(`/api/act/${f.act.id}/confirm`, {});
  const did = cf.json.draft_id;
  f.arm();
  const image = f.api(`/api/draft/${did}/image`, { prompt: 'test artwork' });
  await f.phase('mailgen');
  await f.api(`/api/draft/${did}/send`, { subject: 'Final edited subject', body: 'Final edited body' });
  await f.phase('esp');
  const sent = await f.finish(did);
  f.release();
  assert.equal((await image).status, 200);
  const latest = f.db(s => s.getDraft(did));
  assert.equal(latest.status, 'sent');
  assert.equal(latest.sent_at, sent.sent_at);
  assert.equal(latest.esp_message_id, sent.esp_message_id);
  assert.equal(latest.subject, 'Final edited subject');
  assert.equal(latest.body, 'Final edited body');
  assert.equal(latest.html, '');
  assert.equal(latest.mailgen_meta.copy_edits.body, 'Final edited body');
});
