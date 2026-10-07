'use strict';
/**
 * Wave 4 体验与记忆 —— 引擎/存储层单测（F1 零配置开场 / F2 对话内算账 / A3 商家记忆 / F3 通知 CRUD）：
 *   A. F1 opening({storeBanner, hasAnyAct})：欢迎语一生一次 / 数据先于提问 / chips ≤3 且含「我自己说」
 *   B. F2 算账意图：快照口径 / 运行时口径 / 无数据口径，降级与在线同口径（envelope 到了也优先确定性算账）
 *   C. A3 复用意图：prefs 预填(inferred)+逐项复述+差异追问；否认清预填；无历史不硬编
 *   D. F3 notifications CRUD：倒序 ≤50 / 未读数 / 全部与按 ids 标已读 / 200 条上限
 *   E. F3 聚合口径（lib/notify）：sends 唯一口径 / 收件人去重 / 无实发不产数字 / net 折扣成本口径
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IGDE } = require('../lib/igde');
const notify = require('../lib/notify');
const { Store } = require('../lib/store');
const execution = require('../lib/execution');

/* ---------------- 公共夹具 ---------------- */

function makeEngine(extra = {}) {
  return new IGDE({ aiEnabled: false, criticMode: 'off', ...extra });
}

function makeAct(id, stage = 'S0') {
  return {
    id, stage,
    needs: { audience: null, reason: null, offer: null, goal: null },
    messages: [],
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0,
    status: 'active', created_at: 0, updated_at: 0, user_id: 'w4'
  };
}

const CONFIRM_PREFS = {
  audience: '加购未付客户', reason: '太久没动静', offer_text: '15% off', goal: '促成复购',
  discount_percent: '15', discount_text: '折扣码 COMEBACK-AA（已在你的店铺创建 ✅）',
  brand: 'LunaGlow', signature: 'LunaGlow', act_id: 'act_old', confirmed_at: String(Date.now()), source: 'confirm'
};

/* ---------------- A. F1 零配置开场（2026-10-03 重写：清单 + 出口 chips，剧本 #23） ---------------- */

test('F1 opening：无任何 act → 欢迎语一次性拼接 + 清单 + 出口 chips（剧本 #23）', () => {
  const e = makeEngine();
  // 首次（名下无 act）→ 欢迎语开头 + 问一句话开场（未连接店铺不硬编数据）+ 清单 + 出口
  const first = e.opening({ hasAnyAct: false, storeBanner: { connected: false } });
  assert.ok(first.reply.startsWith('欢迎使用百客，我是你的专属智能邮件营销助手。'), '欢迎语在首条气泡开头');
  assert.equal(first.welcome, true);
  assert.equal(first.stage, 'S0');
  assert.ok(first.reply.includes('召回谁'), '无店铺数据 → 问一句话开场（C1 定稿话术）');
  assert.ok(first.reply.includes('我还需要的信息'), '首条气泡含「我还需要的信息」清单');
  assert.ok(first.reply.includes('发给谁') && first.reply.includes('想拿到什么结果'), '清单覆盖缺失四槽（价值化话术）');
  assert.ok(first.reply.includes('可选'), 'extras 可选项以附注呈现（C5 口径）');
  assert.ok(first.reply.includes('需要现在就编写邮件吗'), '编写邮件出口句');
  assert.ok(!/\d\s*\/\s*4/.test(first.reply), '清单无进度数字（F4 口径）');
  assert.deepEqual(first.chips, ['好，帮我写一封', '介绍一下其他功能', '其他需求'], '出口 chips 3 项（剧本 #23）');
  // 第二个 act（名下已有 act，含 closed）→ 不拼欢迎语
  const second = e.opening({ hasAnyAct: true, storeBanner: { connected: false } });
  assert.ok(!second.reply.includes('欢迎使用百客'), '欢迎语一生只出现一次');
  assert.equal(second.welcome, false);
  assert.ok(second.reply.includes('我还需要的信息'), '老用户开场仍有清单');
  // 兼容：无 opts 调用（旧调用方）不炸
  const legacy = e.opening();
  assert.ok(legacy.reply && Array.isArray(legacy.chips));
});

