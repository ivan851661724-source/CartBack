'use strict';

/**
 * Wave 5 最终波后端单测：
 *   A. A4 僵尸会话收口 —— S0/S1 48h / S2 7 天边界、待办文案无数字、act closed + 审计留痕、resume 预填幂等
 *   B. E1 冲动折扣拦截 —— ≥25% 拦截 / 全量触达词 / 替代入槽 / 坚持留痕 / 大促季放宽 40% / 阈下放行
 *   C. I5 批次状态一眼看 —— ≤3 批逐批一行 / >3 批折叠 / 低打开率建议 chips /「换主题行再打」→ resend 409 确认流
 *   D. I4「已挽回」排除补全 —— 30 天窗口 / 上周刚挽回细分 / 窗口过后可再触达
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const { IGDE, extractOps } = require('../lib/igde');
const zombie = require('../lib/zombie');
const impulse = require('../lib/impulse');
const campaignsMod = require('../lib/campaigns');
const exclusion = require('../lib/exclusion');
const cfg = require('../lib/config');

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-wave5-'));
  const store = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  store.init();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function makeAct(store, { id, stage = 'S1', idleMs = 0, needs = {}, userId = 'u1' } = {}) {
  const now = Date.now();
  const act = {
    id: id || `act_${Math.random().toString(36).slice(2, 8)}`,
    stage,
    needs: { audience: null, reason: null, offer: null, goal: null, ...needs },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0,
    status: 'active', created_at: now - idleMs, updated_at: now - idleMs,
    user_id: userId
  };
  store.upsertAct(act);
  return act;
}

function makeEngine() { return new IGDE({ aiEnabled: false, criticMode: 'off' }); }

/* ================= A. A4 僵尸会话收口 ================= */

test('A4 扫描边界：S0/S1 闲置 >48h 收口、S2 闲置 >7 天才收口；窗口内不动', (t) => {
  const store = makeStore(t);
  const H = 3600 * 1000;
  makeAct(store, { id: 'act_s0_fresh', stage: 'S0', idleMs: 10 * H });
  makeAct(store, { id: 'act_s1_49h', stage: 'S1', idleMs: 49 * H, needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 } } });
  makeAct(store, { id: 'act_s2_2d', stage: 'S2', idleMs: 2 * 24 * H, needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 } } });
  makeAct(store, { id: 'act_s2_8d', stage: 'S2', idleMs: 8 * 24 * H });
  makeAct(store, { id: 'act_closed_skip', stage: 'closed', idleMs: 99 * 24 * H });

  const closed = zombie.sweepZombieActs(store, { now: Date.now() });
  const ids = closed.map(c => c.act_id).sort();
  assert.deepEqual(ids, ['act_s1_49h', 'act_s2_8d'], '只有超窗的 S1/S2 收口（S0 48h 内、S2 2 天、closed 不动）');
  assert.equal(store.getAct('act_s0_fresh').stage, 'S0');
  assert.equal(store.getAct('act_s1_49h').stage, 'closed');
  assert.equal(store.getAct('act_s2_2d').stage, 'S2', 'S2 可能正等确认，48h 不收口');
  assert.equal(store.getAct('act_s2_8d').stage, 'closed');
  assert.equal(store.getAct('act_closed_skip').stage, 'closed');
});

