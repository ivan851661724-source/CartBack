'use strict';
/**
 * G2 一键真发端到端测试（mock Resend，不需要公网）：
 *   真实模式 → 202 入队 → 渲染管线逐收件人变体 → mock ESP 批量发送（逐封独立 to）
 *   → 频控拦截 → Resend 回执映射 → Shopify 订单归因（order_id 幂等 / 退款扣减）
 *   → bounced 剔除 → 标签加权反哺。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WH_SECRET = 'wh_e2e_secret';

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

/** mock Resend：/emails 单封、/emails/batch 批量；记录全部请求 */
async function startMockEsp() {
  const received = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = JSON.parse(data || '[]');
      received.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url.endsWith('/batch')) {
        const ids = body.map(() => `esp_${++n}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ids.map((id) => ({ id }))));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `esp_${++n}` }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, received, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

async function waitFor(fn, timeoutMs = 30000, stepMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timeout');
}

test('G2 端到端：真发链路 + 频控 + 归因 + 标签反哺', async (t) => {
  const esp = await startMockEsp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-e2e-'));
  // 预置 config：espApiUrl 指向 mock（/api/config 不暴露该项）；webhookSecret 固定便于回执测试
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    espApiUrl: `http://127.0.0.1:${esp.port}/emails`,
    webhookSecret: WH_SECRET,
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  for (let i = 0; i < 30 && !token; i++) {
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
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 1500))]);
    await esp.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // —— 真实模式 + ESP 配置 ——
  const cfg = await api('/api/config', { method: 'POST', body: { mode: 'real', espKey: 're_test_key', espFrom: 'send@test.example' } });
  assert.equal(cfg.json.status.mode, 'real');
  assert.equal(cfg.json.status.espConfigured, true);

  // —— 生成草稿（AI 未配置 → 确定性标准三档变体；skip_image 免网络图片） ——
  const dr = await api('/api/draft', {
    method: 'POST',
    body: { planCard: { subject: '', body: '', discount: 12, coupon: 'BACK12', audience: '加购未付', brand: 'E2E', locale: 'en', skip_image: true } },
  });
  assert.equal(dr.status, 200);
  const draft = dr.json.draft;
  assert.equal(draft.variants.length, 3);
  assert.equal(draft.variants_provider, 'fallback_standard');
  assert.equal(dr.json.audience_conditions.matchedCount, 9);   // 未付族：加购未付×4 + 弃购×3 + 下单未付×2

  // —— 202 入队 + 轮询到 done ——
  const send1 = await api(`/api/draft/${draft.id}/send`, { method: 'POST', body: {} });
  assert.equal(send1.status, 202);
  assert.ok(send1.json.job_id, 'job id returned');
  assert.equal(send1.json.queued, true);
  const job = await waitFor(async () => {
    const j = await api(`/api/jobs/${send1.json.job_id}`);
    return ['done', 'failed'].includes(j.json.status) ? j.json : null;
  });
  assert.equal(job.status, 'done', 'send job done: ' + (job.error || ''));
  assert.equal(job.result.recipients, 9);
  assert.equal(job.result.real, true);

  // —— mock ESP 收到 1 个批量请求、4 封逐收件人变体 ——
  await waitFor(() => (esp.received.some((r) => r.url.endsWith('/emails/batch')) ? true : null));
  const batch = esp.received.find((r) => r.url.endsWith('/emails/batch'));
  assert.equal(batch.auth, 'Bearer re_test_key');
  const msgs = batch.body;
  assert.equal(msgs.length, 9);
  for (const m of msgs) {
    assert.equal(m.from, 'send@test.example');
    assert.equal(m.to.length, 1, '隐私：每封独立 to（互不可见）');
    assert.ok(m.subject && m.subject.length > 0);
    assert.ok(m.text && m.text.length > 0);
  }
  // 变体分档：价格敏感（林晚/顾言/夏一 price=高）→ 折扣主打；intent=hot（陈默/周野 ≤7d）→ 紧迫；其余 → 标准
  const discountSubjects = msgs.filter((m) => /% OFF waiting for you/.test(m.subject));
  const urgencySubjects = msgs.filter((m) => /cart is about to expire/.test(m.subject));
  const standardSubjects = msgs.filter((m) => /You left something behind at CartBack/.test(m.subject));
  assert.equal(discountSubjects.length, 3);
  assert.equal(urgencySubjects.length, 2);
  assert.equal(standardSubjects.length, 4);
  // 模板按收件人本地展开：{{name}} 已替换、{{coupon}} 已填充
  for (const m of msgs) {
    assert.ok(!/\{\{name\}\}/.test(m.subject + m.text), '占位符必须展开');
    assert.ok(m.text.includes('BACK12'), '优惠码事实进入正文');
  }

  // —— 草稿态：queued → sent；重复发送 409，且编辑内容不得写进已发出的邮件 ——
  const dup = await api(`/api/draft/${draft.id}/send`, { method: 'POST', body: { subject: 'TAMPERED', body: 'TAMPERED' } });
  assert.equal(dup.status, 409);
  const sentDraft = (await api('/api/drafts')).json.drafts.find((x) => x.id === draft.id);
  assert.equal(sentDraft.subject, "Your 12% OFF Is Waiting — Don't Miss Out, CartBack");

  // —— 72h 频控：同受众第二场活动被拦截（400 + 人话提示） ——
  const dr2 = await api('/api/draft', {
    method: 'POST',
    body: { planCard: { subject: 'again', body: 'again', discount: 15, coupon: 'BACK15', audience: '加购未付', skip_image: true } },
  });
  const send2 = await api(`/api/draft/${dr2.json.draft.id}/send`, { method: 'POST', body: {} });
  assert.equal(send2.status, 400);
  assert.match(send2.json.error, /72 小时/);

  // —— ⑤ Resend 回执：opened（esp_id → 收件人映射） ——
  const espId = (await (async () => {
    // mock 的 esp_id 形如 esp_1..esp_4；取任一：直接用首封 id
    return 'esp_1';
  })());
  const opened = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ type: 'email.opened', data: { message_id: espId, email: 'wan.lin@example.com' } }),
  });
  assert.equal(opened.status, 200);

  // —— ⑤ Shopify 订单归因：优惠码核销 → convert + 标签 +2 ——
  const audList = (await api('/api/audience')).json.audience;
  const wanLin = audList.find((a) => a.email === 'wan.lin@example.com');
  assert.ok(wanLin);
  const order = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ source: 'shopify', event: 'orders/create', order: { id: 55001, email: 'wan.lin@example.com', total_price: '89.90', discount_codes: ['BACK12'] } }),
  });
  assert.deepEqual(await order.json(), { ok: true, attributed: true });
  // order_id 幂等：同单重放 → deduped
  const replay = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ source: 'shopify', event: 'orders/create', order: { id: 55001, email: 'wan.lin@example.com', total_price: '89.90', discount_codes: ['BACK12'] } }),
  });
  assert.deepEqual(await replay.json(), { ok: true, deduped: true });
  // 标签反哺：intent 8→10（触顶）、price 7→9
  const tags = (await api(`/api/audience/${wanLin.id}/tags`)).json.tags;
  const intentTag = tags.find((x) => x.tag_type === 'intent');
  const priceTag = tags.find((x) => x.tag_type === 'price_sensitivity');
  assert.equal(intentTag.weight, 10);
  assert.equal(intentTag.source, 'attribution');
  assert.equal(priceTag.weight, 9);

  // —— 退款扣减：GMV 归零 ——
  const refund = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ source: 'shopify', event: 'orders/update', order: { id: 55001, financial_status: 'refunded' } }),
  });
  const refundJson = await refund.json();
  assert.equal(refundJson.refunded, true);
  assert.equal(refundJson.deducted, 89.9);

  // —— bounced 剔除 ——
  const bounce = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ type: 'email.bounced', data: { message_id: 'esp_unknown', email: 'mo.chen@example.com' } }),
  });
  assert.equal(bounce.status, 200);
  const chen = (await api('/api/audience')).json.audience.find((a) => a.email === 'mo.chen@example.com');
  assert.equal(chen.email_status, 'email_invalid');

  // —— KPI：真实口径（1 open、1 convert 已退款 → GMV 0） ——
  const kpis = (await api('/api/state')).json.kpis;
  assert.equal(kpis.open, 1);
  assert.equal(kpis.convert, 1);
  assert.equal(kpis.gmv, 0);

  // —— PRD §1 过滤口径：30 天挽回窗口 + 未转化 ——
  // 同步一条 40 天前流失的「加购未付」：进入受众但不进可发送名单（窗口外）
  await api('/api/store/sync', { method: 'POST', body: { events: [{ email: 'old.cart@example.com', name: 'OldCart', intent: '加购未付', abandoned_value: 500, at_risk_at: Date.now() - 40 * 86400000 }] } });
  const conditions = (await api('/api/audience/preview', { method: 'POST', body: { audience: '加购未付' } })).json;
  assert.equal(conditions.matchedCount, 8);   // 原始 10 条命中（9 + 老客）；窗口剔除老客、转化剔除 wan.lin → 8

  // wan.lin 已转化（即使退款）也退出可发送名单；mo.chen 被 bounced 剔除
  // —— 按人群/语言预览（渲染管线同口径；此时可发送：discount 2 / urgency 1 / standard 4） ——
  const preview = (await api(`/api/draft/${draft.id}/preview`)).json;
  assert.equal(preview.tiers.find((x) => x.tier === 'discount').count, 2);
  assert.equal(preview.tiers.find((x) => x.tier === 'urgency').count, 1);
  assert.equal(preview.tiers.find((x) => x.tier === 'standard').count, 4);
  assert.ok(preview.languages.length >= 1);
  assert.equal(preview.g0_blocked.length, 0);

  // —— /api/image 只允许 output/ 目录树内文件（P1 路径穿越修复） ——
  const outside = await fetch(base + '/api/image/' + encodeURIComponent(require('path').join(__dirname, '..', 'server.js')));
  assert.equal(outside.status, 403);
  // 海报已下线（436a06e：前端不再展示，改展示主图，省 LLM/万相算力）——skip_image 场景无海报图片文件
  assert.ok(!sentDraft.posters || sentDraft.posters.every((p) => !p.file), '海报下线后 draft 不应再有生成的海报文件');
});
