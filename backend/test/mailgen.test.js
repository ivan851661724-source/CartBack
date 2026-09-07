'use strict';

/**
 * 邮件生成（mailgen）迁移回归测试
 * 验证 Python→Node/TS 迁移后，/api/draft 仍能同进程生成 HTML 邮件，
 * 且 copy_provider / image_method / html 契约与旧版一致（确定性、无网络依赖）。
 *
 * - skip_image=true + 空 subject/body → fallback_template 文案 + skip 图片
 * - 已有 subject/body → igde_pass_through 直通路径
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
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForBootstrap(baseUrl) {
  let lastError;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(baseUrl + '/api/bootstrap');
      if (r.ok) return await r.json();
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not start');
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-mailgen-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1' },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrap = await waitForBootstrap(baseUrl);
  const cleanup = async () => {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { baseUrl, token: bootstrap.token, cleanup };
}

test('mailgen: 空 subject/body + skip_image → fallback_template + skip', async () => {
  const { baseUrl, token, cleanup } = await startServer();
  try {
    const headers = { 'Content-Type': 'application/json', 'x-local-token': token };
    const r = await fetch(baseUrl + '/api/draft', {
      method: 'POST', headers,
      body: JSON.stringify({
        actId: null,
        planCard: {
          subject: '', body: '',
          discount: 12, brand: 'SmokeBrand',
          audience: '加购未付', cart_url: 'https://cartback.demo/smoke',
          locale: 'en-US', skip_image: true,
        },
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    const draft = body.draft;
    assert.ok(draft, '应返回 draft');
    assert.ok(draft.html && draft.html.startsWith('<!DOCTYPE html>'), 'html 应以 DOCTYPE 开头');
    // 品牌统一：shopBrand（默认 CartBack）覆盖方案卡里的 per-profile 测试品牌
    assert.ok(draft.html.includes('CartBack'), 'html 应包含统一后的商家品牌名');
    assert.equal(draft.mailgen_meta.copy_provider, 'fallback_template');
    assert.equal(draft.mailgen_meta.image_method, 'skip');
    // skip_image 时 mailgen 返回空，/api/draft 兜底写入 FALLBACK_IMAGE 哨兵（迁移前既有行为）
    assert.equal(draft.image_path, 'FALLBACK_IMAGE');
    // subject/body 被回填为 fallback 模板文案
    assert.ok(draft.subject.includes('12% OFF'));
  } finally {
    await cleanup();
  }
});

test('mailgen: 已有 subject/body → igde_pass_through 直通', async () => {
  const { baseUrl, token, cleanup } = await startServer();
  try {
    const headers = { 'Content-Type': 'application/json', 'x-local-token': token };
    const r = await fetch(baseUrl + '/api/draft', {
      method: 'POST', headers,
      body: JSON.stringify({
        actId: null,
        planCard: {
          subject: '我的专属挽回主题', body: '回来吧，购物车还在等你',
          discount: 9, brand: 'PassThru',
          audience: '加购未付', cart_url: 'https://cartback.demo/pt',
          locale: 'en-US', skip_image: true,
        },
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    const draft = body.draft;
    assert.equal(draft.mailgen_meta.copy_provider, 'igde_pass_through');
    assert.equal(draft.mailgen_meta.image_method, 'skip');
    assert.equal(draft.subject, '我的专属挽回主题');
    assert.equal(draft.body, '回来吧，购物车还在等你');
    assert.ok(draft.html.includes('我的专属挽回主题'));
  } finally {
    await cleanup();
  }
});
