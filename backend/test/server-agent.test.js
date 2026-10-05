'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../lib/store');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForBootstrap(baseUrl) {
  let lastError;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(baseUrl + '/api/bootstrap');
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not start');
}

test('agent context configuration and metrics work through the HTTP API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-server-agent-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1' },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrap = await waitForBootstrap(baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    'x-local-token': bootstrap.token
  };

  const emptyProfileResponse = await fetch(baseUrl + '/api/agent-profile', { headers });
  assert.deepEqual(await emptyProfileResponse.json(), { profile: {} });

  const directStore = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  directStore.init();
  const localOwner = directStore.getUserByEmail('admin@local');
  directStore.upsertAgentProfile(localOwner.id, { product: '跑鞋', market: '德国' });
  directStore.b.close();

  const savedProfileResponse = await fetch(baseUrl + '/api/agent-profile', { headers });
  assert.deepEqual(await savedProfileResponse.json(), { profile: { product: '跑鞋', market: '德国' } });

  const clearProfileResponse = await fetch(baseUrl + '/api/agent-profile', { method: 'DELETE', headers });
  assert.deepEqual(await clearProfileResponse.json(), { ok: true, profile: {} });
  const clearedProfileResponse = await fetch(baseUrl + '/api/agent-profile', { headers });
  assert.deepEqual(await clearedProfileResponse.json(), { profile: {} });

  const configResponse = await fetch(baseUrl + '/api/config', {
    method: 'POST', headers,
    body: JSON.stringify({
      aiContextWindowTokens: 65536,
      aiMaxOutputTokens: 640,
      aiRecentTurns: 32,
      aiSummaryTriggerRatio: 0.8,
      aiMaxCallsPerTurn: 2,
      aiCriticMode: 'suspicious'
    })
  });
  const configured = await configResponse.json();
  assert.equal(configured.status.aiContextWindowTokens, 65536);
  assert.equal(configured.status.aiMaxOutputTokens, 640);
  assert.equal(configured.status.aiRecentTurns, 32);

  const actResponse = await fetch(baseUrl + '/api/act', {
    method: 'POST', headers, body: '{}'
  });
  const { act } = await actResponse.json();
  // PRD v2 契约：memory 含 extras/prefs/ask_count/clarif_count（C6.5 拉锯保护计数）；act 含 code_status/filled_count
  assert.deepEqual(act.memory, {
    facts: [], decisions: [], corrections: [],
    extras: [], prefs: {},
    ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 },
    clarif_count: { audience: 0, reason: 0, offer: 0, goal: 0 },
    s1_turns: 0, loop_breaks: 0, goal_bare: 0,
    conflicts: []
  });
  assert.equal(act.code_status, 'none');
  assert.equal(act.filled_count, 0);
  assert.equal(act.context_version, 1);

  const messageResponse = await fetch(baseUrl + `/api/act/${act.id}/message`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: '加购未付客户忘了结账，希望完成付款，给9折优惠' })
  });
  const message = await messageResponse.json();
  assert.equal(messageResponse.status, 200);
  assert.equal('agentMeta' in message, false);
  assert.equal(message.needs.audience.value, '加购未付客户', '桩模式抽取落三态契约');
  assert.ok(Array.isArray(message.chips), '非流式响应也应下发 chips');

  const metricsResponse = await fetch(baseUrl + '/api/metrics', { headers });
  const metrics = await metricsResponse.json();
  assert.equal(metrics.agent_turns, 1);

  const stateResponse = await fetch(baseUrl + '/api/state', { headers });
  const state = await stateResponse.json();
  assert.equal(state.engine, 'degraded', '未配 AI key → engine=degraded');
  const stored = state.acts.find(item => item.id === act.id);
  assert.equal(stored.context_version, 1);
  assert.equal(stored.filled_count, 4, 'filled_count 落库计算（一句说全 → 四槽）');
  assert.deepEqual(stored.memory, {
    facts: [], decisions: [], corrections: [],
    extras: [], prefs: {},
    ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 },
    clarif_count: { audience: 0, reason: 0, offer: 0, goal: 0 },
    s1_turns: 0, loop_breaks: 0, goal_bare: 0,
    conflicts: []
  });
  assert.equal(stored.stage, 'S2', '四槽齐 → S2');
  assert.equal('agentProfile' in state, false);
});

test('SSE done frame carries the PRD v2 contract: ok/stage/act/engine/chips', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-server-sse-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1' },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrap = await waitForBootstrap(baseUrl);
  const headers = { 'Content-Type': 'application/json', 'x-local-token': bootstrap.token };

  const actResponse = await fetch(baseUrl + '/api/act', { method: 'POST', headers, body: '{}' });
  const { act } = await actResponse.json();

  const sseResponse = await fetch(baseUrl + `/api/act/${act.id}/message/stream`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: '主要客户是加购未付的人，忘了结账，希望完成付款，给9折优惠' })
  });
  assert.equal(sseResponse.status, 200);
  const raw = await sseResponse.text();
  const frames = raw.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  const types = frames.map(f => f.type);
  assert.equal(types[0], 'start', 'SSE 首帧 start');
  assert.ok(types.includes('token'), '桩模式走 3 字打字机 token 帧');
  const done = frames.find(f => f.type === 'done');
  assert.ok(done, 'SSE 收尾 done 帧');
  // PRD v2 done 帧契约：保留 result，新增 ok/stage/act/engine/chips 四字段
  assert.equal(done.ok, true);
  assert.equal(done.stage, 'S2');
  assert.equal(done.engine, 'degraded', '未配 AI key → done.engine=degraded');
  assert.deepEqual(done.chips, [], '四槽已齐 → chips=[]');
  assert.ok(done.result && typeof done.result.reply === 'string', 'result 字段保留（向后兼容）');
  // act 序列化含新契约
  assert.equal(done.act.id, act.id);
  assert.equal(done.act.filled_count, 4);
  assert.equal(done.act.code_status, 'none');
  assert.equal(done.act.needs.audience.value, '加购未付客户');
  assert.equal(done.act.needs.audience.source, 'explicit');
  assert.equal(done.act.needs.offer.value, '9折优惠');
  assert.ok(Array.isArray(done.act.memory.extras), 'act.memory 新契约 extras');
  assert.deepEqual(done.act.memory.ask_count, { audience: 0, reason: 0, offer: 0, goal: 0 });
  // 落库先行：done 帧的 act 与 store 读出一致
  const stateResponse = await fetch(baseUrl + '/api/state', { headers });
  const state = await stateResponse.json();
  const stored = state.acts.find(item => item.id === act.id);
  assert.equal(stored.filled_count, 4, 'B3：handle 返回前已落库（/api/state 可见）');
});
