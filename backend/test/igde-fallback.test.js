'use strict';

/**
 * 09-30 测试报告缺陷修复回归（P1-2 变体 / P1-3）：
 *  - 护栏替换兜底：问句按 B4 当前缺口生成并与 chips 同源（不再用 FALLBACK_POOL 完整句错位、不重复问已填槽）
 *  - 模型口头核实旧值但未交 slot_updates → 引擎检测并重绑 chips 到被核实的槽（冲突 chips）
 *  - ask_count 只记本轮实际追问的槽
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { IGDE } = require('../lib/igde');
const needsMod = require('../lib/needs');
const { conflictChips, SLOT_CHIPS } = needsMod;

function newAct() {
  return {
    id: 'act_fb', stage: 'S0', needs: needsMod.emptyNeeds(), messages: [],
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: needsMod.emptyAskCount() },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: null
  };
}

function prefilledAct() {
  const act = newAct();
  const igde = new IGDE({ aiEnabled: false });
  igde.applyNeeds(act, { audience: '25-40 岁的美国女性', reason: '加购未付款', offer: '10% off' });
  act.stage = 'S1';
  return act;
}

test('P1-3: 护栏 L2 替换后——兜底句按 B4 缺口追问 goal，chips 与问句同源，不重复问已填槽', async () => {
  let calls = 0;
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => {
      calls++;
      if (calls === 1) return { reply: '第一步你要先做A，第二步务必做B，按步骤来就行。', slotUpdates: [], extras: [], corrections: [], restatement: [] };
      throw new Error('regen down'); // 重生成失败 → 走兜底
    },
    callCritic: null
  });
  const act = prefilledAct();
  const r = await igde.handle(act, '嗯嗯', { locale: 'en', persist: () => {} });

  assert.ok(r.guardrailHits.includes('L2'), `应命中 L2 兜底: ${r.guardrailHits}`);
  // 问句必须是 goal 探问（B4 唯一缺失槽），而不是 FALLBACK_POOL 的「问受众」完整句
  assert.ok(r.reply.includes('拿到什么结果'), `兜底句应追问 goal: ${r.reply}`);
  assert.ok(!r.reply.includes('你最想先捞哪拨客人'), '不得复用旧 FALLBACK_POOL 问受众句');
  assert.deepEqual(r.chips, SLOT_CHIPS.goal, `chips 与追问槽同源: ${JSON.stringify(r.chips)}`);
  assert.equal(r.askedSlot, 'goal');
  // 记账：goal +1；已填槽不得被追问/计数
  assert.equal(act.memory.ask_count.goal, 1);
  assert.equal(act.memory.ask_count.audience, 0);
});

test('P1-3: 兜底在冲突轮保持冲突槽（C6 语义不丢）', async () => {
  const igde = new IGDE({ aiEnabled: false });
  const act = prefilledAct();
  const question = { slot: 'audience', chips: conflictChips('audience'), kind: 'conflict' };
  const fb = igde._fallbackWithProbe(act, question, [{ slot: 'audience', old: '25-40 岁的美国女性', new: '45 岁以上中年人' }]);
  assert.ok(fb.reply.includes('25-40 岁的美国女性'), `兜底句应复述冲突旧值: ${fb.reply}`);
  assert.ok(fb.reply.includes('以哪个为准') || fb.reply.includes('45 岁以上中年人'), `应带核实问句: ${fb.reply}`);
  assert.equal(fb.slot, 'audience');
});

test('P1-3: 四槽全满时兜底走收口引导，不追问（slot=null）', () => {
  const igde = new IGDE({ aiEnabled: false });
  const act = prefilledAct();
  igde.applyNeeds(act, { goal: '本月挽回 100 单' });
  const fb = igde._fallbackWithProbe(act, { slot: null, chips: [], kind: 'none' }, []);
  assert.equal(fb.slot, null);
  assert.ok(fb.reply.includes('确认'), `应收口引导: ${fb.reply}`);
});

test('P1-2 变体: _detectVerifyReply——问句提到已填槽旧值+核实口吻 → 命中该槽', () => {
  const igde = new IGDE({ aiEnabled: false });
  const act = prefilledAct();
  const reply = '好嘞。不过你刚说客户是 25-40 岁的美国女性，现在又说是 45 岁以上的中年人，这两拨人差别挺大，到底以哪个为准？';
  assert.deepEqual(igde._detectVerifyReply(reply, act), { slot: 'audience' });
});

test('P1-2 变体: _detectVerifyReply——旧值只出现在陈述句（非问句）不误判', () => {
  const igde = new IGDE({ aiEnabled: false });
  const act = prefilledAct();
  const reply = '10% off 挺合适的。那咱们这次发信，主要想达到啥目的呢？';
  assert.equal(igde._detectVerifyReply(reply, act), null);
});

test('P1-2 变体: 全轮对齐——模型口头核实未交 update 时，chips 重绑为冲突 chips', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({
      reply: '好嘞。不过你刚说客户是 25-40 岁的美国女性，现在又说是 45 岁以上的中年人，这两拨人差别挺大，到底以哪个为准？',
      slotUpdates: [], extras: [], corrections: [], restatement: []
    }),
    callCritic: null
  });
  const act = prefilledAct();
  const r = await igde.handle(act, '客户主要是 45 岁以上的中年人', { locale: 'en', persist: () => {} });
  assert.deepEqual(r.chips, conflictChips('audience'), `chips 应重绑为冲突 chips: ${JSON.stringify(r.chips)}`);
  assert.equal(r.askedSlot, 'audience');
  assert.equal(act.memory.ask_count.goal, 0, 'B4 预决策的 goal 不应被计数（实际问的是受众核实）');
});
