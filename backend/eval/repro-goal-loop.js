#!/usr/bin/env node
'use strict';
/**
 * eval/repro-goal-loop.js — 复现 2026-10-05 用户截图：goal 槽连问三遍循环。
 * 截图轨迹：问 goal → 用户「挽回订单」→ 换皮重问 → 用户「先试发一封」→ 再问「比如「…」——你的情况是？」
 * 用法：node eval/repro-goal-loop.js [alive|dead]   （dead = 模拟 AI 掉线，走 stub 路径）
 */
const cfgMod = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');

const cfg = cfgMod.load();
const mode = process.argv[2] || 'alive';
const client = new LLMClient({
  baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiKey, timeoutMs: 45000,
  contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
  extraBody: cfg.aiExtraBody || null
});

function makeEngine(dead) {
  return new IGDE({
    aiEnabled: !dead,
    callAI: dead
      ? async () => { throw new Error('simulated outage'); }
      : async (messages, opts) => {
        const r = await client.chatStructured({ messages, maxTokens: cfg.aiMaxOutputTokens });
        return { reply: r.reply, needs: r.needs, slotUpdates: r.slotUpdates || [], extras: r.extras || [], corrections: r.corrections || [], memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, usage: r.usage };
      },
    callCritic: async () => true,
    maxLlmCallsPerTurn: cfg.aiMaxCallsPerTurn || 3,
    criticMode: cfg.aiCriticMode || 'suspicious'
  });
}
function mkAct(id) {
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 'repro' };
}
async function turn(igde, act, input) {
  const r = await igde.handle(act, input, { persist: async () => {}, storeBanner: { connected: false } });
  return r;
}
const slotVal = (act, k) => (act.needs[k] ? act.needs[k].value : null);
const dump = (act) => `stage=${act.stage} slots=[${['audience', 'reason', 'offer', 'goal'].map(k => `${k}:${slotVal(act, k) ? slotVal(act, k).slice(0, 14) : '∅'}${act.needs[k] ? '/' + act.needs[k].source : ''}`).join(' ')}] ask=${JSON.stringify(act.memory.ask_count)} clarif=${JSON.stringify(act.memory.clarif_count || {})} loop_breaks=${act.memory.loop_breaks || 0} s1_turns=${act.memory.s1_turns || 0}`;

(async () => {
  for (const dead of (mode === 'dead' ? [true] : [false, true])) {
    console.log(`\n########## 模式: ${dead ? 'AI 掉线(stub)' : 'AI 在线(' + cfg.aiModel + ')'} ##########`);
    const igde = makeEngine(dead);
    const act = mkAct(`repro_${dead ? 'dead' : 'alive'}`);
    act.messages.push({ role: 'assistant', content: igde.opening({ hasAnyAct: false, storeBanner: { connected: false } }).reply, ts: Date.now() });
    // 先把前三槽填上，逼到「只差 goal」的截图状态
    const warmup = ['我卖手工香薰蜡烛的，想挽回加购没付款的客人', '他们是忘了结账', '给 10% off 吧'];
    for (const w of warmup) {
      const r = await turn(igde, act, w);
      console.log(`  预热[${w.slice(0, 12)}] → ${String(r.reply).slice(0, 60).replace(/\n/g, ' ')}`);
      console.log(`     ${dump(act)}`);
    }
    // 截图关键两步
    for (const input of ['挽回订单', '先试发一封']) {
      const r = await turn(igde, act, input);
      console.log(`\n  用户: ${input}`);
      console.log(`  引擎: ${String(r.reply).replace(/\n/g, ' ')}`);
      console.log(`     ${dump(act)}`);
    }
  }
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
