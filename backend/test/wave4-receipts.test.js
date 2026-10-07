'use strict';
/**
 * Wave 4 体验与记忆 —— HTTP 端到端（spawn 真进程）：
 *   F1 零配置开场：welcome.eligible 判定 + 首个 act 拼欢迎语 / 第二个 act 不拼 + store_banner 数据源
 *   A3 商家记忆：confirm 沉淀 prefs → /api/state 顶层 prefs/last_plan → 新 act「照上次的来」预填 inferred
 *   F2 对话内算账：快照口径（confirm 后）与运行时口径（执行器圈人）都出同口径算账句
 *   F3 主动回执：T+0 一句话 / T+24h 汇总（jobs run_after 到点触发）/ 回流报喜 + estGmv 翻转回填
 *               + 批次 stats 回填（recovered/net）+ 通知中心读接口（未读数/标记已读）
 * 数字口径：全部只算实发（sends 表）；无 sends 支撑的通知不产数字。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const execution = require('../lib/execution');

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

function fakeNowAtHour(nyHour) {
  let ts = Date.now();
  for (let i = 0; i < 36; i++) {
    if (execution.localHourIn('America/New_York', ts) === nyHour) return ts;
    ts += 3600 * 1000;
  }
  return ts;
}

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave4-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    stores: [{ type: 'mock', shop: 'W4Shop' }],
    publicBaseUrl: 'https://e2e.example'
  }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), EY_SERVER_DIR: dir, CARTBACK_OPEN_LOCAL: '1', CARTBACK_FAKE_NOW: String(fakeNowAtHour(12)) },
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
    const headers = { 'Content-Type': 'application/json', 'x-local-token': token };
    if (opts.secret) headers['x-webhook-secret'] = opts.secret;
    const r = await fetch(base + p, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 1500))]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { api, dir, base };
}

async function waitFor(api, jobId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await api(`/api/jobs/${jobId}`);
    if (['done', 'failed'].includes(j.json.status)) return j.json;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor job timeout');
}

async function poll(api, fn, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function fillAndConfirm(api, preset) {
  const act = await api('/api/act', { method: 'POST', body: { preset: { audience: preset } } });
  const actId = act.json.act.id;
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '挽回原因是太久没动静了' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '折扣给 12% off 就行' } });
  await api(`/api/act/${actId}/message`, { method: 'POST', body: { message: '希望他们回来完成付款' } });
  const cf = await api(`/api/act/${actId}/confirm`, { method: 'POST', body: {} });
  assert.equal(cf.status, 200, 'confirm ok: ' + JSON.stringify(cf.json).slice(0, 200));
  return { ...cf.json, actId };
}

/* ---------------- F1：welcome / store_banner ---------------- */

test('F1：首个 act 拼欢迎语一次性；第二个 act 不拼；state 顶层 welcome/store_banner 契约', async (t) => {
  const { api } = await startServer(t);
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });

  // 名下无任何 act → welcome.eligible=true；store_banner 已连接（mock 店）
  const st0 = await api('/api/state');
  assert.equal(st0.json.welcome.eligible, true, '无 act → 欢迎语资格');
  assert.ok(st0.json.welcome.opening && st0.json.welcome.opening.includes('欢迎使用百客'), 'Z4 opening 预览随 state 下发（剧本 #23：不输入也见首条气泡）');
  assert.ok(st0.json.welcome.opening.includes('我还需要的信息'), 'opening 预览含清单');
  assert.deepEqual(st0.json.welcome.chips, ['好，帮我写一封', '介绍一下其他功能', '其他需求'], '出口 chips 3 项随 state 下发');
  assert.equal(st0.json.last_plan, null, '尚无确认方案 → last_plan=null');
  assert.equal(st0.json.store_banner.connected, true, 'mock 店已连接');
  assert.equal(typeof st0.json.prefs, 'object', 'state 顶层 prefs 字段在');

  // 第一个 act：欢迎语开头 + 开场 chips
  const a1 = await api('/api/act', { method: 'POST', body: {} });
  assert.equal(a1.status, 200);
  const firstMsg = a1.json.act.messages[0].content;
  assert.ok(firstMsg.startsWith('欢迎使用百客，我是你的专属智能邮件营销助手。'), '首条气泡开头拼欢迎语');
  assert.equal(a1.json.welcome, true);
  assert.ok(Array.isArray(a1.json.chips) && a1.json.chips.includes('其他需求'), '开场 chips 含自由输入出口（F1 出口 chips · 剧本 #23）');
  assert.equal(a1.json.store_banner.connected, true, 'act 响应带 store_banner');

  // 第一个 act 存在后 → welcome.eligible 翻 false；第二个 act 不再拼欢迎语
  const st1 = await api('/api/state');
  assert.equal(st1.json.welcome.eligible, false, '有 act（含 closed）→ 资格关闭');
  const a2 = await api('/api/act', { method: 'POST', body: {} });
  assert.ok(!a2.json.act.messages[0].content.includes('欢迎使用百客'), '第二个 act 不拼欢迎语');
  assert.equal(a2.json.welcome, false);
});

