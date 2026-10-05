#!/usr/bin/env node
'use strict';
/**
 * eval/model-compare.js — 真模型对话质量对比 harness（多模型 × 多轮 × 同一套件）
 *
 * 背景（2026-10-05 用户视频 bug）：goal 槽 chips 点击与 S2 确认轮反复回罐头
 * 「我这边可能卡了一下，不过你刚说的我接住了」+ 重复问 goal —— 罐头循环。
 * 本工具逐轮记录 guardrailHits / engine / needs / 延迟，定位兜底触发链；
 * 再对同一套件按模型对比打分，选出表现最好的模型。
 *
 * 用法：
 *   node eval/model-compare.js --models qwen3.7-plus,qwen-max --rounds 2
 *   node eval/model-compare.js --probe            # 只探测网关可用模型
 */

const cfgMod = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');
const { countFilled } = require('../lib/needs');

const cfg = cfgMod.load();
const BASE_URL = cfg.aiBaseUrl || 'https://api.deepseek.com';
const API_KEY = cfg.aiKey;

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const hasFlag = (name) => args.includes('--' + name);

if (!API_KEY) { console.error('未配置 aiKey（.server/config.json）'); process.exit(1); }

/* ---------- 模型探测 ---------- */
function makeClient(model) {
  return new LLMClient({
    baseUrl: BASE_URL,
    model,
    apiKey: API_KEY,
    timeoutMs: 45000,
    contextWindowTokens: cfg.aiContextWindowTokens,
    contextSafetyMargin: cfg.aiContextSafetyMargin,
    extraBody: cfg.aiExtraBody || null   // 阿里 Token Plan 网关：qwen 系需 enable_thinking:false
  });
}

async function probeModel(model) {
  const client = makeClient(model);
  try {
    const r = await client.chatStructured({
      messages: [{ role: 'user', content: '只回 JSON {"reply":"..."}：reply 为客服口语回商家「你好」的一句话，不超过 10 个字。' }],
      maxTokens: cfg.aiMaxOutputTokens || 1024,
    });
    return { ok: Boolean(r.reply || (r.raw && r.raw.choices)), sample: (r.reply || '').slice(0, 20), err: null };
  } catch (e) {
    return { ok: false, sample: '', err: String(e.message || e).slice(0, 120) };
  }
}

/* ---------- 引擎接线（与 server.js 同构） ---------- */
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function makeEngine(model) {
  const client = makeClient(model);
  const callAI = async (messages, opts) => {
    const r = await client.chatStructured({ messages, maxTokens: cfg.aiMaxOutputTokens });
    return {
      reply: r.reply,
      needs: r.needs,
      slotUpdates: r.slotUpdates || [],
      extras: r.extras || [],
      corrections: r.corrections || [],
      memoryPatch: r.memoryPatch,
      profilePatch: r.profilePatch,
      usage: r.usage,
      requestCount: r.requestCount,
      jsonOk: r.jsonOk
    };
  };
  const callCritic = async (text) => {
    try {
      const r = await client.chatStructured({
        messages: [
          { role: 'system', content: '你是严格的内容审查员。判断文本是否「说教 / 推销 / 列清单 / 替用户下结论」。只回 JSON {"bad":true} 或 {"bad":false}，不要其它内容。' },
          { role: 'user', content: text }
        ]
      });
      const content = r.raw && r.raw.choices && r.raw.choices[0] && r.raw.choices[0].message.content;
      const parsed = safeJson(content);
      if (parsed && typeof parsed.bad === 'boolean') return !parsed.bad;
      return true; // 解析失败 → fail-closed（与 server 一致：视为违规走本地兜底再判）
    } catch (e) {
      return false; // fail-closed
    }
  };
  return new IGDE({
    aiEnabled: true,
    callAI,
    callCritic,
    maxLlmCallsPerTurn: cfg.aiMaxCallsPerTurn || 3,
    criticMode: cfg.aiCriticMode || 'suspicious'
  });
}

function makeAct(id) {
  return {
    id, stage: 'S0', needs: {}, messages: [],
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 'compare'
  };
}

/* ---------- 视频复现场景 + PRD 关键检查 ---------- */
const CANNED_RE = /我这边可能卡了一下|刚才有点断片|我这边没接稳|咱接着聊邮件挽回——你最想先捞哪拨客人/;
const SCENARIO = [
  { tag: '采集·首句', input: '我想挽回加购未付的客户，我的品牌叫 LunaGlow，做手工香薰蜡烛，客单价 28 美元', expect: (s) => s.audience, expectNote: 'audience 入槽' },
  { tag: '采集·reason', input: '他们忘记结账了', expect: (s) => s.reason, expectNote: 'reason 入槽' },
  { tag: '采集·offer', input: '折扣力度给 10% off 就行', expect: (s) => s.offer, expectNote: 'offer=10% off' },
  { tag: '视频·goal裸chip', input: '挽回订单', expect: () => true, expectNote: '不罐头循环（允许追问具体值）' },
  { tag: '视频·goal裸chip重复', input: '挽回订单', expect: () => true, expectNote: '不罐头循环' },
  { tag: '视频·goal合法chip', input: '跑通流程', expect: (s) => s.goal, expectNote: 'goal=先跑通流程（C4 合法非数值目标）' },
  { tag: '视频·S2确认', input: '可以', expect: () => true, expectNote: '确认引导/不罐头' },
  { tag: 'PRD#15·双改参', input: '受众改成老客，折扣换 15%', expect: (s) => /老客|沉睡/.test(String(s.audience)) && /15/.test(String(s.offer)), expectNote: '双 correction 同轮生效' },
  { tag: 'PRD#4·冲突', input: '其实主要是年轻人', expect: () => true, expectNote: 'S2 澄清轮（不静默覆盖）' },
  { tag: '澄清应答', input: '25-34', expect: () => true, expectNote: '应答后停留 S2' },
];

