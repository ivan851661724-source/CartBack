'use strict';
/**
 * 2026-10-05 截图循环根治回归（goal 槽自家 chips 阶梯）：
 *  截图轨迹：问 goal → 点「挽回订单」→ 换皮重问 → 「先试发一封」→ 再问「比如「…」——你的情况是？」
 *  病灶：① 引擎下发的 chips（挽回订单/具体金额）自己拒收且无升级阶梯 → 原样重问循环；
 *        ② _probe 换皮前缀让断路器整句包含比对恒失配；
 *        ③ 探问句漏问号 → B5 补问守卫把同一句拼两遍；
 *        ④ 「先试发一封」= 跑通流程族口语，词表不认。
 *  阶梯契约：首点裸 chip → 收窄问数值；再点（停滞）→ 防呆强制确认卡；跑通流程族直接入槽。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE } = require('../lib/igde');
const { ensureMemory } = require('../lib/needs');

const GOAL_PROBE = '你希望拿到什么结果？挽回多少单、多少金额，还是先跑通流程？';

function deadEngine() {
  return new IGDE({
    aiEnabled: true,
    callAI: async () => { throw new Error('LLM HTTP 503'); },
    callCritic: async () => { throw new Error('LLM HTTP 503'); },
    maxLlmCallsPerTurn: 3,
    criticMode: 'suspicious'
  });
}

function mkAct(id) {
  return {
    id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [],
    memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 't'
  };
}

/** 采满前三槽（绕过对话，直接落账），把引擎逼到「正在问 goal」的截图状态 */
function warmToGoal(act) {
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: 1 };
  act.needs.offer = { value: '10% off', source: 'explicit', at: 1 };
  act.stage = 'S1';
  act.memory = ensureMemory(act.memory);
}

test('阶梯① 裸 chip「挽回订单」首点 → 收窄问数值，不入槽、不重念菜单', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder1');
  warmToGoal(act);
  const r = await igde.handle(act, '挽回订单', { persist: async () => {} });
  assert.equal(act.needs.goal, null, '裸类目无数值不入槽（C4）');
  assert.ok(/多少单/.test(r.reply), `收窄问数值，实际：${r.reply}`);
  assert.ok(!r.reply.includes(GOAL_PROBE), '不得原样重念菜单问句');
  assert.equal(act.memory.goal_bare, 1, '裸 chip 点击计数');
});

test('阶梯② 裸 chip 再点（停滞）→ 防呆强制确认卡：goal 推断补满、进 S2', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder2');
  warmToGoal(act);
  await igde.handle(act, '挽回订单', { persist: async () => {} });
  const r2 = await igde.handle(act, '挽回订单', { persist: async () => {} });
  assert.equal(act.stage, 'S2', '停滞 → 强制进 S2');
  assert.equal(act.needs.goal.value, '先跑通流程', 'goal 推断补满（先跑通流程）');
  assert.equal(act.needs.goal.source, 'inferred', '推断口径（可改）');
  assert.ok(/确认卡/.test(r2.reply), `强制弹确认卡话术，实际：${r2.reply}`);
  assert.ok(r2.planCard !== null, 'aiEnabled 档位弹预览卡（与防呆①同约定）');
});

test('阶梯③「具体金额」同阶梯：首点收窄问金额，示例 chips 跟随', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder3');
  warmToGoal(act);
  const r = await igde.handle(act, '具体金额', { persist: async () => {} });
  assert.ok(/多少钱/.test(r.reply), `收窄问金额，实际：${r.reply}`);
  assert.ok((r.chips || []).some(c => /元/.test(c)), '示例 chips 给金额例子');
});

test('阶梯④「跑通流程」chip 直接入槽（C4 合法非数值目标）→ 四齐收口', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder4');
  warmToGoal(act);
  const r = await igde.handle(act, '跑通流程', { persist: async () => {} });
  assert.equal(act.needs.goal.value, '先跑通流程');
  assert.equal(act.needs.goal.source, 'explicit', '引擎自家 chip 点击 = 用户明确选择');
  assert.equal(act.stage, 'S2');
  assert.ok(/确认/.test(r.reply), '收口引导');
});

test('阶梯⑤「先试发一封」口语 → 同跑通流程族，直接入槽（截图第二答）', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder5');
  warmToGoal(act);
  await igde.handle(act, '先试发一封', { persist: async () => {} });
  assert.equal(act.needs.goal.value, '先跑通流程', '先试发一封 = 先跑通流程');
  assert.equal(act.stage, 'S2', '截图轨迹在第 5 轮收敛，不再第三问');
});

test('阶梯⑥「我自己定」→ 引导自由输入，不入槽不强制', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder6');
  warmToGoal(act);
  const r = await igde.handle(act, '我自己定', { persist: async () => {} });
  assert.equal(act.needs.goal, null, '不代填');
  assert.equal(act.stage, 'S1', '不强制进 S2');
  assert.ok(/直接打字|比如/.test(r.reply), `引导自由输入，实际：${r.reply}`);
});

