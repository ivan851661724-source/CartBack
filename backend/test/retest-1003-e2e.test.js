'use strict';

/**
 * 复测报告（2026-10-03）P0 主链 HTTP 端到端（spawn 真进程 + mock AI 端点）：
 *  - P0-N4 契约：POST /api/act 顶层下发 chips / welcome / store_banner（前端不再丢弃）
 *  - P0-N2 后端配套：满 4/4 当轮 S2 无码预览卡落库（act.plan_card.preview）→ /api/state 可召回（A2 刷新续卡）
 *  - P1-N1 在线路径：冲突决议轮答复同轮 explicit 入槽 + corrections 记账 + 不再挂新冲突反问
 *  - P2-N1 契约：goal 槽 done 帧 chips 4 项（含「我自己定」）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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

/** OpenAI 兼容 mock 端点：按用户消息返回 envelope JSON（reply + slot_updates） */
function startMockAI() {
  const envelopeFor = (userText) => {
    const updates = [];
    if (/年轻人/.test(userText)) updates.push({ slot: 'audience', value: '年轻人', confidence: 0.9 });
    if (/25-34/.test(userText)) updates.push({ slot: 'audience', value: '25-34岁', confidence: 0.9 });
    if (/太久|没动静/.test(userText)) updates.push({ slot: 'reason', value: '太久没动静、快被遗忘', confidence: 0.9 });
    if (/% off|折扣/.test(userText)) updates.push({ slot: 'offer', value: '12% off', confidence: 0.9 });
    if (/完成付款/.test(userText)) updates.push({ slot: 'goal', value: '促使完成付款 / 结账', confidence: 0.9 });
    return { reply: '记下了。', slot_updates: updates, extras: [], corrections: [] };
  };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let userText = '';
        try {
          const j = JSON.parse(body);
          const msgs = (j.messages || []).filter((m) => m.role === 'user');
          userText = msgs.length ? String(msgs[msgs.length - 1].content || '') : '';
        } catch (e) { /* ignore */ }
        const payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify(envelopeFor(userText)) } }] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
  });
}

async function startServer(t, mockAiPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retest-1003-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1',
      CARTBACK_AI_KEY: 'mock-key', CARTBACK_AI_BASE_URL: `http://127.0.0.1:${mockAiPort}`, CARTBACK_AI_MODEL: 'mock-model',
    },
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
  return { api };
}

test('P0 主链 E2E：建会话契约 + 满4/4预览卡落库可召回 + 冲突决议同轮落库', async (t) => {
  const mock = await startMockAI();
  t.after(() => mock.server.close());
  const { api } = await startServer(t, mock.port);

  // —— P0-N4：POST /api/act 顶层 chips / welcome / store_banner ——
  const created = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付客户' } } });
  assert.equal(created.status, 200);
  assert.ok(Array.isArray(created.json.chips) && created.json.chips.length >= 3, '开场 chips 顶层下发');
  assert.ok(created.json.chips.includes('我自己说'), '开场 chips 含自由输入出口');
  assert.equal(typeof created.json.welcome, 'boolean');
  assert.ok(created.json.store_banner && typeof created.json.store_banner === 'object');
  const actId = created.json.act.id;
  assert.equal(created.json.act.needs.audience.value, '加购未付客户', 'preset audience 已入槽');

  // 采集 reason → S1 冲突轮 + 决议轮（复测报告 P1-N1 场景）→ 采满 offer/goal
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静了' } });

  // —— P1-N1 在线路径：冲突轮 + 决议轮同轮落库 ——
  const conflictRound = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '客户主要是年轻人' } });
  assert.equal(conflictRound.json.needs.audience.value, '加购未付客户', '冲突轮不覆盖现值');
  assert.deepEqual(conflictRound.json.chips, ['18-24', '25-34', '维持当前年龄定位'], '冲突澄清 chips（C6）');
  assert.equal(conflictRound.json.askedSlot, 'audience');

  const resolveRound = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '按 25-34 吧' } });
  assert.equal(resolveRound.json.needs.audience.value, '25-34岁', '决议与回复同轮落库（B3）');
  assert.equal(resolveRound.json.askedSlot, 'goal', '冲突已解决 → 顺延问下一缺失槽（一轮一问；offer 已问过不优先）');
  const st2 = await api('/api/state');
  const act2 = (st2.json.acts || []).find(a => a.id === actId);
  assert.ok((act2.memory.corrections || []).some(c => c.slot === 'audience' && c.new === '25-34岁'), 'corrections 记账');

  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '折扣给 12% off 就行' } });
  const goalRound = await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });
  assert.equal(goalRound.json.stage, 'S2', '四要素齐 → S2');
  assert.ok(goalRound.json.planCard, '满 4/4 当轮 done 响应带预览卡（D1）');
  assert.equal(goalRound.json.planCard.discount && goalRound.json.planCard.discount.code_status, 'pending', '无码预览卡（E2 先建码后出卡）');

  // —— P0-N2 后端配套：预览卡落库（preview 标记）→ /api/state 召回 ——
  const st = await api('/api/state');
  const persistedAct = (st.json.acts || []).find(a => a.id === actId);
  assert.ok(persistedAct, 'act 在列表');
  assert.ok(persistedAct.plan_card, 'S2 预览卡已落库（刷新后前端可召回确认卡）');
  assert.equal(persistedAct.plan_card.preview, true, '预览卡带 preview 标记');
  assert.equal(st.json.last_plan, null, '未确认会话不污染 last_plan（Z4）');
});
