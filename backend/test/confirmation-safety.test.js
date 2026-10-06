'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Store } = require('../lib/store');

async function startServer(t, hold = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-confirm-safety-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const hook = path.join(dir, 'hold.cjs');
  // Pause real request work at an async boundary, avoiding timing-dependent race tests.
  fs.writeFileSync(hook, `
    const root = ${JSON.stringify(path.resolve(__dirname, '..'))};
    const pause = async (phase) => {
      process.send({ phase });
      await new Promise(resolve => process.once('message', resolve));
    };
    if (process.env.TEST_HOLD === 'message') {
      const { IGDE } = require(root + '/lib/igde');
      const original = IGDE.prototype.handle;
      IGDE.prototype.handle = async function(act, text, opts) {
        if (text === '并发测试') await pause('message');
        if (text === '抛错测试') throw new Error('test injected failure');
        return original.call(this, act, text, opts);
      };
    }
    if (process.env.TEST_HOLD === 'confirm') {
      const execution = require(root + '/lib/execution');
      const original = execution.evaluateChecklist;
      let first = true;
      execution.evaluateChecklist = async function(...args) {
        if (first) { first = false; await pause('confirm'); }
        return original.apply(this, args);
      };
    }
  `);
  const child = spawn(process.execPath, ['--require', hook, 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1', TEST_HOLD: hold },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  t.after(async () => {
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  let token;
  for (let i = 0; i < 50 && !token; i++) {
    try { token = (await (await fetch(base + '/api/bootstrap')).json()).token; } catch {}
    if (!token) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(token, 'server started');
  const api = async (url, body) => {
    const response = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-local-token': token },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    return { status: response.status, json: raw.startsWith('data:') ? null : JSON.parse(raw), raw };
  };
  const created = await api('/api/act', {});
  const act = created.json.act;
  const db = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  db.init();
  act.stage = 'S2';
  act.needs = { audience: '18-24岁女性', reason: '忘记结账', offer: '无额外优惠', goal: '挽回100单' };
  db.upsertAct(act);
  db.b.close();
  return {
    api, act, dir,
    phase: () => new Promise(resolve => child.once('message', resolve)),
    release: () => child.send('release'),
    update: change => {
      const db = new Store({ dbFile: path.join(dir, 'data.sqlite') });
      db.init();
      const current = db.getAct(act.id);
      change(current);
      db.upsertAct(current);
      db.b.close();
      return current;
    }
  };
}

test('confirmation rejects unresolved conflicts without creating a draft', async t => {
  const { api, act, update } = await startServer(t);
  update(a => { a.memory.conflicts = [{ slot: 'audience', old: '18-24岁女性', new: '25-34岁女性', asked: true }]; });
  const result = await api(`/api/act/${act.id}/confirm`, {});
  assert.equal(result.status, 409);
  assert.match(result.json.error, /澄清|冲突/);
  const state = (await api('/api/state')).json;
  assert.equal(state.acts.find(a => a.id === act.id).stage, 'S2');
  assert.equal(state.drafts.filter(d => d.act_id === act.id).length, 0);
});

test('confirmation rejects stale timestamps but supports current timestamps and legacy callers', async t => {
  const { api, act, update } = await startServer(t);
  const current = update(a => { a.updated_at += 1000; });
  const stale = await api(`/api/act/${act.id}/confirm`, { expected_updated_at: act.updated_at });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /变化|更新|过期/);
  assert.equal((await api('/api/state')).json.drafts.filter(d => d.act_id === act.id).length, 0);
  const ok = await api(`/api/act/${act.id}/confirm`, { expected_updated_at: current.updated_at });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.act.updated_at > current.updated_at);
  assert.equal((await api(`/api/act/${act.id}/confirm`, { expected_updated_at: current.updated_at })).status, 409);
  const repeated = await api(`/api/act/${act.id}/confirm`, {});
  assert.equal(repeated.status, 200);
  assert.equal(repeated.json.draft_id, ok.json.draft_id);
});

for (const route of ['message', 'message/stream']) {
  test(`in-flight ${route} rejects confirmation and releases the guard afterward`, async t => {
    const { api, act, phase, release } = await startServer(t, 'message');
    const ready = phase();
    const message = api(`/api/act/${act.id}/${route}`, { message: '并发测试' });
    await ready;
    const busy = await api(`/api/act/${act.id}/confirm`, {});
    const duplicateMessage = await api(`/api/act/${act.id}/message`, { message: '改成25-34岁女性' });
    release();
    await message;
    assert.equal(busy.status, 409);
    assert.equal(duplicateMessage.status, 409);
    assert.equal((await api(`/api/act/${act.id}/confirm`, {})).status, 200);
  });
  test(`in-flight confirmation rejects ${route} and duplicate confirmation`, async t => {
    const { api, act, phase, release } = await startServer(t, 'confirm');
    const ready = phase();
    const confirmation = api(`/api/act/${act.id}/confirm`, {});
    await ready;
    const busy = await api(`/api/act/${act.id}/${route}`, { message: '改成25-34岁女性' });
    const duplicate = await api(`/api/act/${act.id}/confirm`, {});
    release();
    assert.equal((await confirmation).status, 200);
    assert.equal(busy.status, 409);
    assert.equal(duplicate.status, 409);
    assert.equal((await api(`/api/act/${act.id}/${route}`, { message: '你好' })).status, 200);
  });
}

test('unexpected message errors release the per-act guard', async t => {
  const { api, act } = await startServer(t, 'message');
  assert.equal((await api(`/api/act/${act.id}/message`, { message: '抛错测试' })).status, 500);
  assert.equal((await api(`/api/act/${act.id}/confirm`, {})).status, 200);
});

test('stream errors release the per-act guard', async t => {
  const { api, act } = await startServer(t, 'message');
  const result = await api(`/api/act/${act.id}/message/stream`, { message: '抛错测试' });
  assert.match(result.raw, /test injected failure/);
  assert.equal((await api(`/api/act/${act.id}/confirm`, {})).status, 200);
});