test('阶梯⑦ 采集早期 goal 非追问目标时，「先跑起来」不走收窄阶梯（受众照常被问）', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder7');
  act.stage = 'S1'; // 四槽全空，B4 指向 audience
  const r = await igde.handle(act, '先跑起来', { persist: async () => {} });
  assert.ok(!/多少单|多少钱/.test(r.reply), 'goal 非当前追问槽 → 不触发收窄阶梯');
  assert.ok(/挽回对象|召回哪拨|哪拨/.test(r.reply), `受众照常被问，实际：${r.reply}`);
});

test('断路器·问句体比对：换皮前缀（换个说法——/再帮我想想这一项就行：）不再绕过熔断', async () => {
  const igde = deadEngine();
  const act = mkAct('breaker');
  warmToGoal(act);
  // 窗口内预置两条带换皮前缀的同一问句（截图第 1、2 问的形态）
  act.messages.push({ role: 'assistant', content: `再帮我想想这一项就行：${GOAL_PROBE}`, ts: 1 });
  act.messages.push({ role: 'assistant', content: `这项还没聊到：${GOAL_PROBE}`, ts: 2 });
  act.memory = ensureMemory(act.memory);
  const before = act.memory.loop_breaks || 0;
  const broken = igde._forceBreakLoop(act, `换个说法——${GOAL_PROBE}`, 'goal');
  assert.ok(/对下账/.test(broken), `同问句三连 → 强制换装账本复述，实际：${broken}`);
  assert.equal(act.memory.loop_breaks, before + 1, '熔断计数 +1');
});

test('断路器·示例变体：「比如「例」——你的情况是？」型换皮同样计近似', async () => {
  const igde = deadEngine();
  const act = mkAct('breaker2');
  warmToGoal(act);
  act.messages.push({ role: 'assistant', content: GOAL_PROBE, ts: 1 });
  act.messages.push({ role: 'assistant', content: '比如「挽回多少单、多少金额，还是先跑通流程」——你的情况是？', ts: 2 });
  act.memory = ensureMemory(act.memory);
  const broken = igde._forceBreakLoop(act, `再帮我想想这一项就行：${GOAL_PROBE}`, 'goal');
  assert.ok(/对下账/.test(broken), '示例针命中 → 熔断换装');
});

test('B5 补问守卫：探问句已在回复中（即使漏问号）不得整句拼第二遍', async () => {
  const igde = deadEngine();
  const act = mkAct('dup');
  warmToGoal(act);
  // 连续多轮含糊输入走桩路径，任何一条回复里同一探问句最多出现 1 次
  for (const input of ['先整吧', '你看着办', '先整吧', '你看着办']) {
    const r = await igde.handle(act, input, { persist: async () => {} });
    const occurrences = r.reply.split(GOAL_PROBE).length - 1;
    assert.ok(occurrences <= 1, `探问句不得重复拼接，实际 ${occurrences} 次：${r.reply}`);
  }
});

test('阶梯⑧ 落库顺序：persist 收到的 act 必须已含本轮 user/assistant 两条消息（SSE done 帧）', async () => {
  const igde = deadEngine();
  const act = mkAct('ladder8');
  warmToGoal(act);
  let persistedLens = [];
  await igde.handle(act, '挽回订单', { persist: async (a) => { persistedLens.push(a.messages.length); } });
  // 测试 act 未预置 opening；本轮收窄轮必须 push user+assistant 两条后再落库
  assert.deepEqual(persistedLens, [2], `persist 时 act.messages 应含本轮两条消息，实际快照长度：${JSON.stringify(persistedLens)}`);
  assert.equal(act.messages.filter(m => m.role === 'user' && m.content === '挽回订单').length, 1, '用户消息已入 act');
});

test('A3 复用预填四齐 → S2 出无码预览卡（F-3：话术说确认卡就不能没有卡）', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => { throw new Error('LLM HTTP 503'); },
    callCritic: async () => true,
    maxLlmCallsPerTurn: 3, criticMode: 'suspicious'
  });
  const act = mkAct('a3card');
  const prefs = { audience: '加购未付客户', reason: '忘了结账', offer_text: '10% off', goal: '挽回 100 单', act_id: 'act_x' };
  const r = await igde.handle(act, '照上次的来', { persist: async () => {}, reusePrefs: prefs });
  assert.equal(act.stage, 'S2', '四齐进 S2');
  assert.ok(r.planCard !== null, `复用预填轮必须出预览卡，实际：${r.planCard}`);
  assert.ok(/确认卡/.test(r.reply), '话术与卡一致');
});

test('S2 满卡非确认输入 → 待确认专用话术，不落罐头、不重问已填槽', async () => {
  const igde = deadEngine();
  const act = mkAct('s2idle');
  warmToGoal(act);
  act.needs.goal = { value: '先跑通流程', source: 'explicit', at: 1 };
  act.stage = 'S2';
  for (const input of ['挽回订单', '随便看看', '挽回订单']) {
    const r = await igde.handle(act, input, { persist: async () => {} });
    assert.equal(/卡了一下|断片|没接稳/.test(r.reply), false, `满卡期不得回罐头，实际：${r.reply}`);
    assert.ok(!/最想先捞哪拨客人/.test(r.reply), '满卡期不得重问已填满的受众');
    assert.equal(act.stage, 'S2', '停留 S2');
  }
});
