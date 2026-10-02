'use strict';
/**
 * Wave 2 E2/D2 HTTP 端到端（spawn 真进程 + mock 店铺连接器注入缝）：
 *   E2 四分支：真实建码 created / 建码失败 409 三出口 / 自带码 reused / 未连接 none 无钩子卡
 *   共同红线：卡面绝不出现未真实存在的折扣码
 *   D2 改参回流：S3 correction → 回 S2 快照作废（发送被闸门⑤拦截）；S2 correction 停留 S2
 *   closed 触发点：新建会话把旧的无 closed act 置 closed
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const execution = require('../lib/execution');

// 与子进程同口径的「窗口内」假时钟（纽约 10-18 点）
function inWindowFakeNow() {
  let ts = Date.now();
  for (let i = 0; i < 30; i++) {
    const h = execution.localHourIn('America/New_York', ts);
    if (h >= 10 && h <= 18) return ts;
    ts += 3600 * 1000;
  }
  return ts;
}

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

/** spawn 一个 CartBack 服务（mock/无连接器由 configFile 提供），返回 api 客户端 */
async function startServer(t, configObj, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-confirm-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configObj || {}));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1', CARTBACK_FAKE_NOW: String(inWindowFakeNow()), ...extraEnv },
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
  return { api, base };
}

/** 桩模式把四槽聊满（preset audience + 三句），返回 act */
async function fillFourSlots(api, actId) {
  let r = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静了' } });
  assert.equal(r.json.needs.reason != null, true, 'reason 已采集');
  r = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '折扣给 12% off 就行' } });
  r = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });
  const filled = ['audience', 'reason', 'offer', 'goal'].every(s => r.json.needs[s]);
  assert.ok(filled, '四槽应已聊满：' + JSON.stringify(r.json.needs));
  return r.json.act;
}

test('E2 分支①：确认先真实建码成功 → 卡带店铺回执码、快照冻结、S3、checklist 恒 5 项', async (t) => {
  const { api } = await startServer(t, { stores: [{ type: 'mock', shop: 'E2E Mock' }], publicBaseUrl: 'https://e2e.example' });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });

  // closed 触发点：旧的无 closed act 在新建会话时被归档
  const first = await api('/api/act', { method: 'POST', body: {} });
  const act2 = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const acts0 = (await api('/api/state')).json.acts;
  assert.equal(acts0.find(a => a.id === first.json.act.id).stage, 'closed', '新建会话 → 旧 act 置 closed');

  const actId = act2.json.act.id;
  await fillFourSlots(api, actId);

  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200);
  const b = cf.json;
  assert.equal(b.ok, true);
  assert.equal(b.act.stage, 'S3');
  assert.equal(b.act.code_status, 'created');
  // 卡面：码来自店铺连接器真实回执（COMEBACK-XXXXXX），且与 coupon/coupon 行一致
  assert.match(b.planCard.discount.code, /^COMEBACK-[A-Z0-9]{6}$/);
  assert.match(b.planCard.discount.text, /已在你的店铺创建/);
  assert.equal(b.planCard.coupon, b.planCard.discount.code);
  assert.equal(b.planCard.discount.code_status, 'created');
  assert.equal('pain' in b.planCard, false, 'pain 旧键已删除');
  assert.ok(b.planCard.reason, 'reason 单键保留');
  // estGmv 结构（D3 公式：people × aov × 12% − 折扣成本；无客单价 extras → source=demo）
  assert.equal(b.planCard.estGmv.currency, 'USD');
  assert.equal(b.planCard.estGmv.source, 'demo');
  assert.equal(b.planCard.estGmv.formula.rate, 0.12);
  const f = b.planCard.estGmv.formula;
  assert.ok(Math.abs(b.planCard.estGmv.amount - (f.people * f.aov * f.rate - f.discount_cost)) < 0.01, 'estGmv 与公式自洽');
  // checklist 契约：恒 5 项、固定顺序、holdout 预览不落库
  assert.deepEqual(b.checklist.items.map(i => i.gate), ['window', 'frequency', 'whitelabel', 'unsubscribe', 'amount_code']);
  assert.equal(b.checklist.all_pass, true);
  assert.deepEqual(b.checklist.holdout, { frozen: false, count: 0, ratio: 0.1, note: b.checklist.holdout.note });
  assert.equal(b.checklist.holdout.note.includes('冻结'), true);
  assert.equal(b.holdout.frozen, false);
  // draft 服务端同源：四字段（audience/discount/count/estGmv）与卡逐字段相等（diff=0）
  assert.ok(b.draft_id && b.planCard.draft_id === b.draft_id);
  assert.equal(b.draft.coupon, b.planCard.discount.code);
  assert.equal(b.draft.discount, b.planCard.discount.percent_off);
  assert.equal(b.draft.matchedCount, b.planCard.reach_count);
  assert.equal(b.draft.estGmv, b.planCard.estGmv.amount);
  assert.equal(b.draft.audience, b.planCard.audience);
  assert.equal(b.draft.act_id, actId);

  // 幂等重确认：不重复建码，回同一张卡与同一封草稿
  const again = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.json.planCard.discount.code, b.planCard.discount.code);
  assert.equal(again.json.draft_id, b.draft_id);
});

