'use strict';
/**
 * GET /api/act/:id/checklist —— 复测 10-06 P2 回归：
 * 刷新恢复时前端对已准备方案卡现算拉取发送核对单；在此之前发送按钮禁用。
 * 断言：S3 幂等口径与 confirm 重复确认一致 / S2 未准备 409 / closed 归档 409 / 越权 404。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Store } = require('../lib/store');

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-checklist-ep-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1' },
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
  const api = (url, body) => fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-local-token': token },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  const created = await api('/api/act', {});
  const act = created.json.act;
  const db = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  db.init();
  act.stage = 'S2';
  act.needs = { audience: '18-24岁女性', reason: '忘记结账', offer: '无额外优惠', goal: '挽回100单' };
  db.upsertAct(act);
  db.b.close();
  return {
    api, act,
    update: change => {
      const d = new Store({ dbFile: path.join(dir, 'data.sqlite') });
      d.init();
      const current = d.getAct(act.id);
      change(current);
      d.upsertAct(current);
      d.b.close();
      return current;
    }
  };
}

test('checklist endpoint re-evaluates a prepared plan without side effects', async t => {
  const { api, act } = await startServer(t);
  // 未准备（S2）→ 409 明示原因，不吐核对单
  const before = await api(`/api/act/${act.id}/checklist`);
  assert.equal(before.status, 409);
  assert.match(before.json.error, /还没有已准备的发送方案/);
  assert.equal((await api('/api/state')).json.drafts.filter(d => d.act_id === act.id).length, 0);

  const ok = await api(`/api/act/${act.id}/confirm`, {});
  assert.equal(ok.status, 200);
  assert.ok(ok.json.checklist?.items?.length);

  const again = await api(`/api/act/${act.id}/checklist`);
  assert.equal(again.status, 200);
  assert.ok(again.json.ok);
  assert.equal(Array.isArray(again.json.checklist.items), true);
  assert.equal(again.json.checklist.items.length, ok.json.checklist.items.length);
  assert.equal(again.json.draft_id, ok.json.draft_id);
  // 只读：不产生新草稿、不推进 stage
  const state = (await api('/api/state')).json;
  assert.equal(state.drafts.filter(d => d.act_id === act.id).length, 1);
  assert.equal(state.acts.find(a => a.id === act.id).stage, 'S3');
  // 与重复 confirm 的幂等口径一致：同一草稿、同一通过数
  const repeated = await api(`/api/act/${act.id}/confirm`, {});
  assert.equal(repeated.status, 200);
  assert.equal(repeated.json.draft_id, again.json.draft_id);
  assert.equal(repeated.json.checklist.items.length, again.json.checklist.items.length);
});

test('checklist endpoint refuses archived sessions and unknown acts', async t => {
  const { api, act, update } = await startServer(t);
  const ok = await api(`/api/act/${act.id}/confirm`, {});
  assert.equal(ok.status, 200);
  update(a => { a.stage = 'closed'; });
  const closed = await api(`/api/act/${act.id}/checklist`);
  assert.equal(closed.status, 409);
  assert.match(closed.json.error, /归档/);
  const missing = await api('/api/act/act_does_not_exist/checklist');
  assert.equal(missing.status, 404);
});
