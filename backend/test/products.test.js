'use strict';

/**
 * 商品库（批次 1 上传链路）+ 品类化（批次 2）行为测试。
 * 对照《电商生成流水线品类化与商品图上传改造执行计划》退出条件：
 *  - 非图片文件被拒（content-type / 魔数 / 大小三道校验）
 *  - 多账号互相不可见（user_id 隔离）
 *  - 上传 → 落库 → /api/image 可访问 → 删除幂等
 *  - 同一受众画像、不同品类 → 生图构图不同；非手机壳品类无 iPhone/手机壳 残留
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const execution = require('../lib/execution');

/** 与子进程同口径的「窗口内」假时钟（纽约 10-18 点），confirm 建草稿用 */
function inWindowFakeNow() {
  let ts = Date.now();
  for (let i = 0; i < 30; i++) {
    const h = execution.localHourIn('America/New_York', ts);
    if (h >= 10 && h <= 18) return ts;
    ts += 3600 * 1000;
  }
  return ts;
}

/** spawn 一个开放本地模式服务（confirm 建草稿走 mock 店铺），返回 api 客户端 */
async function startOpenLocalServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-prd-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1', CARTBACK_FAKE_NOW: String(inWindowFakeNow()) },
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

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-prd-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, ...extraEnv };
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