test('A4 待办与文案：结构化摘要（中文槽名、无进度数字）、todo 入列表、act closed 写审计', (t) => {
  const store = makeStore(t);
  makeAct(store, {
    id: 'act_half', stage: 'S1', idleMs: 50 * 3600 * 1000,
    needs: {
      audience: { value: '下单未付客户', source: 'explicit', at: 1 },
      reason: { value: '太久没动静', source: 'explicit', at: 1 }
    }
  });
  const closed = zombie.sweepZombieActs(store, { now: Date.now() });
  assert.equal(closed.length, 1);
  const summary = closed[0].summary;
  assert.ok(/挽回下单未付：/.test(summary), `摘要前缀含挽回对象：${summary}`);
  assert.ok(/已记录受众与原因/.test(summary), '已记录项（中文槽名）');
  assert.ok(/还差 优惠、目标/.test(summary), '缺失槽列表（中文槽名）');
  assert.ok(!/\d/.test(summary), '待办文案不带进度数字');
  // 待办进商家待办列表（契约①形状）
  const todos = store.getOpenTodos('u1', 20);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].act_id, 'act_half');
  assert.equal(todos[0].done, 0);
  assert.equal(todos[0].summary, summary);
  assert.ok(todos[0].id && todos[0].created_at, 'todo 带 id/created_at');
  // 收口动作写审计（events type='audit'）
  const audits = store.getEvents().filter(e => e.type === 'audit' && String(e.order_id || '').startsWith('zombie_close:'));
  assert.equal(audits.length, 1, '收口写审计事件');
  // 幂等：再扫一遍不重复收口/不重复挂待办
  const again = zombie.sweepZombieActs(store, { now: Date.now() });
  assert.equal(again.length, 0, '已 closed 的不再扫出');
  assert.equal(store.getOpenTodos('u1', 20).length, 1, '待办不重复');
});

test('A4 resume：以原 act needs/memory 复制开新 act（stage=S1 进度保留）、待办 done 幂等 409 语义', (t) => {
  const store = makeStore(t);
  const src = makeAct(store, {
    id: 'act_src', stage: 'S1', idleMs: 50 * 3600 * 1000,
    needs: {
      audience: { value: '加购未付客户', source: 'explicit', at: 1 },
      reason: { value: '太久没动静', source: 'explicit', at: 1 }
    }
  });
  src.memory.extras.push({ key: '品牌', value: 'LunaGlow', at: 1 });
  src.memory.prefs.audience = '加购未付客户';
  src.memory.prefs.reuse_at = '123';   // 复用标记应被清掉（预填语义重算）
  store.upsertAct(src);
  const [closed] = zombie.sweepZombieActs(store, { now: Date.now() });
  assert.ok(closed.todo_id, '收口产出待办');

  const todo = store.getTodo(closed.todo_id);
  const now = Date.now();
  const resumed = zombie.buildResumedAct(store.getAct('act_src'), { now });
  assert.equal(resumed.stage, 'S1', 'resume 后 stage=S1');
  assert.equal(resumed.needs.audience.value, '加购未付客户', 'needs 复制（进度保留）');
  assert.equal(resumed.needs.reason.value, '太久没动静', 'needs 复制（进度保留）');
  assert.equal(resumed.memory.extras[0].value, 'LunaGlow', 'memory 复制');
  assert.equal(resumed.memory.prefs.reuse_at, undefined, '复用标记清掉');
  assert.ok(/还差 优惠、目标/.test(resumed.messages[0].content), '开场复述待办摘要 + 追问缺失槽');
  assert.notEqual(resumed.id, 'act_src', '新 act 新 id');
  // 原待办置 done=1（幂等：再 resume → 409 语义由 server 层以 todo.done 判定）
  store.upsertAct(resumed);
  store.closeOpenActs('u1', resumed.id);
  store.markTodoDone(todo.id);
  assert.equal(store.getTodo(todo.id).done, 1, '原待办置 done');
  assert.equal(store.getAct('act_src').stage, 'closed', '原 act 保持 closed');
  assert.equal(store.getAct(resumed.id).stage, 'S1', '新会话保持 S1');
  assert.equal(store.markTodoDone(todo.id), false, '幂等：重复置 done 返回 false（server 层映射 409）');
});

/* ================= B. E1 冲动折扣拦截 ================= */

