'use strict';
/**
 * Wave 2 发送闸门 HTTP 端到端（spawn 真进程）：
 *   D4② 频次闸：72h 内同活动已触达 → 第二场 409 {ok:false, checklist}
 *   D4① 时段闸：窗口外 → 202 缓发（jobs 带 run_after/scheduled_at，非永久拒绝、不落 sends）
 *   D3 快照强制：无 confirm 快照的草稿（legacy planCard 直传）→ 闸门⑤拦截，发不出去
 *   demo 仿真发送也逐收件人落 sends（gate_snapshot 留痕）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const execution = require('../lib/execution');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

function fakeNowAtHour(nyHour) {
  let ts = Date.now();
  for (let i = 0; i < 36; i++) {
    if (execution.localHourIn('America/New_York', ts) === nyHour) return ts;
    ts += 3600 * 1000;
  }
  return ts;
}

async function startServer(t, { configObj = {}, fakeHour = 12 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-send-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configObj));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1', CARTBACK_FAKE_NOW: String(fakeNowAtHour(fakeHour)) },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  for (let i = 0; i < 40 && !token; i++) {
    try {
      const r = await fetch(base + '/api/bootstrap');
      if (r.ok) token = (await r.json()).token || '';
    } catch (e) { /* retry */ }
    if (!token) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(token, 'server booted');
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-local-token': token },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 1500))]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { api, dir, base };
}

async function fillAndConfirm(api, preset) {
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: preset } } });
  const actId = act.json.act.id;
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静了' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '折扣给 12% off 就行' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });
  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200, 'confirm ok: ' + JSON.stringify(cf.json).slice(0, 200));
  return cf.json;
}

async function waitFor(api, jobId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await api(`/api/jobs/${jobId}`);
    if (['done', 'failed'].includes(j.json.status)) return j.json;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor job timeout');
}

test('D4② 频次闸：72h 内同活动已触达 → 第二场 409（demo 仿真发送同样落 sends）', async (t) => {
  const { api, dir } = await startServer(t, {
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: '' }
  });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });

  // 第一场：确认 + 发送（demo 仿真；未付族种子 9 人）
  const c1 = await fillAndConfirm(api, '加购未付');
  assert.equal(c1.planCard.discount.code_status, 'created');
  const s1 = await api(`/api/draft/${c1.draft_id}/send`, { method: 'POST', body: {} });
  assert.equal(s1.status, 202);
  const job1 = await waitFor(api, s1.json.job_id);
  assert.equal(job1.status, 'done');
  assert.equal(job1.result.recipients, 9, '未付族（加购未付×4+弃购×3+下单未付×2）实发 9 人');

  // demo 仿真发送也逐收件人落 sends（gate_snapshot 留痕）
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const sends1 = db.prepare('SELECT * FROM sends WHERE campaign_id = ?').all(c1.draft_id);
  assert.equal(sends1.length, 9, 'sends 行数 = 实发数');
  assert.ok(sends1.every(r => r.status === 'sent' && r.gate_snapshot && r.tz), 'gate_snapshot/tz 留痕');
  db.close();

  // 第二场：同受众新会话新方案 → 频次闸 409
  const c2 = await fillAndConfirm(api, '加购未付');
  assert.equal(c2.planCard.discount.code_status, 'created');
  const s2 = await api(`/api/draft/${c2.draft_id}/send`, { method: 'POST', body: {} });
  assert.equal(s2.status, 409, '第二场被频次闸拦截');
  assert.equal(s2.json.ok, false);
  assert.deepEqual(s2.json.checklist.items.map(i => i.gate), ['window', 'frequency', 'whitelabel', 'unsubscribe', 'amount_code']);
  const freq = s2.json.checklist.items.find(i => i.gate === 'frequency');
  assert.equal(freq.pass, false);
  assert.ok(/72 小时/.test(freq.reason));
  assert.ok(s2.json.checklist.all_pass === false);
});

test('D4① 时段外且退订配置缺失 → 202 定时发送（不落 sends、不冻 holdout）', async (t) => {
  const { api, dir } = await startServer(t, {
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: '' },
    fakeHour: 3   // 纽约凌晨 3 点 → 时段闸不过
  });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const c = await fillAndConfirm(api, '加购未付');
  // confirm 预检返回时段闸不过（200 仍出卡 —— 闸门只在发送时拦截/缓发）
  const w = c.checklist.items.find(i => i.gate === 'window');
  assert.equal(w.pass, false);
  const unsubscribe = c.checklist.items.find(i => i.gate === 'unsubscribe');
  assert.equal(unsubscribe.pass, false);
  assert.equal(unsubscribe.blocking, false);

  const s = await api(`/api/draft/${c.draft_id}/send`, { method: 'POST', body: {} });
  assert.equal(s.status, 202, '时段闸不过 → 缓发（非 409 永久拒绝）');
  assert.equal(s.json.queued, true);
  assert.equal(s.json.deferred, 'window');
  assert.ok(s.json.scheduled_at > Date.now(), 'scheduled_at 在未来（下一合理时段）');
  assert.equal(s.json.checklist.items.find(i => i.gate === 'window').pass, false);

  const job = await api(`/api/jobs/${s.json.job_id}`);
  assert.equal(job.json.status, 'pending', '缓发任务挂起等待到点');
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(s.json.job_id);
  assert.equal(Number(row.run_after), s.json.scheduled_at, 'jobs.run_after = scheduled_at');
  const sends = db.prepare('SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ?').get(c.draft_id);
  const holds = db.prepare('SELECT COUNT(*) AS n FROM holdouts WHERE campaign_id = ?').get(c.draft_id);
  db.close();
  assert.equal(sends.n, 0, '缓发不落 sends');
  assert.equal(holds.n, 0, '缓发不冻结 holdout');
  const draft = (await api('/api/drafts')).json.drafts.find(d => d.id === c.draft_id);
  assert.equal(draft.status, 'queued');
});

test('D3 快照强制：legacy planCard 直传的草稿（无 confirm 快照）→ 闸门⑤拦截 409', async (t) => {
  const { api } = await startServer(t, {
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: 'https://e2e.example' }
  });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  // 前端回传 planCard（无 actId）→ 兼容路径可出草稿，但没有执行快照
  const dr = await api('/api/draft', {
    method: 'POST',
    body: { planCard: { subject: 'legacy', body: 'legacy', discount: 12, coupon: 'BACK12', audience: '加购未付', brand: 'MyBrand', skip_image: true } }
  });
  assert.equal(dr.status, 200);
  const draftId = dr.json.draft.id;
  assert.equal(dr.json.draft.act_id, null);

  const s = await api(`/api/draft/${draftId}/send`, { method: 'POST', body: {} });
  assert.equal(s.status, 409, '没有执行快照 → 闸门⑤拦截（D3：不再信任前端回传）');
  assert.equal(s.json.ok, false);
  const amount = s.json.checklist.items.find(i => i.gate === 'amount_code');
  assert.equal(amount.pass, false);
  assert.ok(/快照/.test(amount.reason));
});