async function register(baseUrl, email, name) {
  const res = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass-1234', name })
  });
  assert.equal(res.status, 200, `register ${email} failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

/** 1x1 真实 PNG（魔数 \x89PNG）+ 一段伪 PNG（文本内容，魔数不符） */
const REAL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FAKE_PNG_B64 = Buffer.from('not-a-png-just-plain-text').toString('base64');

function postProduct(baseUrl, cookie, body) {
  return fetch(baseUrl + '/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body)
  });
}

test('products: 上传→落库→可访问→删除，非图片/超限被拒，多账号隔离', async () => {
  const { baseUrl, stop } = await startServer();
  try {
    const cookieA = await register(baseUrl, 'pa@example.com', '商家A');
    const cookieB = await register(baseUrl, 'pb@example.com', '商家B');

    // 未登录 403（商品端点不在白名单）
    const anon = await postProduct(baseUrl, '', { image_data: REAL_PNG_B64, content_type: 'image/png' });
    assert.equal(anon.status, 403);

    // ✅ 正常上传（PNG 魔数）
    const up = await postProduct(baseUrl, cookieA, {
      image_data: REAL_PNG_B64, content_type: 'image/png', name: '军工壳', category: 'phone_case'
    });
    assert.equal(up.status, 200);
    const { product } = await up.json();
    assert.equal(product.category, 'phone_case');
    assert.equal(product.content_type, 'image/png');
    assert.ok(product.image_url.startsWith('/api/image/'), 'image_url 走现有 /api/image 端点');
    assert.ok(fs.existsSync(decodeURIComponent(product.image_url.replace('/api/image/', ''))), '文件已落盘 output/uploads');

    // 落盘目录隔离：output/uploads/{userId}/
    const stored = decodeURIComponent(product.image_url.replace('/api/image/', ''));
    assert.ok(stored.includes('uploads'), `落盘在 uploads 目录: ${stored}`);

    // ✅ 图片经 /api/image 端点可访问（白名单端点，未登录也可读——计划文档认可的取舍）
    const img = await fetch(baseUrl + product.image_url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');

    // ❌ 魔数不符（伪 PNG 文本）→ 415
    const fake = await postProduct(baseUrl, cookieA, { image_data: FAKE_PNG_B64, content_type: 'image/png' });
    assert.equal(fake.status, 415);

    // ❌ 声明非图片 content-type → 400
    const badMime = await postProduct(baseUrl, cookieA, { image_data: REAL_PNG_B64, content_type: 'application/json' });
    assert.equal(badMime.status, 400);

    // ❌ 超过 2MB → 413
    const big = Buffer.alloc(2 * 1024 * 1024 + 1024, 8).toString('base64');
    const oversized = await postProduct(baseUrl, cookieA, { image_data: big, content_type: 'image/png' });
    assert.equal(oversized.status, 413);

    // ❌ 缺图片数据 → 400
    const missing = await postProduct(baseUrl, cookieA, { name: 'no image' });
    assert.equal(missing.status, 400);

    // ✅ 列表：A 可见 1 张；B 看不到 A 的（多账号互相不可见）
    const listA = await fetch(baseUrl + '/api/products', { headers: { cookie: cookieA } });
    assert.equal(listA.status, 200);
    assert.equal((await listA.json()).products.length, 1);
    const listB = await fetch(baseUrl + '/api/products', { headers: { cookie: cookieB } });
    assert.equal((await listB.json()).products.length, 0);

    // ✅ 越权删除被拒；本人删除成功且幂等（文件一并清理）
    const crossDel = await fetch(baseUrl + `/api/products/${product.id}`, {
      method: 'DELETE', headers: { cookie: cookieB }
    });
    assert.equal(crossDel.status, 404);
    const del = await fetch(baseUrl + `/api/products/${product.id}`, {
      method: 'DELETE', headers: { cookie: cookieA }
    });
    assert.equal(del.status, 200);
    assert.equal(fs.existsSync(stored), false, '删除后落盘文件一并清理');
    const listA2 = await fetch(baseUrl + '/api/products', { headers: { cookie: cookieA } });
    assert.equal((await listA2.json()).products.length, 0);
  } finally {
    await stop();
  }
});

test('products: 品类化构图——同一画像不同品类构图不同，非手机壳无 iPhone/手机壳残留', async () => {
  const { fromPlanCard } = require('../dist/data-loader');
  const { generateImagePrompt } = require('../dist/copy-generator');
  const config = { marketing: { image_style: '', cta_button: 'Shop Now' } };
  const baseCard = {
    audience: '加购未付的 25-34 岁女性',
    tag_distribution: [
      { tag_type: 'gender', tag_value: 'female', count: 10 },
      { tag_type: 'age_range', tag_value: '25-34', count: 10 },
      { tag_type: 'language', tag_value: 'English', count: 10 }
    ],
    product: 'Silk Scarf',
    product_cn: '真丝丝巾',
    discount: 10,
    brand: 'TestBrand'
  };

  const prompts = {};
  for (const category of ['phone_case', 'apparel', 'jewelry', 'generic', '']) {
    const user = fromPlanCard({ ...baseCard, category }, null);
    prompts[category || '(empty)'] = generateImagePrompt(user, config);
  }

  // 退出条件①：同一受众画像、不同品类 → 构图不同
  const uniq = new Set(Object.values(prompts));
  assert.equal(uniq.size, 4, `四类构图应互不相同（空品类与通用同模板）：\n${Object.entries(prompts).map(([k, v]) => `${k}: ${v}`).join('\n')}`);
  assert.equal(prompts['(empty)'], prompts.generic, '无品类落通用模板');

  // 手机壳保留 手持特写浅景深
  assert.ok(prompts.phone_case.includes('手持特写浅景深'), `手机壳保留手持特写构图: ${prompts.phone_case}`);

  // 退出条件②：非手机壳品类无手机壳/iPhone 默认值残留
  for (const key of ['apparel', 'jewelry', 'generic']) {
    assert.ok(!prompts[key].includes('iPhone'), `${key} 无 iPhone 残留: ${prompts[key]}`);
    assert.ok(!prompts[key].includes('手机壳'), `${key} 无手机壳残留: ${prompts[key]}`);
    assert.ok(!prompts[key].includes('手持'), `${key} 无手持构图残留: ${prompts[key]}`);
  }
  assert.ok(prompts.apparel.includes('上身') && prompts.apparel.includes('平铺'), `服装=上身或平铺: ${prompts.apparel}`);
  assert.ok(prompts.jewelry.includes('微距摆拍'), `饰品=微距摆拍: ${prompts.jewelry}`);
  assert.ok(prompts.generic.includes('产品置于场景中央'), `通用=场景中央: ${prompts.generic}`);

  // 手机壳带机型位（标签回填）/ 无机型标签时不写死 iPhone
  const userNoDevice = fromPlanCard({ ...baseCard, category: 'phone_case', product: 'Clear Case', product_cn: '透明壳' }, null);
  assert.ok(!userNoDevice.device, 'device 默认不再写死 iPhone');
  const promptNoDevice = generateImagePrompt(userNoDevice, config);
  assert.ok(!promptNoDevice.includes('iPhone'), `无机型标签时 prompt 无 iPhone: ${promptNoDevice}`);
  assert.ok(promptNoDevice.includes('手持特写浅景深'), '手机壳无机型仍保留手持构图');

  // 文案兜底产品名不再写死 Premium Phone Case
  const userBare = fromPlanCard({}, null);
  assert.equal(userBare.product_en, 'Premium Product');
  assert.equal(userBare.category, '');
});

test('products: 最后一米——confirm 建草稿 → /api/draft/:id/image 选用商品图 → 邮件 Hero 即上传图', async (t) => {
  const { api } = await startOpenLocalServer(t);

  // 上传商品图（无 AI 配置 → 品类留空落通用；无万相 → 图生图跳档、原图直出）
  const up = await api('/api/products', { method: 'POST', body: { image_data: REAL_PNG_B64, content_type: 'image/png', name: '我的商品', category: 'generic' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const product = up.json.product;

  // 建会话 → 四槽聊满 → confirm 建草稿（无 visionKey：创建时 skip_image，不出图）
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const actId = act.json.act.id;
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静了' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '折扣给 12% off 就行' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });
  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200, JSON.stringify(cf.json));
  const draftId = cf.json.draft_id;
  assert.ok(draftId, 'confirm 建草稿');

  // 最后一米：product_image_id → 服务端解析本地路径 → 管道直出（无万相无叠字 = 原图即 Hero）
  const regen = await api(`/api/draft/${draftId}/image`, { method: 'POST', body: { product_image_id: product.id } });
  assert.equal(regen.status, 200, JSON.stringify(regen.json));
  assert.equal(regen.json.image_path, decodeURIComponent(product.image_url.replace('/api/image/', '')), '邮件 Hero 路径 = 上传图落盘路径');
  assert.ok(regen.json.html.length > 500, 'HTML 已重渲染');

  // 草稿固化：image_path 落库 + 档位观测（无 visionKey：走档2 原图直出，overlay_text=false）
  const st = await api('/api/state');
  const draft = st.json.drafts.find(d => d.id === draftId);
  assert.equal(draft.image_path, decodeURIComponent(product.image_url.replace('/api/image/', '')), 'image_path 固化进草稿');
  assert.match(draft.mailgen_meta.image_method, /^upload(\+overlay)?$/, `image_method 透出实际档位: ${draft.mailgen_meta.image_method}`);

  const badRegen = await api(`/api/draft/${draftId}/image`, { method: 'POST', body: { product_image_id: 'prd_notexist' } });
  assert.equal(badRegen.status, 404, '不存在的商品 404');
});

test('products: 每用户数量上限（50 张）——超出 409，删除后可再传', async () => {
  const { baseUrl, stop } = await startServer();
  try {
    const cookie = await register(baseUrl, 'cap@example.com', '配额商家');
    // 上满 50 张（1x1 小图，本地快）
    for (let i = 0; i < 50; i++) {
      const up = await postProduct(baseUrl, cookie, { image_data: REAL_PNG_B64, content_type: 'image/png', name: `p${i}` });
      assert.equal(up.status, 200, `第 ${i + 1} 张应上传成功`);
    }
    const list = await fetch(baseUrl + '/api/products', { headers: { cookie } });
    assert.equal((await list.json()).products.length, 50);

    // 第 51 张 → 409
    const overflow = await postProduct(baseUrl, cookie, { image_data: REAL_PNG_B64, content_type: 'image/png', name: 'overflow' });
    assert.equal(overflow.status, 409);
    assert.ok((await overflow.json()).error.includes('上限'), '409 文案含上限说明');

    // 删 1 张后可再传
    const del = await fetch(baseUrl + '/api/products/' + (await (await fetch(baseUrl + '/api/products', { headers: { cookie } })).json()).products[0].id, { method: 'DELETE', headers: { cookie } });
    assert.equal(del.status, 200);
    const again = await postProduct(baseUrl, cookie, { image_data: REAL_PNG_B64, content_type: 'image/png', name: 'after-delete' });
    assert.equal(again.status, 200, '删除后腾出配额可再上传');
  } finally {
    await stop();
  }
});