test('F1 opening：已连接店铺 → 数据先于清单 + 出口 chips（剧本 #23）', () => {
  const e = makeEngine();
  const op = e.opening({
    hasAnyAct: false,
    storeBanner: { connected: true, store_name: 'LunaGlow', weekly_abandoned_count: 214, aov: 45, abandoned_value: 9630, currency: 'USD' }
  });
  assert.ok(op.reply.startsWith('欢迎使用百客，我是你的专属智能邮件营销助手。'), '欢迎语仍在开头');
  const idxWelcome = op.reply.indexOf('欢迎使用百客');
  const idxData = op.reply.indexOf('我了解到你的品牌名是LunaGlow');
  const idxList = op.reply.indexOf('我还需要的信息');
  assert.ok(idxWelcome < idxData && idxData < idxList, '数据先于清单（数据先于提问）');
  assert.ok(op.reply.includes('本周214个加购未付（客单$45，弃购总额$9630）'), '数据开场句按 PRD 句式');
  assert.ok(op.chips.length <= 3, '开场 chips ≤3');
  assert.deepEqual(op.chips, ['好，帮我写一封', '介绍一下其他功能', '其他需求'], '出口 chips 3 项');
});

test('F1 opening：已连接但无数据 → 不硬编数据，问一句话开场 + 清单照常', () => {
  const e = makeEngine();
  const op = e.opening({ hasAnyAct: true, storeBanner: { connected: true } });
  assert.ok(!op.reply.includes('本周'), '无数据不硬编');
  assert.ok(!op.reply.includes('已连接'), '无店名不硬编');
  assert.ok(op.reply.includes('我还需要的信息'), '清单照常（F1 处理逻辑 6）');
  assert.deepEqual(op.chips, ['好，帮我写一封', '介绍一下其他功能', '其他需求']);
});

/* ---------------- B. F2 对话内算账 ---------------- */

test('F2 算账：快照口径（confirm 后）与账本 estGmv 同源，chips=[]，查询不推进阶段', async () => {
  const e = makeEngine();
  const act = makeAct('act_ledger_snap', 'S3');
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  act.execution_snapshot = {
    audience: '加购未付客户', reach_count: 214,
    discount: { text: 'x', code: 'C1', code_status: 'created', percent_off: 10 },
    estGmv: { amount: 925.2, currency: 'USD', formula: { people: 214, aov: 45, rate: 0.12, discount_cost: 96.3 }, source: 'store' }
  };
  const r = await e.handle(act, '这批人值多少钱？', {});
  assert.ok(/214 人/.test(r.reply) && /45/.test(r.reply) && /12%/.test(r.reply) && /96\.3/.test(r.reply) && /925\.2/.test(r.reply),
    '算账句含 人数×客单×挽回率−折扣成本 全要素');
  assert.ok(/行业参考/.test(r.reply), '口径标注：挽回率行业参考');
  assert.ok(/实数/.test(r.reply), '口径标注：店铺实数');
  assert.deepEqual(r.chips, [], '算账轮 chips=[]');
  assert.equal(r.stage, 'S3', '查询不推进/不回退阶段');
  assert.equal(r.planCard, act.plan_card || null);
});

test('F2 算账：运行时口径（未确认方案）走执行器圈人 + 挽回率 12% 行业参考（降级路径）', async () => {
  const e = makeEngine({ executors: { audienceStats: () => ({ count: 100, aov: 45, aov_source: 'reference', currency: 'USD' }) } });
  const act = makeAct('act_ledger_rt', 'S1');
  act.needs.audience = { value: '浏览未买客户', source: 'explicit', at: 1 };
  const r = await e.handle(act, '这拨人能赚多少？值不值？', {});
  assert.ok(/100 人/.test(r.reply) && /12%/.test(r.reply), '运行时算账：人数 + 行业参考挽回率');
  assert.ok(/行业默认/.test(r.reply), '口径标注：客单按行业默认');
  assert.deepEqual(r.chips, []);
});

