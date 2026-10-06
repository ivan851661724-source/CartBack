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

/** 起一个隔离 server；返回 { baseUrl, dir, stop }；extraEnv 注入安全整改相关环境变量 */
async function startServer(openLocal, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-sec-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, ...extraEnv };
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    // 邮箱格式不正确应被拒（密码格式限制已移除，不再校验强度）
    const bad = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'short', name: 'T' })
    });
    assert.equal(bad.status, 400);

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

/* ===================== 安全整改回归（密钥外送 / 数据隔离 / 限流伪造 / AI 额度） ===================== */

async function register(baseUrl, email, name) {
  const res = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'passw0rd123', name }),
    redirect: 'manual'
  });
  assert.equal(res.status, 200, '注册应成功：' + email);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('安全整改：普通用户 POST /api/config 只能写自己的 prefs，全局密钥端点/模式不可写（密钥外送攻击链关闭）', async () => {
  const { baseUrl, dir, stop } = await startServer(false, { CARTBACK_ADMIN_EMAILS: 'boss@example.com' });
  try {
    const cookie = await register(baseUrl, 'attacker@example.com', '攻击者');
    // 攻击链：把 AI/ESP 端点指向攻击者服务器 + 切 real 模式
    const r = await fetch(baseUrl + '/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'real', aiBaseUrl: 'https://evil.example', espApiUrl: 'https://evil.example', aiKey: 'stolen', smtpHost: 'evil.example', prefs: { tone: 'friendly' } })
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.scope, 'user', '普通用户的配置写入应被限定在 user 域');

    const boot = await (await fetch(baseUrl + '/api/bootstrap')).json();
    assert.equal(boot.status.mode, 'demo', 'mode 不得被普通用户改成 real');
    assert.notEqual(boot.status.aiBaseUrl, 'https://evil.example', 'aiBaseUrl 不得被普通用户改写');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.notEqual(onDisk.aiBaseUrl, 'https://evil.example', '落盘配置不得被污染');
    assert.notEqual(onDisk.espApiUrl, 'https://evil.example', '落盘配置不得被污染');

    // 用户级 prefs 允许写（自己域内）
    const state = await (await fetch(baseUrl + '/api/state', { headers: { cookie } })).json();
    assert.equal(state.prefs && state.prefs.tone, 'friendly', '普通用户自己的 prefs 应生效');

    // 管理员（CARTBACK_ADMIN_EMAILS 命中）可正常写全局
    const adminCookie = await register(baseUrl, 'boss@example.com', '管理员');
    const r2 = await fetch(baseUrl + '/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ mode: 'real', aiBaseUrl: 'https://ai.internal.example' })
    });
    assert.equal(r2.status, 200);
    const boot2 = await (await fetch(baseUrl + '/api/bootstrap')).json();
    assert.equal(boot2.status.mode, 'real', '管理员可切 real');
    assert.equal(boot2.status.aiBaseUrl, 'https://ai.internal.example', '管理员可改全局端点');
  } finally {
    await stop();
  }
});

test('安全整改：受众/导出按账号隔离，B 看不到也动不了 A 的客户 PII；空归属历史数据对普通用户不可见', async () => {
  const { baseUrl, stop } = await startServer(false);
  try {
    const cookieA = await register(baseUrl, 'a-iso@example.com', '商家A');
    const cookieB = await register(baseUrl, 'b-iso@example.com', '商家B');

    // A 导入两名客户
    const imp = await fetch(baseUrl + '/api/audience/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ csv: 'name,email,intent,abandoned_value\n客户甲,jia@example.com,加购未付,100\n客户乙,yi@example.com,弃购,50' })
    });
    assert.equal(imp.status, 200);
    const jA = await imp.json();
    assert.equal(jA.imported, 2);
    const jiaId = jA.audience.find(a => a.email === 'jia@example.com').id;

    // A 自己可见
    const audA = await (await fetch(baseUrl + '/api/audience', { headers: { cookie: cookieA } })).json();
    assert.ok(audA.audience.some(a => a.email === 'jia@example.com'), '归属人可见自己的名单');

    // B 的受众列表 / state / 导出都不含 A 的客户
    const audB = await (await fetch(baseUrl + '/api/audience', { headers: { cookie: cookieB } })).json();
    assert.ok(!audB.audience.some(a => a.email === 'jia@example.com'), 'B 不得看到 A 的客户');
    const stateB = await (await fetch(baseUrl + '/api/state', { headers: { cookie: cookieB } })).json();
    assert.ok(!JSON.stringify(stateB.audience).includes('jia@example.com'), 'state 受众按账号隔离');
    const expB = await (await fetch(baseUrl + '/api/export', { headers: { cookie: cookieB } })).json();
    assert.ok(!JSON.stringify(expB.audience).includes('jia@example.com'), '导出接口不得泄露他人 PII');

    // B 改 A 的受众标签 → 404；读同样 404
    const tagB = await fetch(baseUrl + '/api/audience/' + jiaId + '/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: cookieB },
      body: JSON.stringify({ tags: [{ tag_type: 'intent', tag_value: 'x', weight: 5 }] })
    });
    assert.equal(tagB.status, 404, 'B 不得写 A 的受众标签');
    const tagBGet = await fetch(baseUrl + '/api/audience/' + jiaId + '/tags', { headers: { cookie: cookieB } });
    assert.equal(tagBGet.status, 404, 'B 不得读 A 的受众标签');

    // 空归属历史数据（种子受众）对普通用户不可见：B 没导入过任何客户 → 受众应为空
    assert.equal(audB.audience.length, 0, '无归属历史/种子数据不得对普通用户可见');
  } finally {
    await stop();
  }
});