async function runSuite(model, round) {
  const igde = makeEngine(model);
  const act = makeAct(`cmp_${model}_${round}`);
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: Date.now() });
  const turns = [];
  for (const step of SCENARIO) {
    const t0 = Date.now();
    let r;
    try {
      r = await igde.handle(act, step.input, { persist: async () => {} });
    } catch (e) {
      turns.push({ tag: step.tag, error: String(e.message || e).slice(0, 100) });
      continue;
    }
    const dt = Date.now() - t0;
    const needs = {};
    for (const k of ['audience', 'reason', 'offer', 'goal']) needs[k] = act.needs[k] ? act.needs[k].value : null;
    const replyRaw = String(r.reply || '');
    turns.push({
      tag: step.tag,
      reply: replyRaw.replace(/\s+/g, ' ').slice(0, 80),
      engine: r.engine,
      hits: (r.guardrailHits || []).join(',') || '-',
      canned: CANNED_RE.test(replyRaw),
      jsonLeak: /\{\s*"slot"\s*:|\[\s*\{\s*"slot"/.test(replyRaw),
      overclaim: /四样|都齐|需求已收集/.test(replyRaw) && countFilled(act.needs) < 4,
      needs,
      filled: countFilled(act.needs),
      stage: act.stage,
      chips: (r.chips || []).length,
      dt
    });
  }
  return turns;
}

function scoreTurns(turns) {
  const assistantReplies = turns.filter(t => t.reply).map(t => t.reply);
  const canned = turns.filter(t => t.canned).length;
  // 罐头循环：连续 3 条助手回复两两高度相似（同问句复读）
  let loop = 0;
  for (let i = 2; i < assistantReplies.length; i++) {
    const a = assistantReplies[i - 2], b = assistantReplies[i - 1], c = assistantReplies[i];
    if (a === b && b === c) loop++;
  }
  const goalTurn = turns.findIndex(t => t.needs && t.needs.goal);
  const t8 = turns[7] || {};
  const t8ok = typeof t8.needs === 'object' && t8.needs && /老客|沉睡/.test(String(t8.needs.audience)) && /15/.test(String(t8.needs.offer));
  const lat = turns.map(t => t.dt).filter(Boolean);
  return {
    turns: turns.length,
    canned,
    jsonLeak: turns.filter(t => t.jsonLeak).length,
    overclaim: turns.filter(t => t.overclaim).length,
    loop,
    goalFilledAt: goalTurn >= 0 ? goalTurn + 1 : null, // 第几轮 goal 入槽（1-based，期望 ≤6）
    finalFilled: turns.length ? turns[turns.length - 1].filled : 0,
    correctionOK: Boolean(t8ok),
    avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    maxLatencyMs: lat.length ? Math.max(...lat) : null,
    degradedTurns: turns.filter(t => t.engine === 'degraded').length,
    errorTurns: turns.filter(t => t.error).length
  };
}

/* ---------- 主流程 ---------- */
(async () => {
  const probeOnly = hasFlag('probe');
  const models = (flag('models', 'qwen3.7-plus') || '').split(',').map(s => s.trim()).filter(Boolean);
  const rounds = parseInt(flag('rounds', '2'), 10);

  console.log(`网关: ${BASE_URL}`);
  const availability = {};
  for (const m of models) {
    process.stdout.write(`探测 ${m} ... `);
    const p = await probeModel(m);
    availability[m] = p.ok;
    console.log(p.ok ? '可用' : `不可用（${p.err}）`);
  }
  const usable = models.filter(m => availability[m]);
  if (probeOnly || !usable.length) return;

  const report = {};
  for (const m of usable) {
    report[m] = [];
    for (let rd = 1; rd <= rounds; rd++) {
      console.log(`\n===== ${m} · 第 ${rd} 轮 =====`);
      const turns = await runSuite(m, rd);
      for (const t of turns) {
        console.log(`[${t.tag}] ${t.error ? 'ERROR ' + t.error : `eng=${t.engine} hits=${t.hits} canned=${t.canned} filled=${t.filled} stage=${t.stage} ${t.dt}ms`}`);
        console.log(`  reply: ${t.reply || '(空)'}`);
        if (t.needs) console.log(`  needs: ${JSON.stringify(t.needs)}`);
      }
      const s = scoreTurns(turns);
      report[m].push(s);
      console.log(`  >> 小结: ${JSON.stringify(s)}`);
    }
  }

  console.log('\n===== 模型对比（各轮汇总均值） =====');
  console.log('model            canned↓  leak↓  overclaim↓  loop↓  goal@≤6  corr  avg-ms↓  degraded↓');
  for (const [m, rs] of Object.entries(report)) {
    const avg = (k) => Math.round(rs.reduce((a, r) => a + (r[k] || 0), 0) / rs.length);
    const goalOk = rs.filter(r => r.goalFilledAt && r.goalFilledAt <= 6).length;
    const corr = rs.filter(r => r.correctionOK).length;
    console.log(`${m.padEnd(16)} ${avg('canned')}        ${avg('jsonLeak')}          ${avg('overclaim')}            ${avg('loop')}      ${goalOk}/${rs.length}   ${corr}/${rs.length}  ${avg('avgLatencyMs')}     ${avg('degradedTurns')}`);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