test('F2 算账：在线路径 envelope 到了也优先用确定性算账（回复与账本同源）', async () => {
  const seen = [];
  const e = new IGDE({
    aiEnabled: true,
    criticMode: 'off',
    callAI: async (messages, opts) => {
      seen.push(1);
      return { reply: '模型口径：这批人大概值一点钱吧。', slot_updates: [], extras: [], corrections: [] };
    },
    executors: { audienceStats: () => ({ count: 50, aov: 40, aov_source: 'store', currency: 'USD' }) }
  });
  const act = makeAct('act_ledger_ai', 'S1');
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  const r = await e.handle(act, '这批人值多少钱？', {});
  assert.equal(seen.length, 1, '在线路径 B1 已调用（envelope 到了）');
  assert.ok(/50 人/.test(r.reply), '回复是确定性算账（含实数人数），不是模型话术');
  assert.ok(!r.reply.includes('大概值一点钱'), '模型话术被算账回复覆盖');
  assert.equal(r.engine, 'online');
});

test('F2 算账：圈不到人（无执行器且无数据）→ 引导先圈人，不产数字', async () => {
  const e = makeEngine();   // 无 executors、无快照
  const act = makeAct('act_ledger_empty', 'S1');
  const r = await e.handle(act, '这批人值多少钱？', {});
  assert.ok(/圈到人/.test(r.reply), '无数据支撑 → 引导先选人群');
  assert.ok(!/\d+ 人/.test(r.reply), '不硬编人数');
  assert.deepEqual(r.chips, []);
});

/* ---------------- C. A3 商家记忆（复用意图） ---------------- */

test('A3 复用意图：新会话首条「照上次的来」→ prefs 预填 inferred + 逐项复述 + 差异项追问', async () => {
  const e = makeEngine();
  const act = makeAct('act_reuse');
  act.messages.push({ role: 'assistant', content: e.opening({ hasAnyAct: true }).reply, ts: 0 });
  // 上次方案只有 audience/offer（reason/goal 缺失）→ 差异项显式追问
  const r = await e.handle(act, '照上次的来', { reusePrefs: { ...CONFIRM_PREFS, reason: '', goal: '' } });
  assert.ok(r.reply.includes('我理解为'), '复述必须带「我理解为」语义');
  assert.ok(r.reply.includes('不对请纠正'), '预填回复必须可纠正');
  assert.ok(r.reply.includes('加购未付客户') && r.reply.includes('15% off'), '逐项复述 prefs 关键参数');
  assert.ok(/跟上次没对齐的/.test(r.reply) && /2 样/.test(r.reply), '差异项显式提示（不静默沿用）');
  assert.equal(act.needs.audience.source, 'inferred', '预填 source=inferred');
  assert.equal(act.needs.offer.source, 'inferred');
  assert.equal(act.needs.reason, null, '缺失项不静默沿用');
  assert.equal(r.askedSlot, 'reason', '缺失项正常追问');
  assert.deepEqual(r.chips, ['忘记结账', '在对比价格', '我来说原因'], '追问 chips = 被问槽快捷项');
  assert.equal(r.stage, 'S1', '预填后 FSM 正常推进（S0→S1）');
  assert.equal(act.memory.prefs.reuse_slots, 'audience,offer', '复用标记挂 memory.prefs');
});

test('A3 复用意图：四样全齐 → 直接引导确认；否认「别用上次的」→ 清空预填回采集', async () => {
  const e = makeEngine();
  const act = makeAct('act_reuse_deny');
  act.messages.push({ role: 'assistant', content: e.opening({ hasAnyAct: true }).reply, ts: 0 });
  const r1 = await e.handle(act, '跟上次一样', { reusePrefs: CONFIRM_PREFS });
  assert.ok(/四样都和上次对齐了/.test(r1.reply), '全齐 → 引导确认');
  assert.equal(r1.stage, 'S2');
  assert.equal(r1.askedSlot, null);

  const r2 = await e.handle(act, '别用上次的', {});
  assert.ok(/上次的先不用/.test(r2.reply), '否认复用被接住');
  assert.equal(act.needs.audience, null, '预填槽被清空');
  assert.equal(act.needs.offer, null);
  assert.equal(act.memory.prefs.reuse_at, undefined, '复用标记清除');
  assert.equal(r2.askedSlot, 'audience', '清空后回 S1 正常采集（问第一槽）');
  assert.deepEqual(r2.chips, ['加购未付', '浏览未买', '老客']);
});

