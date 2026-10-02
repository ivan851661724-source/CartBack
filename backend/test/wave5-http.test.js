'use strict';

/**
 * Wave 5 HTTP 契约测试（前端并行开发的接口样例）：
 *   1. POST /api/config body {prefs:{...}} → 持久化 user 级偏好；GET /api/state 顶层 prefs 合并回读
 *      （与 g0Whitelist 等全局键并列，互不影响）。
 *   2. A4 僵尸会话收口链路：GET /api/state 顶层 todos（{id,summary,act_id,created_at,done}）；
 *      POST /api/todos/:id/resume → {ok, act}（needs/memory 预填、stage=S1）；幂等：已 done 再 resume → 409。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('../lib/store');
const zombie = require('../lib/zombie');

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
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(baseUrl + '/api/bootstrap');
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not start');
}

test('wave5 HTTP：prefs 写入回读 + todos/resume 契约 + 幂等 409', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-wave5-http-'));
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

  // —— 1. 偏好写入（POST /api/config prefs，与全局键并列）——
  const cfgRes = await fetch(baseUrl + '/api/config', {
    method: 'POST', headers,
    body: JSON.stringify({ prefs: { tone: '亲切口语', discount_habit: '小额阶梯券', signature: 'LunaGlow' } })
  });
  assert.equal(cfgRes.status, 200);
  assert.equal((await cfgRes.json()).status.mode, 'demo', 'config 响应形状不变（status）');

  const state1 = await (await fetch(baseUrl + '/api/state', { headers })).json();
  assert.ok(state1.prefs, 'GET /api/state 顶层 prefs');
  assert.equal(state1.prefs.tone, '亲切口语', '保存后回读验证 tone');
  assert.equal(state1.prefs.discount_habit, '小额阶梯券', '保存后回读验证 discount_habit');
  assert.equal(state1.prefs.signature, 'LunaGlow', '保存后回读验证 signature');

  // 键级合并更新 + 空串删除
  await fetch(baseUrl + '/api/config', {
    method: 'POST', headers,
    body: JSON.stringify({ prefs: { tone: '正式一点', signature: '' } })
  });
  const state2 = await (await fetch(baseUrl + '/api/state', { headers })).json();
  assert.equal(state2.prefs.tone, '正式一点', 'prefs 键级合并更新');
  assert.equal(state2.prefs.discount_habit, '小额阶梯券', '未提及的键保留');
  assert.equal(state2.prefs.signature, undefined, '空串值 = 删除该键');

  // —— 2. A4：建会话 → 填两槽 → 直改库回拨活跃时间 → 跑扫描 → state.todos → resume ——
  const actRes = await fetch(baseUrl + '/api/act', { method: 'POST', headers, body: '{}' });
  const { act } = await actRes.json();
  await fetch(baseUrl + `/api/act/${act.id}/message`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: '针对加购未付客户' })
  });
  await fetch(baseUrl + `/api/act/${act.id}/message`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: '因为他们太久没动静了' })
  });

  // 直连同一 sqlite：回拨 updated_at（>48h）→ 扫描收口（独立函数可被直接调用；server 每小时跑）
  const direct = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  direct.init();
  const stale = direct.getAct(act.id);
  stale.updated_at = Date.now() - 49 * 3600 * 1000;
  direct.upsertAct(stale);
  const closed = zombie.sweepZombieActs(direct, { now: Date.now() });
  assert.equal(closed.length, 1, '扫描收口该会话');
  assert.equal(direct.getAct(act.id).stage, 'closed');
  const summary = closed[0].summary;
  assert.ok(/已记录受众与原因/.test(summary) && /还差/.test(summary) && !/\d/.test(summary), `待办文案：${summary}`);
  direct.b.close();

  const state3 = await (await fetch(baseUrl + '/api/state', { headers })).json();
  assert.ok(Array.isArray(state3.todos), '契约①：state 顶层 todos');
  const todo = state3.todos.find(x => x.act_id === act.id);
  assert.ok(todo, '收口待办进商家待办列表');
  assert.equal(todo.done, 0);
  assert.equal(todo.summary, summary);
  assert.ok(todo.id && todo.created_at, 'todo 契约形状 {id, summary, act_id, created_at, done}');

  // 点待办 → resume：{ok, act}，needs/memory 预填、stage=S1
  const resumeRes = await fetch(baseUrl + `/api/todos/${todo.id}/resume`, { method: 'POST', headers });
  assert.equal(resumeRes.status, 200);
  const resumed = await resumeRes.json();
  assert.equal(resumed.ok, true, '契约②：{ok, act}');
  assert.ok(resumed.act && resumed.act.id && resumed.act.id !== act.id, '开新 act');
  assert.equal(resumed.act.stage, 'S1', '新 act stage=S1');
  assert.equal(resumed.act.needs.audience.value, '加购未付客户', 'needs 预填（进度保留）');
  assert.ok(/太久没动静/.test(resumed.act.needs.reason.value), 'needs 预填（进度保留）');
  assert.ok(resumed.act.messages.some(m => m.role === 'assistant' && m.content.includes('接着上次的进度')), '开场复述进度');

  // 幂等：已 done 再 resume → 409
  const resume2 = await fetch(baseUrl + `/api/todos/${todo.id}/resume`, { method: 'POST', headers });
  assert.equal(resume2.status, 409, 'resume 幂等：已 done → 409');

  // 待办置 done 后不再出现在 state.todos
  const state4 = await (await fetch(baseUrl + '/api/state', { headers })).json();
  assert.ok(!state4.todos.some(x => x.id === todo.id), 'done 待办不出现在待办列表');

  // 未知待办 → 404
  const resume404 = await fetch(baseUrl + '/api/todos/todo_missing/resume', { method: 'POST', headers });
  assert.equal(resume404.status, 404);
});
