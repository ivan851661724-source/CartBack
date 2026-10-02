'use strict';
/**
 * Wave 2 真发端到端（mock Resend + mock 店铺连接器，不需要公网）：
 *   对话收齐 → /confirm 真实建码（mock 店铺回执）→ 200 人名单 → /send 202 入队
 *   → holdout 冻结 10%（绝不入 sends、不收信）→ 渲染管线逐收件人变体 → mock ESP 批量发送
 *   → 逐收件人落 sends（gate_snapshot）→ diff=0（草稿与快照逐字段相等）
 *   → Resend 回执映射 → Shopify 订单优惠码核销归因（真实建码打通）→ 退款扣减 → bounced 剔除。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const execution = require('../lib/execution');

const WH_SECRET = 'wh_e2e_secret';
const SYNC_N = 220;   // 220 同步 + 4 加购种子 = 224 → 可发送上限 200 → holdout 20 → 实发 180

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

function fakeNowInWindow() {
  let ts = Date.now();
  for (let i = 0; i < 36; i++) {
    const h = execution.localHourIn('America/New_York', ts);
    if (h >= 10 && h <= 18) return ts;
    ts += 3600 * 1000;
  }
  return ts;
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

test('Wave 2 端到端：confirm 建码 → holdout 冻结 → 真发 → sends 流水 → diff=0 → 归因链', async (t) => {
  const esp = await startMockEsp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-e2e-'));
  // 预置 config：mock 店铺连接器（E2 建码注入缝）+ 公网基址（退订闸）+ mock ESP + webhook secret
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    espApiUrl: `http://127.0.0.1:${esp.port}/emails`,
    webhookSecret: WH_SECRET,
    publicBaseUrl: 'https://e2e.example',
    stores: [{ type: 'mock', shop: 'E2E Mock' }],
  }));

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1', CARTBACK_FAKE_NOW: String(fakeNowInWindow()) },
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

  // —— 真实模式 + ESP 配置 + 商家品牌（白标闸）——
  const cfg = await api('/api/config', { method: 'POST', body: { mode: 'real', espKey: 're_test_key', espFrom: 'send@test.example', shopBrand: 'E2E' } });
  assert.equal(cfg.json.status.mode, 'real');
  assert.equal(cfg.json.status.espConfigured, true);

  // —— 灌 220 名加购未付名单（holdout 需 ≥200 净值名单才冻结）——
  const events = Array.from({ length: SYNC_N }, (_, i) => ({
    email: `flow${i}@example.com`, name: `Flow${i}`, intent: '加购未付',
    abandoned_value: 100, locale: 'en', at_risk_at: Date.now() - i * 60000
  }));
  const sync = await api('/api/store/sync', { method: 'POST', body: { events } });
  assert.equal(sync.json.imported, SYNC_N);

  // —— 对话收齐四槽（AI 未配置 → 桩模式；presets 注入受众）——
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: '加购未付' } } });
  const actId = act.json.act.id;
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静了' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '折扣给 12% off 就行' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });

  // —— /confirm：先真实建码（mock 店铺回执）→ 出卡 + 快照冻结 + 服务端同源草稿 ——
  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200, JSON.stringify(cf.json).slice(0, 300));
  const planCard = cf.json.planCard;
  assert.equal(cf.json.act.stage, 'S3');
  assert.equal(planCard.discount.code_status, 'created');
  const CODE = planCard.discount.code;
  assert.match(CODE, /^COMEBACK-[A-Z0-9]{6}$/, '码来自店铺连接器真实回执');
  assert.equal(planCard.reach_count, 200, '净值名单（224 可发送上限 200）');
  assert.equal(planCard.estGmv.formula.people, 200);
  assert.equal(planCard.estGmv.source, 'demo', '无客单价 extras → 行业默认标注 demo');
  assert.deepEqual(cf.json.checklist.items.map(i => i.gate), ['window', 'frequency', 'whitelabel', 'unsubscribe', 'amount_code']);
  assert.equal(cf.json.checklist.all_pass, true, '五道闸全过（时段/频次/白标/退订/金额与码）');
  const draft = cf.json.draft;
  assert.equal(draft.coupon, CODE);
  // D3 diff=0：草稿四字段（audience/discount/count/estGmv 口径）与卡片快照逐字段相等
  assert.equal(draft.audience, planCard.audience);
  assert.equal(draft.discount, planCard.discount.percent_off);
  assert.equal(draft.matchedCount, planCard.reach_count);
  assert.equal(draft.estGmv, planCard.estGmv.amount);

  // —— /send：202 入队（放行时冻结 holdout）→ 轮询到 done ——
  const send1 = await api(`/api/draft/${draft.id}/send`, { method: 'POST', body: {} });
  assert.equal(send1.status, 202, JSON.stringify(send1.json).slice(0, 300));
  assert.ok(send1.json.job_id);
  assert.equal(send1.json.holdout.frozen, true, '全过 → 先冻结 holdout');
  assert.equal(send1.json.holdout.count, 20, '200 × 10% 圈定对照组');
  const job = await waitFor(async () => {
    const j = await api(`/api/jobs/${send1.json.job_id}`);
    return ['done', 'failed'].includes(j.json.status) ? j.json : null;
  });
  assert.equal(job.status, 'done', 'send job done: ' + (job.error || ''));
  assert.equal(job.result.recipients, 180, '实发 = 200 − holdout 20');
  assert.equal(job.result.holdout, 20);
  assert.equal(job.result.real, true);

  // —— mock ESP：180 封逐收件人（分批 ≤100）、白标发件人、退订头、码进正文 ——
  await waitFor(() => (esp.received.some((r) => r.url.endsWith('/emails/batch')) ? true : null));
  const batches = esp.received.filter((r) => r.url.endsWith('/emails/batch'));
  const msgs = batches.flatMap((b) => b.body);
  assert.equal(msgs.length, 180);
  assert.equal(batches[0].auth, 'Bearer re_test_key');
  const holdoutEmails = new Set();
  for (const m of msgs) {
    assert.equal(m.from, 'E2E <send@test.example>', '白标：发件人名走商家品牌');
    assert.equal(m.to.length, 1, '隐私：每封独立 to（互不可见）');
    assert.ok(m.subject && m.subject.length > 0);
    assert.ok(m.text.includes(CODE), '真实回执码进入正文');
    assert.ok(!/\{\{name\}\}/.test(m.subject + m.text), '占位符必须展开');
    assert.ok(m.headers && /\/api\/email\/unsubscribe/.test(m.headers['List-Unsubscribe'] || ''), 'List-Unsubscribe 头可解析');
  }

  // —— sends / holdouts 落库断言（直接读 sqlite：表隔离 + gate_snapshot + diff=0 终态）——
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const sends = db.prepare('SELECT * FROM sends WHERE campaign_id = ?').all(draft.id);
  const holds = db.prepare('SELECT * FROM holdouts WHERE campaign_id = ?').all(draft.id);
  assert.equal(sends.length, 180, 'sends 逐收件人行数 = 实发数');
  assert.ok(sends.every((r) => r.status === 'sent'));
  assert.ok(sends.every((r) => r.gate_snapshot && r.tz && r.code === CODE), 'gate_snapshot/时区/码留痕');
  assert.equal(JSON.parse(sends[0].gate_snapshot).items.length, 5, 'gate_snapshot 存五道闸结果');
  assert.equal(holds.length, 20, 'holdouts 冻结 20 人');
  assert.ok(holds.every((h) => h.source === 'single_plan' && h.ratio === 0.1));
  const sendEmails = new Set(sends.map((r) => r.recipient));
  assert.equal(holds.every((h) => !sendEmails.has(h.recipient)), true, '对照成员绝不写入 sends（名单不重叠）');
  // 重复冻结/重试不追加新行（幂等）
  const sendsAgain = db.prepare('SELECT COUNT(DISTINCT recipient) AS n, COUNT(*) AS total FROM sends WHERE campaign_id = ?').get(draft.id);
  assert.equal(sendsAgain.n, sendsAgain.total, '同 (campaign, recipient) 幂等一行');
  db.close();

  // —— 发送后再核对 diff=0（草稿四字段与快照一致；discount 经 DB TEXT 列往返，按数值口径比较）——
  const sentDraft = (await api('/api/drafts')).json.drafts.find((x) => x.id === draft.id);
  assert.equal(sentDraft.status, 'sent');
  assert.equal(sentDraft.audience, planCard.audience);
  assert.equal(Number(sentDraft.discount), planCard.discount.percent_off);
  assert.equal(Number(sentDraft.matchedCount), planCard.reach_count);
  assert.equal(Math.round(Number(sentDraft.estGmv) * 100) / 100, planCard.estGmv.amount);

  // —— ⑤ Resend 回执：opened（esp_id → 收件人映射） ——
  const opened = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ type: 'email.opened', data: { message_id: 'esp_1', email: 'flow0@example.com' } }),
  });
  assert.equal(opened.status, 200);

  // —— ⑤ Shopify 订单归因：真实建码的优惠码核销 → convert + 标签反哺 ——
  const order = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ source: 'shopify', event: 'orders/create', order: { id: 55001, email: 'flow0@example.com', total_price: '89.90', discount_codes: [CODE.toLowerCase()] } }),
  });
  assert.deepEqual(await order.json(), { ok: true, attributed: true });
  const flow0 = (await api('/api/audience')).json.audience.find((a) => a.email === 'flow0@example.com');
  assert.ok(flow0, '归因收件人命中');
  const tags = (await api(`/api/audience/${flow0.id}/tags`)).json.tags;
  assert.ok(tags.some((x) => x.source === 'attribution' && (x.weight || 0) > 0), 'convert → 标签加权反哺');

  // order_id 幂等：同单重放 → deduped
  const replay = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ source: 'shopify', event: 'orders/create', order: { id: 55001, email: 'flow0@example.com', total_price: '89.90', discount_codes: [CODE] } }),
  });
  assert.deepEqual(await replay.json(), { ok: true, deduped: true });

  // —— 退款扣减：GMV 归零 ——
  const refund = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ source: 'shopify', event: 'orders/update', order: { id: 55001, financial_status: 'refunded' } }),
  });
  const refundJson = await refund.json();
  assert.equal(refundJson.refunded, true);
  assert.equal(refundJson.deducted, 89.9);

  // —— bounced 剔除（bounced → email_status 剔除后续名单）——
  const bounce = await fetch(base + '/api/attribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WH_SECRET },
    body: JSON.stringify({ type: 'email.bounced', data: { message_id: 'esp_unknown', email: 'flow5@example.com' } }),
  });
  assert.equal(bounce.status, 200);
  const bounced = (await api('/api/audience')).json.audience.find((a) => a.email === 'flow5@example.com');
  assert.equal(bounced.email_status, 'email_invalid');

  // —— KPI：真实口径（1 open、1 convert 已退款 → GMV 0） ——
  const kpis = (await api('/api/state')).json.kpis;
  assert.equal(kpis.open >= 1, true);
  assert.equal(kpis.convert, 1);
  assert.equal(kpis.gmv, 0);

  // —— /api/image 只允许 output/ 目录树内文件（P1 路径穿越修复保持） ——
  const outside = await fetch(base + '/api/image/' + encodeURIComponent(path.join(__dirname, '..', 'server.js')));
  assert.equal(outside.status, 403);
});
