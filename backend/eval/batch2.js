#!/usr/bin/env node
'use strict';
/**
 * eval/batch2.js — 第二批真模型用例（2026-10-05）：记忆 / 响应 / 循环 三维度 × 多轮。
 * 与 model-compare.js 的第一批不重叠：本批聚焦——
 *   M 记忆：素材召回（品牌/客单价改参后）/ 改参落账 / S2 期 extras 补充 / 跨会话 prefs 预填
 *   R 响应：抗扰（闲聊/离题不写槽）、不耐烦关键词强制弹确认卡、逐轮延迟
 *   L 循环：含糊回答（嗯/随便/你看着办）长程 16 轮循环压测
 * 用法：node eval/batch2.js [rounds=3]
 */
const cfgMod = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');
const { countFilled } = require('../lib/needs');

const cfg = cfgMod.load();
const rounds = parseInt(process.argv[2] || '3', 10);
const client = new LLMClient({
  baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiKey, timeoutMs: 45000,
  contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
  extraBody: cfg.aiExtraBody || null
});
console.log(`模型: ${cfg.aiModel} @ ${cfg.aiBaseUrl}`);

const CANNED_RE = /卡了一下|断片|没接稳/;
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+|[的了吗呢吧啊嘛哦呀哈是]/gu, '');
const similar = (a, b) => { const x = norm(a), y = norm(b); if (!x || !y) return false; if (x === y) return true; return (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y)); };
const maxRun = (list) => { let m = 0, r = 1; for (let i = 1; i < list.length; i++) { if (similar(list[i - 1], list[i])) { r++; m = Math.max(m, r); } else r = 1; } return list.length ? Math.max(m, 1) : 0; };

function makeEngine() {
  return new IGDE({
    aiEnabled: true,
    callAI: async (messages, opts) => {
      const r = await client.chatStructured({ messages, maxTokens: cfg.aiMaxOutputTokens });
      return { reply: r.reply, needs: r.needs, slotUpdates: r.slotUpdates || [], extras: r.extras || [], corrections: r.corrections || [], memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, usage: r.usage };
    },
    callCritic: async () => true,
    maxLlmCallsPerTurn: cfg.aiMaxCallsPerTurn || 3,
    criticMode: cfg.aiCriticMode || 'suspicious'
  });
}
function mkAct(id) {
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 'b2' };
}
async function turn(igde, act, input, extraOpts = {}) {
  const t0 = Date.now();
  const r = await igde.handle(act, input, { persist: async () => {}, ...extraOpts });
  return { reply: String(r.reply || ''), engine: r.engine, planCard: r.planCard || null, stage: act.stage, dt: Date.now() - t0 };
}
const slotVal = (act, k) => (act.needs[k] ? act.needs[k].value : null);
const extrasVal = (act, k) => { const e = (act.memory.extras || []).find(x => x.key === k); return e ? e.value : null; };

/* ---------- M 记忆场景 ---------- */
const M_STEPS = [
  { in: '我的品牌叫 LunaGlow，做手工香薰蜡烛，客单价 28 美元', tag: '素材三连' },
  { in: '主要客户是加购未付的', tag: '受众' },
  { in: '客户反馈说运费太贵了', tag: '原因' },
  { in: '客单价改成 35 美元', tag: '改参·客单价' },
  { in: '我的品牌叫什么来着？', tag: '记忆·品牌召回', check: (r, act) => /LunaGlow/i.test(r.reply) },
  { in: '现在客单价是多少？', tag: '记忆·改参召回', check: (r, act) => /35/.test(r.reply) },
  { in: '折扣给 15% off 吧', tag: '钩子' },
  { in: '发送时段选晚上 8 点', tag: 'extras·时段' },
  { in: '营销目标是本月挽回 100 单', tag: '目标' },
  { in: '嗯对的', tag: 'S2 确认' },
  { in: '邮件里记得突出我们 48 小时长烧', tag: 'S2 期 extras 补充' },
];

/* ---------- R 响应/抗扰场景 ---------- */
const R_STEPS = [
  { in: '我卖手工手表的，想挽回下单没付的客人', tag: '开场' },
  { in: '他们大概是到付款那步犹豫了', tag: '原因' },
  { in: '今天天气怎么样？', tag: '离题·不写槽', check: (r, act, prevFilled) => true },
  { in: '哈哈你会不会太高大上了', tag: '闲聊' },
  { in: '折扣给 10% off', tag: '钩子' },
  { in: '就这样吧，别问了', tag: '防呆·不耐烦→弹卡', check: (r, act) => r.planCard !== null && act.stage === 'S2' },
];

/* ---------- L 循环长程场景（含糊回答压测） ---------- */
const L_STEPS = [
  { in: '我想挽回一些客人', tag: '开场' },
  { in: '嗯', tag: '含糊' }, { in: '随便', tag: '含糊' }, { in: '都行', tag: '含糊' },
  { in: '加购没付的那批吧', tag: '受众' },
  { in: '你看着办', tag: '含糊' },
  { in: '忘了付款吧', tag: '原因' },
  { in: '都行，你定', tag: '含糊' },
  { in: '10% off', tag: '钩子' },
  { in: '嗯嗯', tag: '含糊' },
  { in: '随便多少单，先跑起来', tag: '目标' },
  { in: '可以', tag: 'S2 确认' },
  { in: '嗯', tag: 'S2 含糊' }, { in: '就这样吧', tag: 'S2 确认' },
];