test('A3 复用意图：无历史方案不硬编；非首条消息不接手', async () => {
  const e = makeEngine();
  const act = makeAct('act_reuse_nohist');
  act.messages.push({ role: 'assistant', content: e.opening({ hasAnyAct: true }).reply, ts: 0 });
  const r = await e.handle(act, '上个月那套', {});
  assert.ok(/没翻到你上次确认过的方案/.test(r.reply), '无历史如实说');
  assert.equal(r.askedSlot, 'audience');

  // 第二条用户消息再喊「照上次的来」→ 不重复接手（正常对话流）
  const act2 = makeAct('act_reuse_second');
  act2.messages.push({ role: 'assistant', content: e.opening({ hasAnyAct: true }).reply, ts: 0 });
  await e.handle(act2, '加购未付的客户', {});
  const r2 = await e.handle(act2, '照上次的来', { reusePrefs: CONFIRM_PREFS });
  assert.ok(!/我理解为/.test(r2.reply) || act2.needs.audience.source === 'explicit', '非首条消息不走复用预填');
});

/* ---------------- D. F3 notifications CRUD ---------------- */

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave4-unit-'));
  const store = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  store.init();
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return store;
}

test('F3 notifications CRUD：倒序 ≤50 / 未读数 / 全部与按 ids 标已读 / 200 条上限', (t) => {
  const store = makeStore(t);
  for (let i = 0; i < 3; i++) store.addNotification({ user_id: 'u1', type: 't0', title: 't' + i, body: 'b' + i, created_at: 1000 + i });
  store.addNotification({ user_id: 'u2', type: 'recover', title: 'other', body: 'x' });
  assert.equal(store.getNotifications('u1').length, 3, '按用户隔离');
  assert.equal(store.getNotifications('u1')[0].title, 't2', 'created_at 倒序');
  assert.equal(store.unreadNotificationCount('u1'), 3);
  assert.equal(store.markNotificationsRead('u1'), 3, '缺省全标已读');
  assert.equal(store.unreadNotificationCount('u1'), 0);
  const n = store.addNotification({ user_id: 'u1', type: 't24', title: 'new', body: 'b', chips: ['再打一轮'] });
  assert.equal(store.markNotificationsRead('u1', ['nope', n.id]), 1, '按 ids 标已读');
  // 200 条上限
  for (let i = 0; i < 250; i++) store.addNotification({ user_id: 'u1', type: 'system', title: 's' + i });
  assert.equal(store.getNotifications('u1', 10000).length, 200, '表上限 200 防膨胀');
  assert.equal(store.getNotifications('u1', 50).length, 50, '接口层 ≤50');
});

/* ---------------- E. F3 聚合口径（lib/notify） ---------------- */

test('F3 聚合：sends 唯一口径 + 收件人去重；无实发返回 null（不产数字）', (t) => {
  const store = makeStore(t);
  store.addAudience([
    { name: '甲', email: 'a@x.com', intent: '加购未付', abandoned_value: 100 },
    { name: '乙', email: 'b@x.com', intent: '加购未付', abandoned_value: 200 }
  ]);
  const byMail = Object.fromEntries(store.getAudience().map(a => [a.email, a]));
  assert.equal(notify.aggregateReceipt(store, { draftId: 'dr_none' }), null, '无实发 → null');

  store.recordSendRow({ act_id: 'act_1', campaign_id: 'dr_1', recipient: 'a@x.com', status: 'sent' });
  store.recordSendRow({ act_id: 'act_1', campaign_id: 'dr_1', recipient: 'b@x.com', status: 'sent' });
  // 甲开 2 次仍算 1；乙点 1 次；甲转化 $88（幂等 order_id）
  store.addEvent({ type: 'open', draft_id: 'dr_1', audience_id: byMail['a@x.com'].id });
  store.addEvent({ type: 'open', draft_id: 'dr_1', audience_id: byMail['a@x.com'].id });
  store.addEvent({ type: 'click', draft_id: 'dr_1', audience_id: byMail['b@x.com'].id });
  store.addEvent({ type: 'convert', draft_id: 'dr_1', audience_id: byMail['a@x.com'].id, value: 88, order_id: 'o1' });
  // 未实发的人的互动不计入（sends 唯一口径）
  store.addEvent({ type: 'open', draft_id: 'dr_1', audience_id: 'aud_ghost' });
  const agg = notify.aggregateReceipt(store, { draftId: 'dr_1', actId: 'act_1' });
  assert.deepEqual(
    { sent: agg.sent, opened: agg.opened, clicked: agg.clicked, recovered: agg.recovered, gmv: agg.gmv, unopened: agg.unopened },
    { sent: 2, opened: 1, clicked: 1, recovered: 1, gmv: 88, unopened: 1 }
  );
  // 退款扣减后不计
  const conv = store.getEvents().find(e => e.type === 'convert');
  store.updateEvent(conv.id, { value: 0, refunded: 1 });
  assert.equal(notify.aggregateReceipt(store, { draftId: 'dr_1' }).recovered, 0, '退款单不计回流');
});

