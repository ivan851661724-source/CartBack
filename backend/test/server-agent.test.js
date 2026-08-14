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
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir },
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
  assert.deepEqual(act.memory, { facts: [], decisions: [], corrections: [] });
  assert.equal(act.context_version, 1);

  const messageResponse = await fetch(baseUrl + `/api/act/${act.id}/message`, {
    method: 'POST', headers,
    body: JSON.stringify({ message: '加购未付客户忘了结账，希望完成付款，给9折优惠' })
  });
  const message = await messageResponse.json();
  assert.equal(messageResponse.status, 200);
  assert.equal('agentMeta' in message, false);

  const metricsResponse = await fetch(baseUrl + '/api/metrics', { headers });
  const metrics = await metricsResponse.json();
  assert.equal(metrics.agent_turns, 1);

  const stateResponse = await fetch(baseUrl + '/api/state', { headers });
  const state = await stateResponse.json();
  const stored = state.acts.find(item => item.id === act.id);
  assert.equal(stored.context_version, 1);
  assert.deepEqual(stored.memory, { facts: [], decisions: [], corrections: [] });
  assert.equal('agentProfile' in state, false);
});