test('E1 检测单元：阈值/全量词/大促放宽（lib/config 单处常量）', () => {
  assert.equal(cfg.E1_THRESHOLD, 25);
  assert.equal(cfg.E1_THRESHOLD_SALE, 40);
  assert.equal(cfg.SALE_WINDOW_DAYS, 14);
  const d1 = impulse.detectImpulse('直接给 40% off 吧', { offerRaw: '40% off' });
  assert.equal(d1.hit, true);
  assert.equal(d1.kind, 'discount');
  assert.equal(d1.percent, 40);
  assert.equal(d1.offerRaw, '40% off');
  const d2 = impulse.detectImpulse('给全部客户发一轮', {});
  assert.equal(d2.hit, true);
  assert.equal(d2.kind, 'mass', '全量触达意图命中');
  const d3 = impulse.detectImpulse('清库存，全部清掉', {});
  assert.equal(d3.hit, true, '清库存命中');
  const d4 = impulse.detectImpulse('给 15% off 就行', {});
  assert.equal(d4.hit, false, '阈值内放行');
  const d5 = impulse.detectImpulse('给 30% off 吧', { saleWindow: true });
  assert.equal(d5.hit, false, '大促季放宽到 40 → 30% 放行');
  const d6 = impulse.detectImpulse('给 45% off 吧', { saleWindow: true });
  assert.equal(d6.hit, true, '放宽后 45% 仍拦');
  assert.equal(d6.saleRelaxed, true);
  const d7 = impulse.detectImpulse('打 6 折', {});
  assert.equal(d7.hit, true, '6 折 = 40% off 超阈值');
  assert.equal(d7.percent, 40);
});

test('E1 拦截轮：offer 不入槽、替代建议+理由+chips、pending 挂 act', async () => {
  const e = makeEngine();
  const act = {
    id: 'act_e1', stage: 'S1',
    needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 }, reason: null, offer: null, goal: null },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    code_status: 'none', filled_count: 1, status: 'active', created_at: 1, updated_at: 1, user_id: 'u1'
  };
  const r = await e.handle(act, '钩子直接给 40% off，力度大点才有人回来', {});
  assert.equal(act.needs.offer, null, 'E1：不直接入 offer 槽');
  assert.ok(act.pending_ops && act.pending_ops.e1, '拦截建议挂 act.pending_ops.e1');
  assert.equal(act.pending_ops.e1.percent, 40);
  assert.ok(/阶梯券|赠品|门槛券/.test(r.reply), '替代方案（阶梯券 满 X 减 Y / 赠品 / 门槛券 限时 48h）');
  assert.ok(/毛利/.test(r.reply), '拦截理由与毛利影响');
  assert.deepEqual(r.chips, ['换成替代方案', '就要这个折扣'], '拦截 chips');
  assert.equal(r.stage, 'S1', '拦截轮不推进 FSM');
});

test('E1 决议：用户选替代 → 替代值入 offer；坚持原意 → 照做入槽 + 审计留痕', async () => {
  const e = makeEngine();
  const audits = [];
  const executor = { audit(entry) { audits.push(entry); return { ok: true }; } };
  const act = {
    id: 'act_e1b', stage: 'S1',
    needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 }, reason: null, offer: null, goal: null },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    code_status: 'none', filled_count: 1, status: 'active', created_at: 1, updated_at: 1, user_id: 'u1'
  };
  await e.handle(act, '给 30% off 吧', { executors: executor });
  assert.equal(act.needs.offer, null);
  // 替代 → 入槽
  const rAlt = await e.handle(act, '换成替代方案', { executors: executor });
  assert.ok(act.needs.offer && /阶梯券/.test(act.needs.offer.value), '替代值入 offer 槽');
  assert.equal(act.needs.offer.source, 'explicit');
  assert.equal(act.pending_ops, null, '决议后清 pending');
  assert.ok(act.needs.offer.value.length <= 40, '替代值限长内');
  assert.equal(audits.length, 0, '选替代不留「坚持」审计');
  // 再次拦截 + 坚持 → 原值入槽 + 审计
  await e.handle(act, '改成 35%', { executors: executor });
  assert.ok(act.pending_ops && act.pending_ops.e1, '35% ≥25 再次拦截');
  const rInsist = await e.handle(act, '就要这个折扣', { executors: executor });
  assert.ok(act.needs.offer && act.needs.offer.value.includes('35%'), '坚持 → 原折扣入槽');
  assert.equal(act.pending_ops, null);
  assert.equal(audits.length, 1, '坚持留痕（建议已给，用户坚持）');
  assert.ok(/建议已给/.test(audits[0].note), '审计注明建议已给');
  assert.ok(/留痕备查/.test(rInsist.reply), '回复确认照做');
});