test('F3 文案：t24 回执含实发/打开/点击/回流 + 下一步建议 + chips；t0 一句话', (t) => {
  const store = makeStore(t);
  store.addAudience([{ name: '甲', email: 'a@x.com', intent: '加购未付', abandoned_value: 100 }]);
  const a = store.getAudience().find(x => x.email === 'a@x.com');
  store.recordSendRow({ act_id: 'act_1', campaign_id: 'dr_1', recipient: 'a@x.com', status: 'sent' });
  store.addEvent({ type: 'open', draft_id: 'dr_1', audience_id: a.id });
  const agg = notify.aggregateReceipt(store, { draftId: 'dr_1', actId: 'act_1' });
  const t24 = notify.buildT24Notification({ name: 'A 加购未付', agg });
  assert.equal(t24.type, 't24');
  assert.ok(/「A 加购未付」发出 1 封：打开 1、点击 0、回流 0 单/.test(t24.body), 't24 数字句式');
  assert.ok(/要给没打开的 0 人/.test(t24.body) === false);
  assert.deepEqual(t24.chips, ['再打一轮', '换主题行', '先不动']);
  const t0 = notify.buildT0Notification({ name: 'A 加购未付', agg, code: 'C9' });
  assert.equal(t0.type, 't0');
  assert.ok(/已发出 1 封（码 C9）/.test(t0.body), 't0 一句话 + 实发数');
});

test('F3 campaignStats：net = 订单金额 − 折扣成本估算（退款不计）；actActual 跨草稿+批次聚合', (t) => {
  const store = makeStore(t);
  store.addAudience([{ name: '甲', email: 'a@x.com', intent: '加购未付', abandoned_value: 100 }]);
  const a = store.getAudience().find(x => x.email === 'a@x.com');
  store.recordSendRow({ act_id: 'act_1', campaign_id: 'cmp_1', recipient: 'a@x.com', status: 'sent' });
  store.upsertCampaign({ id: 'cmp_1', act_id: 'act_1', name: 'A 加购未付', audience_desc: '加购未付', status: 'done', discount: { text: '', code: 'C1', code_status: 'created', percent_off: 10 } });
  store.addEvent({ type: 'open', draft_id: 'cmp_1', audience_id: a.id });
  store.addEvent({ type: 'convert', draft_id: 'cmp_1', audience_id: a.id, value: 100, order_id: 'o2' });
  const stats = notify.campaignStats(store, { id: 'cmp_1', discount: { percent_off: 10 } });
  assert.deepEqual(stats, { opened: 1, clicked: 0, recovered: 1, gmv: 100, net: 90 }, 'net = 100 × (1−10%) = 90（折扣成本口径）');
  // actActual：草稿 + 批次两个 scope 聚合
  store.upsertDraft({ id: 'dr_9', act_id: 'act_1', audience: 'x', created_at: 1 });
  store.addEvent({ type: 'convert', draft_id: 'dr_9', audience_id: a.id, value: 50, order_id: 'o3' });
  const actual = notify.actActual(store, 'act_1');
  assert.equal(actual.gmv, 150, 'actActual = 草稿 + 批次实收合计');
  assert.equal(actual.orders, 2);
  assert.equal(actual.source, 'actual');
});