test('安全整改：注册限流不再信任 X-Forwarded-For（伪造不同 IP 不能绕过每小时 10 次上限）', async () => {
  const { baseUrl, stop } = await startServer(false);
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(baseUrl + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.${i}.${i}` },
        body: JSON.stringify({ email: `xff${i}@example.com`, password: 'passw0rd123', name: 'X' + i })
      });
      last = res.status;
      if (i < 10) assert.equal(res.status, 200, '前 10 次应放行（同源 IP 计数）');
    }
    assert.equal(last, 429, '伪造 XFF 换桶无效，第 11 次起必须 429');
  } finally {
    await stop();
  }
});

test('安全整改：普通用户每日 AI 额度超限 → 429（agent 轮次与竞品拆解同桶计量）', async () => {
  const { baseUrl, stop } = await startServer(false, { CARTBACK_USER_LLM_DAILY_LIMIT: '2' });
  try {
    const cookie = await register(baseUrl, 'quota@example.com', '额度用户');
    const actRes = await fetch(baseUrl + '/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}'
    });
    assert.equal(actRes.status, 200);
    const act = (await actRes.json()).act;

    const msg = () => fetch(baseUrl + `/api/act/${act.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ message: '帮我挽回加购未付的人' })
    });
    assert.equal((await msg()).status, 200, '第 1 轮放行');
    assert.equal((await msg()).status, 200, '第 2 轮放行');
    const third = await msg();
    assert.equal(third.status, 429, '第 3 轮必须 429（额度=2）');
    const body = await third.json();
    assert.match(body.error, /额度/, '429 文案说明额度用尽');

    // 竞品拆解同桶：额度已耗尽 → 也 429
    const comp = await fetch(baseUrl + '/api/competitors/inbound', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ raw_email: 'Subject: sale\nunsubscribe here, buy now' })
    });
    assert.equal(comp.status, 429, '竞品拆解与对话轮共用每日额度');
  } finally {
    await stop();
  }
});

test('安全整改：畸形 cookie（裸 %）不得打崩服务（未鉴权 DoS 关闭），请求正常返回 403', async () => {
  const { baseUrl, stop } = await startServer(false);
  try {
    const r1 = await fetch(baseUrl + '/api/state', { headers: { cookie: 'cb_session=%zz; x=<script>' } });
    assert.equal(r1.status, 403, '畸形 cookie 应按未鉴权 403 处理');
    const r2 = await fetch(baseUrl + '/api/bootstrap');
    assert.ok(r2.ok, '服务在畸形 cookie 之后必须仍然存活');
  } finally {
    await stop();
  }
});

test('安全整改：/api/email/view 输出带 CSP（禁脚本/表单），LLM 生成的邮件 HTML 同源不可执行', async () => {
  const { baseUrl, dir, stop } = await startServer(false);
  try {
    // 直接落一个带脚本草稿（模拟提示注入/编辑落库的恶意 HTML）
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
    db.prepare('INSERT INTO drafts (id, subject, body, status, html) VALUES (?, ?, ?, ?, ?)')
      .run('dr_xss', 's', 'b', 'draft', '<!DOCTYPE html><html><body><script>alert(1)</script><p>hi</p></body></html>');
    db.close();
    const res = await fetch(baseUrl + '/api/email/view/dr_xss');   // 免鉴权端点
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'none'/, 'CSP 必须禁脚本');
    assert.match(csp, /form-action 'none'/, 'CSP 必须禁表单提交');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await stop();
  }
});

test('安全整改：SMTP 头注入——显示名/地址中的 CR/LF 被剥离，不能注入 Bcc 等头', async () => {
  const { buildMime } = require('../lib/smtp');
  const evil = 'MyBrand\r\nBcc: victim@example.com\r\nX-Evil: 1';
  const mime = buildMime({ from: 'shop@example.com', senderName: evil, to: 'to@example.com', subject: 'hi', text: 'body' });
  const headerLines = mime.split('\r\n\r\n')[0].split('\r\n');
  const injected = headerLines.filter(l => /^(bcc|x-evil):/i.test(l));
  assert.equal(injected.length, 0, '注入内容只能残留在 From 显示名一行内，不得成为独立头：' + JSON.stringify(injected));
  assert.ok(headerLines[0].startsWith('From: '), 'From 头保持独立一行');
});