test('E1 大促季放宽提示 + 放弃决议回正常流水线', async (t) => {
  const store = makeStore(t);
  // 大促季：挂一个停发日历（now 落在区间后 3 天 → ±14 天内）
  const now = Date.now();
  store.addBlackout({ from: now + 3 * 86400000, to: now + 5 * 86400000, label: '黑五' });
  assert.equal(impulse.inSaleWindow(store, { now }), true, '±14 天内视为大促季');
  assert.equal(impulse.inSaleWindow(store, { now: now + 40 * 86400000 }), false, '窗口外非大促季');

  const e = makeEngine();
  const executor = { saleWindow: () => true };
  const act = {
    id: 'act_e1c', stage: 'S1',
    needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 }, reason: null, offer: null, goal: null },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    code_status: 'none', filled_count: 1, status: 'active', created_at: 1, updated_at: 1, user_id: 'u1'
  };
  await e.handle(act, '给 30% off 吧', { executors: executor });
  assert.ok(act.needs.offer && act.needs.offer.value.includes('30%'), '大促季放宽：30% 在放行线（40）下正常入槽');
  assert.ok(!act.pending_ops, '未拦截不挂 pending');
  const r2 = await e.handle(act, '给 45% off 吧', { executors: executor });
  assert.ok(act.pending_ops && act.pending_ops.e1, '放宽后 45% 仍拦截');
  assert.ok(!String(act.needs.offer.value).includes('45%'), '拦截轮 offer 不被覆盖');
  assert.ok(/放宽到 40%/.test(r2.reply), '拦截提示中说明放宽口径');
  // 放弃决议：拦截后说「先不搞了」→ 撤建议回正常流水线
  await e.handle(act, '先不搞了，算了', { executors: executor });
  assert.equal(act.pending_ops, null, '放弃 → 撤拦截建议');
});

/* ================= C. I5 批次状态一眼看 ================= */

const mkCamp = (id, name, status, reach, sent, stats) => ({ id, name, status, reach_count: reach, sent_count: sent, stats });

test('I5 汇报：≤3 批逐批一行（状态中文/已发 X/Y/回流净赚）；低打开率行尾建议 + chips', () => {
  const rep = campaignsMod.composeBatchReport([
    mkCamp('c1', 'A 加购未付', 'running', 23, 18, { opened: 1, recovered: 2, net: 108 }),   // 5.6% → 建议
    mkCamp('c2', 'B 下单未付', 'paused', 17, 10, { opened: 6, recovered: 1, net: 40 }),
    mkCamp('c3', 'C 浏览未买', 'done', 12, 12, { opened: 9, recovered: 3, net: 200 })
  ]);
  assert.equal(rep.lines.length, 3, '≤3 批逐批一行');
  assert.ok(rep.lines[0].includes('A 加购未付：发送中，已发 18/23，回流 2 单净赚 $108，建议换主题行再打一轮'), `行格式：${rep.lines[0]}`);
  assert.ok(rep.lines[1].includes('B 下单未付：已暂停，已发 10/17'), '状态中文 + 已发 X/Y');
  assert.ok(rep.lines[2].includes('C 浏览未买：已发完，已发 12/12，回流 3 单净赚 $200'), '正常行无建议');
  assert.deepEqual(rep.advised, ['c1']);
  assert.deepEqual(rep.chips, ['换主题行再打', '先不动'], '异常建议全局 chips');
});

