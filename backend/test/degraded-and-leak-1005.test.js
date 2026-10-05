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
const { countFilled } = require('../lib/needs');

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

const VIDEO_SEQ = [
  { in: '我想挽回加购未付的客户' },
  { in: '他们忘记结账了' },
  { in: '折扣给 10% off' },
  { in: '挽回订单', check: (act, reply) => !act.needs.goal && /多少单/.test(reply) },
  { in: '挽回 50 单', check: (act) => act.needs.goal && /50\s*单/.test(act.needs.goal.value) && act.stage === 'S2' },
  { in: '可以', check: (act, reply) => /确认/.test(reply) },
];

test('① AI 全宕机重放视频序列（10-05 阶梯版）：0 罐头、裸 chip 收窄追问、数值入槽、S2 收口不被 L4 误杀', async () => {
  const igde = deadEngine();
  const act = mkAct('outage');
  const replies = [];
  for (const step of VIDEO_SEQ) {
    const r = await igde.handle(act, step.in, { persist: async () => {} });
    assert.equal(CANNED_RE.test(r.reply), false, `「${step.in}」不得回罐头兜底，实际：${r.reply}`);
    if (step.check) assert.ok(step.check(act, r.reply), `「${step.in}」断言失败，回复：${r.reply}`);
    replies.push(r.reply);
  }
  // 裸 chip「挽回订单」首点 → 收窄追问数值（绝不再念「挽回多少单、多少金额…」菜单）
  assert.ok(!/挽回多少单、多少金额/.test(replies[3]), '裸 chip 收窄轮不得原样重问菜单');
  assert.equal(act.stage, 'S2', '数值目标入槽 → S2（确认动作走 /confirm）');
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
  const r = await igde.handle(act, '目标还没想好', { persist: async () => {} });
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
  const r = await igde.handle(act, '目标还没想好', { persist: async () => {} });
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

/* ---------- 循环压测（2026-10-05 强制兜底）：四类对抗场景最大连续近似 ≤2（S1） ---------- */

function similarEnough(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[\s\p{P}\p{S}]+|[的了吗呢吧啊嘛哦呀哈是]/gu, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y));
}

function maxConsecutiveRun(replies) {
  let max = 0, run = 1;
  for (let i = 1; i < replies.length; i++) {
    if (similarEnough(replies[i - 1], replies[i])) { run++; max = Math.max(max, run); } else run = 1;
  }
  return replies.length ? Math.max(max, 1) : 0;
}

async function runStress(engine, inputs) {
  const act = mkAct('stress');
  const outs = [];
  for (const input of inputs) {
    const r = await engine.handle(act, input, { persist: async () => {} });
    outs.push(String(r.reply || ''));
  }
  return { replies: outs, act };
}

const STRESS_SEQ = ['我想挽回加购未付的客户', '他们忘记结账了', '折扣给 10% off', '挽回订单', '挽回订单', '挽回订单', '挽回订单', '跑通流程', '可以', '可以', '嗯', '嗯'];

test('压测 A：全宕机 + 复读机用户 —— 0 罐头、最大连续近似 ≤2、追问话术轮换', async () => {
  const { replies, act } = await runStress(deadEngine(), STRESS_SEQ);
  assert.equal(maxConsecutiveRun(replies.slice(0, 8)) <= 2, true, 'S1 阶段最大连续近似 ≤2');
  assert.equal(replies.filter(t => CANNED_RE.test(t)).length, 0, '0 罐头（强制兜底 + 轮换）');
  assert.equal(act.needs.goal.value, '先跑通流程', 'goal 经合法 chip 入槽');
});

test('压测 D：空回复模型（json_mode 空白缺陷）——熔断器在第 3 次近似前强制换装', async () => {
  let calls = 0;
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => { calls++; return { reply: '   ', slotUpdates: [], extras: [], corrections: [] }; },
    criticMode: 'off'
  });
  // 10-05 起「挽回订单/跑通流程」裸 chip 走确定性阶梯（不到断路器）；压断路器改用
  // 业务词但不可提取的输入（目标定高点：BIZ 命中、无数值不落槽）
  const { replies } = await runStress(igde, ['我想挽回加购未付的客户', '他们忘记结账了', '折扣给 10% off', '目标定高点', '目标定高点', '目标定高点', '目标定高点', '挽回 50 单']);
  assert.equal(maxConsecutiveRun(replies.slice(0, 8)) <= 2, true, 'S1 最大连续近似 ≤2（含 L0 罐头路径）');
  assert.ok(replies.some(t => /对下账/.test(t)), '强制兜底话术（账本复述）出现');
});

