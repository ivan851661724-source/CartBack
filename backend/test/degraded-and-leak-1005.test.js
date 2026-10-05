'use strict';
/**
 * 2026-10-05 视频 bug 修复回归：
 *  ① AI 宕机期罐头循环根治——桩路径豁免「模型向」护栏（REPEAT 重生成 / L2 critic / L4），
 *     降级回复按 G2 走状态机（追问轮换、S2 收口引导），绝不落 FALLBACK_CATCH 罐头。
 *  ② 模型把 slot_updates JSON 泄漏为用户可见回复 → 引擎吸收进 B1（过原文依据校验），
 *     reply 只留人话；goal 裸类别词仍按 PRD C4（P2-N4）丢弃等补值。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE } = require('../lib/igde');

const CANNED_RE = /卡了一下|断片|没接稳/;

function deadEngine() {
  // 全链故障注入：callAI / callCritic 全部 503（模拟视频录制时的网关宕机）
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

const VIDEO_SEQ = ['我想挽回加购未付的客户', '他们忘记结账了', '折扣给 10% off', '挽回订单', '挽回订单', '挽回订单', '跑通流程', '可以'];

test('① AI 全宕机重放视频序列：0 罐头、状态机持续追问、S2 收口引导不被 L4 误杀', async () => {
  const igde = deadEngine();
  const act = mkAct('outage');
  const replies = [];
  for (const input of VIDEO_SEQ) {
    const r = await igde.handle(act, input, { persist: async () => {} });
    assert.equal(CANNED_RE.test(r.reply), false, `「${input}」不得回罐头兜底，实际：${r.reply}`);
    replies.push(r.reply);
  }
  // 追问轮换：连续 goal 追问（裸 chip ×3）不逐字重复（桩 _probe 变体轮换）
  const goalAsks = replies.slice(3, 6);
  assert.notEqual(goalAsks[0], goalAsks[1], 'goal 追问须轮换说法（防复读）');
  // 跑通流程 → goal 入槽 + 收口引导（含「确认卡」权威话术，未被 L4 打成罐头）
  assert.equal(act.needs.goal.value, '先跑通流程', 'goal=先跑通流程（C4 合法非数值目标）');
  assert.ok(/确认/.test(replies[6]), '满卡收口引导照常');
  // S2 确认轮「可以」→ 确认引导（非罐头、非空转）
  assert.ok(/确认|核对/.test(replies[7]), 'S2「可以」得到确认引导');
  assert.equal(act.stage, 'S2', '停留 S2（确认动作走 /confirm）');
  // 全程降级档位诚实
});

test('① AI 全宕机时引擎档位诚实（G2：降级不得谎报在线）', async () => {
  const igde = deadEngine();
  const act = mkAct('outage2');
  const r = await igde.handle(act, '我想挽回加购未付的客户', { persist: async () => {} });
  assert.equal(r.engine, 'degraded', '宕机轮 engine=degraded');
  assert.ok((r.guardrailHits || []).includes('AI_OFFLINE'), 'AI_OFFLINE 留痕');
});

test('② slot_updates JSON 泄漏：吸收进 B1、reply 只留人话；裸类别词按 C4 丢弃', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({
      reply: '[{"slot":"goal","value":"挽回订单","confidence":1.0,"inferred":false}] 你希望拿到什么结果？挽回多少单、多少金额，还是先跑通流程？',
      slotUpdates: [], extras: [], corrections: []
    }),
    criticMode: 'off'
  });
  const act = mkAct('leak1');
  act.stage = 'S1';
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: 1 };
  act.needs.offer = { value: '10% off', source: 'explicit', at: 1 };
  const r = await igde.handle(act, '挽回订单', { persist: async () => {} });
  assert.equal(/\{"slot"/.test(r.reply), false, '回复不得泄漏内部 JSON');
  assert.ok(/你希望拿到什么结果/.test(r.reply), 'JSON 后的自然语言保留');
  assert.equal(act.needs.goal, null, 'goal 裸类别词不入槽（PRD C4/P2-N4：等商家补具体值）');
});

test('② 泄漏 JSON 带可验收值：吸收后照常入槽（grounding 放行）', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({
      reply: '[{"slot":"goal","value":"本月挽回 100 单","confidence":0.95,"inferred":false}] 记下了，目标是本月挽回 100 单。',
      slotUpdates: [], extras: [], corrections: []
    }),
    criticMode: 'off'
  });
  const act = mkAct('leak2');
  act.stage = 'S1';
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: 1 };
  act.needs.offer = { value: '10% off', source: 'explicit', at: 1 };
  await igde.handle(act, '营销目标是本月挽回 100 单', { persist: async () => {} });
  assert.ok(/100\s*单/.test(act.needs.goal.value), '泄漏的可验收目标入槽（值以用户原话口径为准）');
  assert.equal(act.stage, 'S2', '四槽齐 → S2');
});

test('② 内容块数组泄漏（qwen3.8-flash 形态）：剥离前缀 JSON 垃圾，人话保留', async () => {
  const leaked = JSON.stringify([{ type: 'text', text: '\n' }]) + ' 你希望拿到什么结果？挽回多少单、多少金额，还是先跑通流程？';
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: leaked, slotUpdates: [], extras: [], corrections: [] }),
    criticMode: 'off'
  });
  const act = mkAct('leak3');
  act.stage = 'S1';
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: 1 };
  act.needs.offer = { value: '10% off', source: 'explicit', at: 1 };
  const r = await igde.handle(act, '挽回订单', { persist: async () => {} });
  assert.equal(/type/.test(r.reply), false, '内容块 JSON 不得直达用户');
  assert.ok(/你希望拿到什么结果/.test(r.reply), '自然语言保留');
});

test('② 正常回复不受吸收影响（无 JSON 前缀时原样通过）', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({
      reply: '收到，加购未付的客户。他们为什么没付款，是忘记结账了还是在对比价格？',
      slotUpdates: [{ slot: 'audience', value: '加购未付客户', confidence: 0.95, inferred: false }],
      extras: [], corrections: []
    }),
    criticMode: 'off'
  });
  const act = mkAct('normal');
  const r = await igde.handle(act, '我想挽回加购未付的客户', { persist: async () => {} });
  assert.ok(/收到，加购未付的客户/.test(r.reply), '正常回复原样');
  assert.equal(act.needs.audience.value, '加购未付客户', '槽位照常入账');
});