/* ---------------- A3 + F2：prefs 沉淀 / last_plan / 复用意图 / 算账 ---------------- */

test('A3+F2：confirm 沉淀 prefs + last_plan；新 act「照上次的来」预填 inferred；算账同口径', async (t) => {
  const { api } = await startServer(t);
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });

  const c1 = await fillAndConfirm(api, '加购未付');
  assert.equal(c1.planCard.discount.code_status, 'created');

  // —— state 顶层：prefs（A3① 沉淀）与 last_plan（A3④ 摘要）——
  const st = await api('/api/state');
  const prefs = st.json.prefs;
  assert.ok(prefs && prefs.source === 'confirm', 'prefs 来自 confirm 沉淀');
  assert.ok(String(prefs.audience).includes('加购未付'), 'prefs.audience');
  assert.equal(prefs.discount_percent, '12', 'prefs.discount_percent');
  assert.equal(prefs.brand, 'MyBrand', 'prefs.brand/signature');
  assert.equal(prefs.signature, 'MyBrand');
  const lp = st.json.last_plan;
  assert.ok(lp, 'last_plan 摘要在（最近一个确认过的 act）');
  assert.ok(String(lp.audience).includes('加购未付'), 'last_plan.audience');
  assert.equal(lp.currency, 'USD');
  assert.ok(lp.est_gmv_amount > 0, 'last_plan.est_gmv_amount（预估）');
  assert.ok(lp.confirmed_at > 0, 'last_plan.confirmed_at');
  assert.equal(lp.discount_text.includes('COMEBACK'), true, 'last_plan.discount_text 含真实码');
  const persisted = st.json.acts.find(a => a.id === c1.actId);
  assert.equal(persisted.memory.prefs.source, 'confirm', 'act.memory.prefs 已落库');

  // —— F2 快照口径算账（confirm 后，S3 内提问）——
  const ledger = await api(`/api/act/${c1.actId}/message`, { method: 'POST', body: { message: '这批人值多少钱？值不值？' } });
  assert.equal(ledger.status, 200);
  assert.ok(/9 人/.test(ledger.json.reply), '算账句含实圈人数（未付族 9 人）');
  assert.ok(/12%/.test(ledger.json.reply) && /行业参考/.test(ledger.json.reply), '挽回率 12% 行业参考标注');
  assert.ok(/42\.77/.test(ledger.json.reply), '与账本 estGmv 同源（9×45×12%−折扣成本=42.77）');
  assert.deepEqual(ledger.json.chips, [], '算账轮 chips=[]');

  // —— A3②：新 act「照上次的来」→ prefs 预填 inferred + 复述 ——
  const a2 = await api('/api/act', { method: 'POST', body: {} });
  const act2 = a2.json.act.id;
  const reuse = await api(`/api/act/${act2}/message`, { method: 'POST', body: { message: '照上次的来' } });
  assert.equal(reuse.status, 200);
  assert.ok(reuse.json.reply.includes('我理解为') && reuse.json.reply.includes('不对请纠正'), '复用回复带纠正语义');
  assert.ok(reuse.json.reply.includes('12% off'), '复述上次钩子');
  assert.equal(reuse.json.needs.audience.source, 'inferred', '预填 source=inferred');
  assert.equal(reuse.json.needs.offer.source, 'inferred');
  const stReuse = await api('/api/state');
  const act2Row = stReuse.json.acts.find(a => a.id === act2);
  assert.ok(act2Row.memory.prefs.reuse_slots, '复用标记挂 prefs（落库）');

  // —— A3③：否认复用 → 清空预填回采集 ——
  const deny = await api(`/api/act/${act2}/message`, { method: 'POST', body: { message: '别用上次的' } });
  assert.ok(/上次的先不用/.test(deny.json.reply), '否认被接住');
  assert.equal(deny.json.needs.audience, null, '预填清空');
});