async function runScenario(name, steps, round, preset) {
  const igde = makeEngine();
  const act = mkAct(`b2_${name}_${round}`);
  act.messages.push({ role: 'assistant', content: igde.opening({ hasAnyAct: preset ? true : false, storeBanner: { connected: false } }).reply, ts: Date.now() });
  if (preset) { act.memory.prefs = preset.prefs; act.memory.prefs.reuse = 'pending'; }
  const outs = []; const lats = [];
  const fails = [];
  let prevFilled = 0;
  for (const step of steps) {
    const r = await turn(igde, act, step.in, preset ? { reusePrefs: preset.prefs } : {});
    lats.push(r.dt);
    outs.push(r.reply);
    if (step.check && !step.check(r, act, prevFilled)) fails.push(`${step.tag}:断言失败`);
    if (CANNED_RE.test(r.reply)) fails.push(`${step.tag}:罐头`);
    if (r.dt > 20000) fails.push(`${step.tag}:延迟${r.dt}ms`);
    prevFilled = countFilled(act.needs);
  }
  const run = maxRun(outs);
  const checks = {
    latencyAvg: Math.round(lats.reduce((a, b) => a + b, 0) / lats.length),
    latencyMax: Math.max(...lats),
    canned: outs.filter(t => CANNED_RE.test(t)).length,
    loopMaxRun: run,
    fails
  };
  console.log(`\n--- ${name} · 第 ${round} 轮 | 延迟均值 ${checks.latencyAvg}ms / 峰值 ${checks.latencyMax}ms | 罐头 ${checks.canned} | 最大连跑 ${run} ---`);
  outs.forEach((t, i) => console.log(`  T${i + 1}[${steps[i].tag}]: ${t.slice(0, 52).replace(/\n/g, ' ')}`));
  if (fails.length) console.log(`  ❌ ${fails.join(' | ')}`); else console.log('  ✅ 全部断言通过');
  return { checks, act, outs };
}

(async () => {
  const agg = { M: [], R: [], L: [] };
  const memSummary = [];
  for (let rd = 1; rd <= rounds; rd++) {
    const m = await runScenario('M记忆', M_STEPS, rd);
    // 记忆硬断言（M 结束后）
    const a = m.act;
    const memChecks = {
      brand: /LunaGlow/i.test(m.outs[4]),
      aovCorrected: String(extrasVal(a, 'aov') || '').includes('35'),
      timing: Boolean(extrasVal(a, 'timing')),
      goalFilled: Boolean(slotVal(a, 'goal')),
      stageS2: a.stage === 'S2'
    };
    memSummary.push(memChecks);
    console.log(`  记忆断言: ${JSON.stringify(memChecks)}`);
    if (Object.values(memChecks).some(v => !v)) m.checks.fails.push('记忆断言失败');
    agg.M.push(m.checks);

    // 跨会话记忆（A3）：模拟 confirm 后 prefs 沉淀 → 新 act「照上次的来」→ 预填 inferred
    const prefs = { audience: slotVal(a, 'audience') || '', reason: slotVal(a, 'reason') || '', offer_text: slotVal(a, 'offer') || '', goal: slotVal(a, 'goal') || '' };
    const igde2 = makeEngine();
    const act2 = mkAct(`b2_reuse_${rd}`);
    act2.messages.push({ role: 'assistant', content: igde2.opening({ hasAnyAct: true, storeBanner: { connected: false } }).reply, ts: Date.now() });
    const reuseTurn = await turn(igde2, act2, '照上次的来', { reusePrefs: prefs });
    const reuseFilled = countFilled(act2.needs);
    const reuseOk = reuseFilled >= 3 && reuseTurn.reply.length > 0;
    const reuseHead = String(reuseTurn.reply).split('\n').join(' ').slice(0, 50);
    console.log('  跨会话「照上次的来」: 预填 ' + reuseFilled + '/4 | ' + (reuseOk ? 'OK' : 'FAIL') + ' | ' + reuseHead);
    if (!reuseOk) m.checks.fails.push('跨会话预填失败');

    const r2 = await runScenario('R响应', R_STEPS, rd);
    agg.R.push(r2.checks);
    const l = await runScenario('L循环', L_STEPS, rd);
    agg.L.push(l.checks);
  }

  console.log('\n===== 第二批汇总（' + rounds + ' 轮均值） =====');
  console.log('场景   延迟均值↓  延迟峰值   罐头↓  连跑↓  断言失败↓');
  for (const [k, list] of Object.entries(agg)) {
    const avg = (f) => Math.round(list.reduce((a, c) => a + (c[f] || 0), 0) / list.length);
    const failN = list.reduce((a, c) => a + c.fails.length, 0);
    console.log(`${k.padEnd(6)} ${avg('latencyAvg')}ms      ${Math.max(...list.map(c => c.latencyMax))}ms    ${avg('canned')}      ${avg('loopMaxRun')}      ${failN}`);
  }
  const memOk = memSummary.filter(m => Object.values(m).every(Boolean)).length;
  console.log(`记忆断言全过: ${memOk}/${memSummary.length}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