test('I5 折叠：>3 批只报非正常态（paused/frozen/低打开），正常跑的折叠成一行计数', () => {
  const rep = campaignsMod.composeBatchReport([
    mkCamp('c1', 'A', 'running', 20, 20, { opened: 18, recovered: 2, net: 100 }),
    mkCamp('c2', 'B', 'done', 20, 20, { opened: 15, recovered: 1, net: 50 }),
    mkCamp('c3', 'C', 'scheduled', 20, 0, { opened: 0, recovered: 0, net: 0 }),
    mkCamp('c4', 'D', 'paused', 20, 4, { opened: 3, recovered: 0, net: 0 }),
    mkCamp('c5', 'E', 'running', 20, 20, { opened: 1, recovered: 0, net: 0 })   // 5% → 异常建议
  ]);
  assert.equal(rep.lines.length, 3, '折叠后 3 行：paused + 低打开 + 计数行');
  assert.ok(rep.lines[0].includes('D：已暂停'), '非正常态逐行');
  assert.ok(rep.lines[1].includes('E：发送中') && /建议换主题行再打一轮/.test(rep.lines[1]), '低打开仍逐行');
  assert.ok(/其余 3 批正常推进/.test(rep.lines[2]), '正常跑的折叠成一行计数');
  assert.deepEqual(rep.advised, ['c5']);
  // 空批次/无行 → 不产汇报（引擎不劫持对话）
  assert.equal(campaignsMod.composeBatchReport([]).reply, '');
});

test('I5 引擎短轮：「现在都在跑啥」→ 汇报；「换主题行再打」→ 对该批触发 resend 409 确认流', async () => {
  const e = makeEngine();
  const REPORTS = [
    mkCamp('cmp_a', 'A 加购未付', 'running', 23, 18, { opened: 1, recovered: 2, net: 108 }),
    mkCamp('cmp_b', 'B 下单未付', 'running', 17, 17, { opened: 9, recovered: 3, net: 189 })
  ];
  const ops = [];
  const executor = {
    listCampaignReports() { return REPORTS.map(x => ({ ...x, stats: { ...x.stats } })); },
    resolveTarget(ref) { return ref && ref.campaign_id ? { campaign_id: ref.campaign_id, name: 'A 加购未付' } : null; },
    async campaignOp(o) { ops.push(o); return { ok: false, needs_confirm: true, risk: '72 小时内已触达 18 人', risk_count: 18, campaign_id: 'cmp_a', name: 'A 加购未付' }; }
  };
  const act = {
    id: 'act_i5', stage: 'S2',
    needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 }, reason: { value: '太久', source: 'explicit', at: 1 }, offer: { value: '10% off', source: 'explicit', at: 1 }, goal: { value: '回流', source: 'explicit', at: 1 } },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    code_status: 'none', filled_count: 4, status: 'active', created_at: 1, updated_at: 1, user_id: 'u1'
  };
  const r1 = await e.handle(act, '现在都在跑啥', { executors: executor });
  assert.ok(/A 加购未付：发送中，已发 18\/23，回流 2 单净赚 \$108，建议换主题行再打一轮/.test(r1.reply), '三行汇报（异常行尾建议）');
  assert.ok(/B 下单未付：发送中，已发 17\/17，回流 3 单净赚 \$189/.test(r1.reply), '第二行口径');
  assert.deepEqual(r1.chips, ['换主题行再打', '先不动']);
  assert.equal(act.pending_ops.resend_target, 'cmp_a', '建议目标挂 resend_target');
  assert.equal(act.stage, 'S2', '查询轮不动 FSM');
  // 承接建议：「换主题行再打」→ resend 频次确认（409 语义）
  assert.deepEqual(extractOps('换主题行再打'), { kind: 'resend', target: null, subject: '' }, '换主题行再打 = resend 意图');
  const r2 = await e.handle(act, '换主题行再打', { executors: executor });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'resend');
  assert.equal(ops[0].target.campaign_id, 'cmp_a', '对该批触发 resend');
  assert.ok(/确认要再打一轮就回「确认重发」/.test(r2.reply), '409 确认语义（频次护栏）');
  assert.deepEqual(r2.chips, ['确认重发', '先不重发']);
  assert.ok(act.pending_ops.resend && act.pending_ops.resend.campaign_id === 'cmp_a', '重发确认挂 pending_ops.resend');
});