test('E2 分支②：店铺建码失败 → 409 不出卡、三出口、停留 S2；nohook 重试出无钩子卡', async (t) => {
  const { api } = await startServer(t, { stores: [{ type: 'mock', shop: 'E2E', createFails: true }], publicBaseUrl: 'https://e2e.example' });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const actId = act.json.act.id;
  await fillFourSlots(api, actId);

  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 409);
  const b = cf.json;
  assert.equal(b.ok, false);
  assert.equal(b.code_status, 'failed');
  assert.ok(b.reason && /建码失败/.test(b.reason), '明示中文原因');
  assert.deepEqual(b.options, ['重试建码', '改用店内现成码', '改发无钩子提醒信']);
  assert.equal(b.act.stage, 'S2', '失败停留 S2');
  assert.equal(b.planCard, undefined, '不出 planCard');
  assert.equal(b.draft, undefined, '不建 draft');

  // 无钩子重试出口：跳过建码出无钩子卡
  const retry = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: { nohook: true } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.act.stage, 'S3');
  assert.equal(retry.json.act.code_status, 'none');
  assert.equal(retry.json.planCard.discount.code, null);
  assert.ok(/无钩子/.test(retry.json.planCard.discount.note || ''));
  assert.equal(retry.json.planCard.coupon, '');
  assert.ok(!/COMEBACK-/i.test(JSON.stringify(retry.json.planCard)), '无钩子卡无假码');
  assert.equal(retry.json.draft.coupon, '');
});

test('E2 分支③：自带码 reuse_code → 校验存在且有效 reused；不存在的码 409', async (t) => {
  const { api } = await startServer(t, { stores: [{ type: 'mock', shop: 'E2E', codes: { SAVE10: { percent_off: 10 } } }], publicBaseUrl: 'https://e2e.example' });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const actId = act.json.act.id;
  await fillFourSlots(api, actId);

  const bad = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: { reuse_code: 'NOTEXIST' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code_status, 'failed');
  assert.ok(/没有找到/.test(bad.json.reason));
  assert.deepEqual(bad.json.options, ['重试建码', '改用店内现成码', '改发无钩子提醒信']);

  const ok = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: { reuse_code: 'save10' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.act.code_status, 'reused');
  assert.equal(ok.json.planCard.discount.code, 'SAVE10');
  assert.equal(ok.json.planCard.discount.code_status, 'reused');
  assert.equal(ok.json.planCard.discount.percent_off, 10);
  assert.ok(/现成码/.test(ok.json.planCard.discount.text));
  assert.equal(ok.json.draft.coupon, 'SAVE10');
});

test('E2 分支④：未连接店铺 → 过渡期出无钩子卡（明示可补）、发送链路保留', async (t) => {
  const { api } = await startServer(t, { publicBaseUrl: 'https://e2e.example' });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const actId = act.json.act.id;
  await fillFourSlots(api, actId);

  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200);
  assert.equal(cf.json.act.code_status, 'none');
  assert.equal(cf.json.planCard.discount.code, null);
  assert.ok(/未创建折扣码：连接店铺后可补/.test(cf.json.planCard.discount.note || ''));
  assert.ok(!/COMEBACK-/i.test(JSON.stringify(cf.json.planCard)), '未连接店铺绝不出现假码');
  assert.ok(cf.json.draft_id, '发送入口保留（draft 已生成）');
});

test('D2 改参回流：S3 correction → 回 S2 快照作废、发送被闸门⑤拦截；S2 correction 停留 S2', async (t) => {
  const { api } = await startServer(t, { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: 'https://e2e.example' });
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const actId = act.json.act.id;
  await fillFourSlots(api, actId);
  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200);
  const draftId = cf.json.draft_id;

  // S3 correction → 回 S2，快照/卡作废
  const adj = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '受众改成老客，其它不动' } });
  assert.equal(adj.json.stage, 'S2', 'S3 改参回 S2');
  const actNow = (await api('/api/state')).json.acts.find(a => a.id === actId);
  assert.equal(actNow.execution_snapshot, null, 'execution_snapshot 作废');
  assert.equal(actNow.plan_card, null, 'plan_card 作废');

  // 旧 draft 发送 → 闸门⑤拦截（快照缺失），409 {ok:false, checklist}
  const send = await api(`/api/draft/${draftId}/send`, { method: 'POST', body: {} });
  assert.equal(send.status, 409);
  assert.equal(send.json.ok, false);
  assert.equal(send.json.checklist.items.length, 5, '409 也回恒 5 项 checklist');
  const amount = send.json.checklist.items.find(i => i.gate === 'amount_code');
  assert.equal(amount.pass, false);
  assert.ok(/快照/.test(amount.reason));

  // S2 correction：停留 S2、needs 解冻更新
  const act2 = await api('/api/act', { method: 'POST', body: { preset: { audience: '浏览未买' } } });
  const act2Id = act2.json.act.id;
  await api(`/api/act/${act2Id}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静' } });
  await api(`/api/act/${act2Id}/message`, { method: 'POST', body: { message: '折扣给 10% off' } });
  await api(`/api/act/${act2Id}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });
  const corr = await api(`/api/act/${act2Id}/message`, { method: 'POST', body: { message: '折扣改成包邮，其它不动' } });
  assert.equal(corr.json.stage, 'S2', 'S2 correction 停留 S2（不回 S1、不进 S3）');
  assert.equal(corr.json.needs.offer.value, '包邮', 'needs 解冻更新');
});