/* ---------------- F3：t0 / t24 / 回流报喜 / 通知中心 ---------------- */

test('F3：发送完成 T+0 回执 + T+24h 汇总 job 到点产出 + 通知中心读接口', async (t) => {
  const { api, dir } = await startServer(t);
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const secret = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).webhookSecret;

  const c = await fillAndConfirm(api, '加购未付');
  const s = await api(`/api/draft/${c.draft_id}/send`, { method: 'POST', body: {} });
  assert.equal(s.status, 202);
  const job = await waitFor(api, s.json.job_id);
  assert.equal(job.status, 'done');
  assert.equal(job.result.recipients, 9, '未付族实发 9 人');

  // —— T+0 一句话回执（数字 = 实发数）——
  const n0 = await poll(api, async () => {
    const list = await api('/api/notifications');
    return list.json.items.find(n => n.type === 't0');
  });
  assert.ok(/已发出 9 封/.test(n0.body), 'T+0 一句话含实发数：' + n0.body);
  assert.equal(n0.draft_id, c.draft_id, 't0 关联 draft');
  assert.equal(n0.read, 0, '未读');

  // —— T+24h job 已排队（run_after=+24h），把 run_after 拨到过去 + 触发队列 tick ——
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const pending = db.prepare("SELECT id, run_after FROM jobs WHERE type = 'receipt_24h' AND status = 'pending'").all();
  assert.equal(pending.length, 1, 'receipt_24h job 已入队');
  assert.ok(Number(pending[0].run_after) > Date.now(), 'run_after 在 24h 后');
  db.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").run(pending[0].id);
  db.close();
  await api('/api/posters', { method: 'POST', body: { draftId: c.draft_id } });   // 任意入队 → _tick 拾取到期 job

  const n24 = await poll(api, async () => {
    const list = await api('/api/notifications');
    return list.json.items.find(n => n.type === 't24');
  });
  assert.ok(/「加购未付」发出 9 封：打开 \d+、点击 \d+、回流 \d+ 单/.test(n24.body), 't24 汇总句式（sends 口径）：' + n24.body);
  assert.deepEqual(n24.chips, ['再打一轮', '换主题行', '先不动'], 't24 下一步建议 chips');
  assert.equal(n24.draft_id, c.draft_id);

  // —— 通知中心：未读数 / 倒序 ≤50 / 全部与按 ids 标已读 ——
  const list = await api('/api/notifications');
  assert.equal(list.json.ok, true);
  assert.ok(list.json.items.length >= 2 && list.json.items.length <= 50);
  assert.ok(list.json.unread >= 2, '未读数 ≥2（t0+t24）');
  assert.ok(list.json.items[0].created_at >= list.json.items[1].created_at, 'created_at 倒序');
  const readAll = await api('/api/notifications/read', { method: 'POST', body: {} });
  assert.equal(readAll.json.ok, true);
  assert.equal(readAll.json.unread, 0, '全标已读');

  // —— 回流报喜：attribution conversion → 即时通知 + estGmv 翻转回填 ——
  const conv = await api('/api/attribution', {
    method: 'POST', secret,
    body: { type: 'convert', draft_id: c.draft_id, audience_id: null, value: 88.5, order_id: 'ord_w4_1', coupon: c.planCard.discount.code }
  });
  assert.equal(conv.status, 200);
  const rec = await poll(api, async () => {
    const l = await api('/api/notifications');
    return l.json.items.find(n => n.type === 'recover');
  });
  assert.ok(/用码/.test(rec.body) && /88\.5/.test(rec.body), '回流报喜文案含码与订单金额：' + rec.body);
  const st2 = await api('/api/state');
  const act1 = st2.json.acts.find(a => a.id === c.actId);
  assert.ok(act1.plan_card.actual, 'estGmv 翻转数据写回 act.plan_card.actual');
  assert.equal(act1.plan_card.actual.source, 'actual');
  assert.equal(act1.plan_card.actual.gmv, 88.5, '实际 GMV 只包含注入的归因订单');
  assert.ok(st2.json.last_plan.actual, 'last_plan 带翻转数据（前端预估→实际）');
});