/* ================= D. I4「已挽回」排除补全 ================= */

test('I4 已挽回排除：30 天窗口内排除（近 7 天标上周刚挽回）、窗口过后可再触达', (t) => {
  const store = makeStore(t);
  const now = Date.now();
  const aud = store.getAudience();
  const [recent, older, expired, clean] = aud;
  store.addEvent({ type: 'convert', audience_id: recent.id, value: 80, ts: now - 3 * 86400000 });      // 3 天前
  store.addEvent({ type: 'convert', audience_id: older.id, value: 60, ts: now - 20 * 86400000 });     // 20 天前
  store.addEvent({ type: 'convert', audience_id: expired.id, value: 50, ts: now - 45 * 86400000 });   // 45 天前（窗外）

  const gross = [recent, older, expired, clean];
  const r = exclusion.excludeRecipients(store, gross, { now });
  const emails = r.allow.map(a => a.email);
  assert.ok(!emails.includes(recent.email) && !emails.includes(older.email), '窗口内转化过的不触达');
  assert.ok(emails.includes(expired.email) && emails.includes(clean.email), '窗口外/未转化可触达');
  const reasons = r.excluded.map(x => x.reason);
  assert.ok(reasons.some(x => /上周刚挽回/.test(x)), '近 7 天明细标「上周刚挽回」');
  assert.ok(reasons.some(x => /已挽回（近期转化）/.test(x)), '7–30 天明细「已挽回（近期转化）」');
  for (const x of r.excluded) assert.equal(x.count, 1, '逐条明细各 1 人');

  // recoveredEmails 窗口语义 + baseTargetable 同窗口（I4 补全后老库语义收敛）
  assert.deepEqual([...exclusion.recoveredEmails(store, { now })].sort(), [recent.email, older.email].sort());
  assert.deepEqual([...exclusion.recoveredEmails(store, { now, windowMs: 10 * 86400000 })], [recent.email]);
  const targetable = exclusion.baseTargetable(store, gross, { now });
  assert.ok(targetable.map(a => a.email).includes(expired.email), 'baseTargetable：窗口外转化不再终身排除');
  assert.ok(!targetable.map(a => a.email).includes(recent.email), 'baseTargetable：窗口内转化仍排除');
  // 退款单不算已挽回
  const refunded = aud[4];
  store.addEvent({ type: 'convert', audience_id: refunded.id, value: 30, ts: now - 86400000, refunded: 1 });
  assert.ok(!exclusion.recoveredEmails(store, { now }).has(refunded.email), '退款单不计已挽回');
});

test('I5/E1 不越权：无批次时「都在跑啥」不劫持对话；阈值常量与 campaignStats 同源（口径抽查）', async () => {
  const e = makeEngine();
  const act = {
    id: 'act_i5_none', stage: 'S1',
    needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 }, reason: null, offer: null, goal: null },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    code_status: 'none', filled_count: 1, status: 'active', created_at: 1, updated_at: 1, user_id: 'u1'
  };
  const executor = { listCampaignReports() { return []; } };
  const r = await e.handle(act, '现在都在跑啥', { executors: executor });
  assert.ok(r.reply && r.reply.length > 2 && !/净赚/.test(r.reply), '无批次 → 回归常规对话（不产空汇报）');
  assert.equal(campaignsMod.LOW_OPEN_RATE, 0.1, '低打开率判定线 10%');
});