test('压测 C：恒定回复模型（隔轮交替型循环）——窗口熔断在第 3 次近似前换装', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: '收到哦。那咱们继续——你想让这批客人回来做点什么呢？', slotUpdates: [], extras: [], corrections: [] }),
    criticMode: 'off'
  });
  const { replies } = await runStress(igde, ['我想挽回加购未付的客户', '他们忘记结账了', '折扣给 10% off', '目标定高点', '目标定高点', '挽回 50 单']);
  // S1 五轮内：交替型（模型文/罐头）不得出现 3 连近似；且熔断话术出现
  assert.equal(maxConsecutiveRun(replies.slice(0, 5)) <= 2, true, 'S1 交替型循环被熔断');
  assert.ok(replies.some(t => /对下账/.test(t)), '强制兜底话术出现');
});

test('压测 E：复读机用户（同一句连发）——S1 阶段最大连续近似 ≤2', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: '收到哦。那咱们继续——你想让这批客人回来做点什么呢？', slotUpdates: [], extras: [], corrections: [] }),
    criticMode: 'off'
  });
  const { replies } = await runStress(igde, ['我想挽回加购未付的客户', '我想挽回加购未付的客户', '我想挽回加购未付的客户', '他们忘记结账了', '他们忘记结账了', '折扣给 10% off']);
  assert.equal(maxConsecutiveRun(replies) <= 2, true, 'S1 最大连续近似 ≤2');
});

/* ---------- 防呆与强制弹确认卡（2026-10-05）：超轮数 / 不耐烦关键词 / 熔断计数 ---------- */

test('防呆①：不耐烦关键词（别问了直接生成）→ 缺槽推断补满、强制弹确认卡', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: 'x', slotUpdates: [], extras: [], corrections: [] }),
    criticMode: 'off'
  });
  const act = mkAct('fs1');
  await igde.handle(act, '我想挽回加购未付的客户', { persist: async () => {} });
  const r = await igde.handle(act, '别问了，直接生成', { persist: async () => {}, storeBanner: { connected: true, weekly_abandoned_count: 86 } });
  assert.equal(act.stage, 'S2', '强制进 S2');
  assert.equal(countFilled(act.needs), 4, '缺槽全部补满');
  assert.equal(act.needs.offer.value, '待定', 'offer 无数值不编造（C3）');
  assert.equal(r.planCard !== null, true, '在线档位弹预览卡（D1 确认卡）');
  assert.equal(act.needs.audience.source, 'explicit', '用户亲口说的受众保持 explicit');
  for (const slot of ['reason', 'offer', 'goal']) {
    assert.equal(act.needs[slot].source, 'inferred', `${slot} 推断补满可改`);
  }
});

test('防呆②：S1 超轮数（≥12）——离题输入也触发强制弹卡（防呆前置到离题拦截之前）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('fs2');
  act.stage = 'S1';
  act.memory.s1_turns = 11;
  await igde.handle(act, '嗯', { persist: async () => {} });
  assert.equal(act.memory.s1_turns, 12, 'S1 轮数计数');
  assert.equal(act.stage, 'S2', '超轮数 → 强制进 S2');
  assert.equal(countFilled(act.needs), 4, '缺槽全补');
});

test('防呆③：不耐烦句内带修正（受众改成老客，别问了）——先落修正账再补满', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('fs3');
  await igde.handle(act, '我想挽回加购未付的客户', { persist: async () => {} });
  await igde.handle(act, '受众改成老客，别问了直接生成', { persist: async () => {} });
  assert.ok(/老客|沉睡/.test(String(act.needs.audience.value)), '同句修正先落账（不被推断覆盖）');
  assert.equal(act.stage, 'S2', '强制进 S2');
});