test('F3：批次发送 → t0/t24 指向 campaign；订单核销 → 回流报喜 + campaign stats 回填（recovered/net）', async (t) => {
  const { api, dir } = await startServer(t);
  await api('/api/config', { method: 'POST', body: { shopBrand: 'MyBrand' } });
  const secret = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).webhookSecret;

  // 建批（浏览未买 3 人）+ 发送
  const cr = await api('/api/campaigns', {
    method: 'POST',
    body: { batches: [{ audience_desc: '浏览未买', offer_text: '10% off' }] }
  });
  assert.equal(cr.status, 200);
  const camp = cr.json.campaigns[0];
  assert.ok(camp.discount.code, '批次独立码');
  assert.deepEqual(camp.stats, { opened: 0, clicked: 0, recovered: 0, gmv: 0, net: 0 }, '发送前 stats 全 0');
  const send = await api(`/api/campaigns/${camp.id}/send`, { method: 'POST', body: {} });
  assert.equal(send.status, 202);
  await waitFor(api, send.json.job_id);

  // t0 指向 campaign（实发 3 人 = 种子浏览未买）
  const n0 = await poll(api, async () => {
    const list = await api('/api/notifications');
    return list.json.items.find(n => n.type === 't0' && n.campaign_id === camp.id);
  });
  assert.ok(/已发出 3 封/.test(n0.body), '批次 t0 一句话（sends 口径）：' + n0.body);

  // Shopify 订单核销批次码 → convert 归因到批次 scope + 回流报喜 + stats 回填
  const order = await api('/api/attribution', {
    method: 'POST', secret,
    body: {
      source: 'shopify', event: 'orders/create',
      order: { id: 'ord_w4_c1', email: 'qiao.bai@example.com', total_price: '120.00', discount_codes: [camp.discount.code] }
    }
  });
  assert.equal(order.json.attributed, true, '批次码核销归因');
  const rec = await poll(api, async () => {
    const list = await api('/api/notifications');
    return list.json.items.find(n => n.type === 'recover' && n.campaign_id === camp.id);
  });
  assert.ok(/白桥/.test(rec.body) && /120/.test(rec.body), '回流报喜（顾客名 + 金额）：' + rec.body);

  // stats 回填：recovered=1；net = 120 × (1−10%) = 108（订单金额 − 折扣成本估算）
  const list = await api('/api/campaigns');
  const after = list.json.campaigns.find(x => x.id === camp.id);
  assert.equal(after.stats.recovered, 1, 'campaign.stats.recovered 回填');
  assert.equal(after.stats.net, 108, 'net = 订单金额 − 折扣成本估算（10%）');
  assert.equal(after.stats.opened, 0, '打开数按实发收件人口径（无打开事件为 0）');

  // t24 到点：批次口径汇总（拨 run_after 到过去；用一张已确认方案的草稿入队 posters 触发队列 tick）
  const helper = await fillAndConfirm(api, '加购未付');   // 只确认不发送：提供真实 draftId 供 posters 入队
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const pending = db.prepare("SELECT id FROM jobs WHERE type = 'receipt_24h' AND status = 'pending'").all();
  assert.equal(pending.length, 1, '批次 receipt_24h 已入队');
  db.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").run(pending[0].id);
  db.close();
  await api('/api/posters', { method: 'POST', body: { draftId: helper.draft_id } });   // 任意入队 → _tick 拾取到期 job
  const n24 = await poll(api, async () => {
    const list2 = await api('/api/notifications');
    return list2.json.items.find(n => n.type === 't24' && n.campaign_id === camp.id);
  });
  assert.ok(/「[^」]+」发出 3 封：打开 \d+、点击 \d+、回流 1 单（\$120）/.test(n24.body), '批次 t24 汇总（回流含核销订单）：' + n24.body);
});
