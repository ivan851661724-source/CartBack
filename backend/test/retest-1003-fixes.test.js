'use strict';

/**
 * 复测报告（2026-10-03）缺陷修复回归：
 *  - P0-N3 降级轮 chip 被判离题拒答：BIZ_RE 补引擎自家词表 + 冲突 chips 桥接 + goal 数值目标词表
 *  - P1-N1 冲突决议账本滞后一轮 + 一轮两问：answered conflict 同轮 explicit 入槽、不再挂新冲突候选
 *  - P2-N2 _probeExample.goal 对齐 C4 定稿
 *  - C4 罐头守卫：模型照抄 chip 文案交 goal 槽被丢弃
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { IGDE } = require('../lib/igde');
const needsMod = require('../lib/needs');
const { conflictChips } = needsMod;

function newAct() {
  return {
    id: 'act_retest', stage: 'S0', needs: needsMod.emptyNeeds(), messages: [],
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: needsMod.emptyAskCount() },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: null
  };
}

const igde = new IGDE({ aiEnabled: false });

test('P0-N3: 降级轮点自家 chip「挽回订单」→ 收窄追问具体数值（不离题拒答、不原样重问）', async () => {
  const act = newAct();
  // 先把 audience/reason/offer 采满，本轮引擎在问 goal
  igde.applyNeeds(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
  act.stage = 'S1';
  const r = await igde.handle(act, '挽回订单', {});
  assert.ok(!/我帮不上|接不住/.test(r.reply), `降级轮不得拒答 chip，实际回复：${r.reply}`);
  assert.ok(/多少单/.test(r.reply), `裸 chip 首点 → 收窄问数值，实际回复：${r.reply}`);
  assert.ok(!/挽回多少单、多少金额/.test(r.reply), '不得原样重念菜单问句');
  assert.equal(r.askedSlot, null, '收窄轮走确定性阶梯（非 B4 探问，askedSlot=null）');
});

test('P0-N3/G-6: 降级轮「营销目标是本月挽回 100 单」goal 数值目标入槽', async () => {
  const act = newAct();
  igde.applyNeeds(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
  act.stage = 'S1';
  const r = await igde.handle(act, '营销目标是本月挽回 100 单', {});
  assert.equal(needsMod.slotText(act.needs, 'goal'), '挽回 100 单');
  assert.equal(r.stage, 'S2', '四要素齐 → S2');
});

test('P1-N1: 冲突决议轮——答 chips 选项（按 25-34 吧）同轮 explicit 入槽 + 记账 + 不再反问冲突', async () => {
  const act = newAct();
  igde.applyNeeds(act, { audience: '25 到 40 岁的美国女性', reason: '加购未付款', offer: '10% off' });
  act.stage = 'S1';
  act.memory = needsMod.ensureMemory(act.memory);
  // 上一轮：引擎已就 audience 冲突追问（asked 标记）
  act.memory.conflicts.push({ slot: 'audience', old: '25 到 40 岁的美国女性', new: '年轻人', at: Date.now(), asked: true });

  const r = await igde.handle(act, '按 25-34 吧', {});
  assert.equal(needsMod.slotText(act.needs, 'audience'), '25-34岁', '决议必须与回复同轮落库');
  assert.ok(act.memory.corrections.some(c => c.slot === 'audience' && c.new === '25-34岁'), 'corrections 同轮记账');
  assert.equal(r.askedSlot, 'goal', '冲突已解决 → 顺延问下一缺失槽（一轮一问）');
  assert.deepEqual(r.chips, ['挽回订单', '具体金额', '跑通流程', '我自己定']);
  assert.ok(!/这轮要按|还是维持原来的/.test(r.reply), '不得反问刚解决完的冲突');
});

test('P1-N1 变体: 冲突决议轮答「维持当前年龄定位」→ 保旧值、不挂新冲突', async () => {
  const act = newAct();
  igde.applyNeeds(act, { audience: '25 到 40 岁的美国女性', reason: '加购未付款', offer: '10% off' });
  act.stage = 'S1';
  act.memory = needsMod.ensureMemory(act.memory);
  act.memory.conflicts.push({ slot: 'audience', old: '25 到 40 岁的美国女性', new: '年轻人', at: Date.now(), asked: true });

  await igde.handle(act, '维持当前年龄定位', {});
  assert.equal(needsMod.slotText(act.needs, 'audience'), '25 到 40 岁的美国女性', '保旧值');
});

test('C4 罐头守卫: 模型照抄 chip 文案交 goal（挽回订单/具体金额）→ 丢弃不落槽', async () => {
  const act = newAct();
  igde.applyNeeds(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
  act.stage = 'S1';
  const igdeAI = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: '好的，那你要什么结果？', slotUpdates: [{ slot: 'goal', value: '挽回订单', confidence: 0.9 }], extras: [], corrections: [], restatement: [] }),
  });
  await igdeAI.handle(act, '挽回订单', {});
  assert.equal(needsMod.slotText(act.needs, 'goal'), '', '罐头类别词不得当作 goal 值');
});

test('P2-N2: _probeExample.goal 已对齐 C4 定稿口径', () => {
  const inst = new IGDE({ aiEnabled: false });
  assert.equal(inst._probeExample('goal'), '挽回多少单、多少金额，还是先跑通流程');
});

test('P2-N1 配套: SLOT_CHIPS.goal 四项齐发（含我自己定），conflictChips 口径不变', () => {
  assert.deepEqual(needsMod.SLOT_CHIPS.goal, ['挽回订单', '具体金额', '跑通流程', '我自己定']);
  assert.deepEqual(conflictChips('audience'), ['18-24', '25-34', '维持当前年龄定位']);
});
