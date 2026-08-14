'use strict';

/**
 * 安全行为测试：默认（安全）模式 vs 开放本地模式（CARTBACK_OPEN_LOCAL=1）。
 * 覆盖：bootstrap 不泄 token、未鉴权 403、注册/登录会话、webhook secret 校验、CSV 引号字段。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

/** 起一个隔离 server；返回 { baseUrl, dir, stop } */
async function startServer(openLocal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-sec-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), EY_SERVER_DIR: dir };
  if (openLocal) env.CARTBACK_OPEN_LOCAL = '1';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'ignore'
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForBootstrap(baseUrl);
  const stop = async () => {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { baseUrl, dir, stop };
}

test('默认模式：bootstrap 不下发 token，未鉴权业务端点一律 403', async () => {
  const { baseUrl, dir, stop } = await startServer(false);
  try {
    const boot = await (await fetch(baseUrl + '/api/bootstrap')).json();
    assert.equal(boot.token, null, '安全模式下 bootstrap 必须返回 token:null');

    for (const [pathname, init] of [
      ['/api/state', {}],
      ['/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
      ['/api/audience', {}]
    ]) {
      const res = await fetch(baseUrl + pathname, init);
      assert.equal(res.status, 403, pathname + ' 未鉴权应 403');
    }

    // 即使拿到 localToken（如从配置文件泄露），未开启开放模式时 x-local-token 也不得鉴权
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const res = await fetch(baseUrl + '/api/state', { headers: { 'x-local-token': cfg.localToken } });
    assert.equal(res.status, 403, '默认模式下 x-local-token 不得作为凭证');
  } finally {
    await stop();
  }
});

test('注册 → 会话 cookie → 业务端点放行；登出后会话失效', async () => {
  const { baseUrl, stop } = await startServer(false);
  try {
    // 弱密码应被拒
    const weak = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sec-test@example.com', password: 'short', name: 'T' })
    });
    assert.equal(weak.status, 400);

    const reg = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sec-test@example.com', password: 'passw0rd123', name: '安全测试' }),
      redirect: 'manual'
    });
    assert.equal(reg.status, 200);
    const setCookie = reg.headers.get('set-cookie') || '';
    assert.match(setCookie, /cb_session=/, '注册应签发会话 cookie');
    assert.match(setCookie, /HttpOnly/, 'cookie 必须 HttpOnly');
    assert.doesNotMatch(setCookie, /Secure/, '默认（本地 http）不加 Secure');

    const cookie = setCookie.split(';')[0];
    const state = await fetch(baseUrl + '/api/state', { headers: { cookie } });
    assert.equal(state.status, 200, '会话 cookie 应放行业务端点');

    // 重复注册同邮箱 → 409
    const dup = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sec-test@example.com', password: 'passw0rd123', name: 'X' })
    });
    assert.equal(dup.status, 409);

    // 登出 → 会话删除 → 再访问 403
    await fetch(baseUrl + '/api/auth/logout', { method: 'POST', headers: { cookie } });
    const after = await fetch(baseUrl + '/api/state', { headers: { cookie } });
    assert.equal(after.status, 403, '登出后会话必须立即失效');
  } finally {
    await stop();
  }
});

test('连续登录失败 5 次锁定 15 分钟（429）', async () => {
  const { baseUrl, stop } = await startServer(false);
  try {
    // 先注册
    await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'lock@example.com', password: 'passw0rd123', name: 'L' })
    });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(baseUrl + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'lock@example.com', password: 'wrongpass1' })
      });
      last = res.status;
      if (i < 4) assert.equal(res.status, 401, '前 5 次失败应 401');
    }
    assert.equal(last, 429, '第 5 次失败后锁定，应 429');
  } finally {
    await stop();
  }
});

test('attribution webhook：错误 secret 401，正确 secret 写入事件', async () => {
  const { baseUrl, dir, stop } = await startServer(false);
  try {
    const body = JSON.stringify({ type: 'open', draft_id: 'dr_x', value: 0 });
    const bad = await fetch(baseUrl + '/api/attribution', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'wrong' },
      body
    });
    assert.equal(bad.status, 401, 'webhook secret 错误应 401');

    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const ok = await fetch(baseUrl + '/api/attribution', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': cfg.webhookSecret },
      body
    });
    assert.equal(ok.status, 200);
  } finally {
    await stop();
  }
});

test('CSV 导入支持 RFC4180 引号字段（内含逗号/转义引号）', async () => {
  const { baseUrl, dir, stop } = await startServer(true); // 开放模式便于导入
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const auth = { 'Content-Type': 'application/json', 'x-local-token': cfg.localToken };
    const csv = 'name,email,intent,abandoned_value\n'
      + '"Doe, John",john@example.com,加购未付,128\n'
      + '"He said ""hi""",quoted@example.com,弃购,88\n';
    const res = await fetch(baseUrl + '/api/audience/import', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ csv })
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.imported, 2, '两行均应导入');
    const aud = await (await fetch(baseUrl + '/api/audience', { headers: auth })).json();
    const john = aud.audience.find(a => a.email === 'john@example.com');
    assert.equal(john.name, 'Doe, John', '引号内逗号应保留');
    const quoted = aud.audience.find(a => a.email === 'quoted@example.com');
    assert.equal(quoted.name, 'He said "hi"', '转义引号 "" 应还原为单个 "');
  } finally {
    await stop();
  }
});
