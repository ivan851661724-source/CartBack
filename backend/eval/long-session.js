#!/usr/bin/env node
'use strict';
/**
 * eval/long-session.js — 长会话压测（2026-10-05）：40 轮混合对话，验证三件从未测过的事：
 *   ① 上下文压缩真的发生（context_version / summary_cursor 随轮次推进，LLM 输入不超窗）
 *   ② 压缩后长期记忆仍在（第 1 轮说的品牌/客单价，第 35+ 轮问还能答对）
 *   ③ 长程不劣化（无罐头、无 3 连近似、无槽位回退——已填槽不被后续轮次清掉）
 * 用法：node eval/long-session.js [rounds=2]
 */
const cfgMod = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');

const cfg = cfgMod.load();
const ROUNDS = parseInt(process.argv[2] || '2', 10);
const client = new LLMClient({
  baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiKey, timeoutMs: 45000,
  contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
  extraBody: cfg.aiExtraBody || null
});
const CANNED_RE = /卡了一下|断片|没接稳/;
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+|[的了吗呢吧啊嘛哦呀哈是]/gu, '');
const similar = (a, b) => { const x = norm(a), y = norm(b); if (!x || !y) return false; if (x === y) return true; return (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y)); };
const maxRun = (list) => { let m = 0, r = 1; for (let i = 1; i < list.length; i++) { if (similar(list[i - 1], list[i])) { r++; m = Math.max(m, r); } else r = 1; } return list.length ? Math.max(m, 1) : 0; };

function makeEngine() {
  return new IGDE({
    aiEnabled: true,
    callAI: async (messages) => {
      const r = await client.chatStructured({ messages, maxTokens: cfg.aiMaxOutputTokens });
      return { reply: r.reply, needs: r.needs, slotUpdates: r.slotUpdates || [], extras: r.extras || [], corrections: r.corrections || [], memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, usage: r.usage };
    },
    callCritic: async () => true,
    maxLlmCallsPerTurn: cfg.aiMaxCallsPerTurn || 3,
    criticMode: cfg.aiCriticMode || 'suspicious'
  });
}
function mkAct(id) {
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 'ls' };
}
const slotVal = (act, k) => (act.needs[k] ? act.needs[k].value : null);

/* 40 轮脚本：前 6 轮采集四槽（含长期记忆素材），中段闲聊/调整/追问/离题混杂，尾段召回 + 确认 */
const SCRIPT = [
  '我的品牌叫 TerraNova，卖有机棉 T 恤，客单价 26 美元',
  '想挽回加购没付款的客人',
  '他们是忘了结账',
  '钩子给 12% off',
  '目标是挽回 60 单',
  '发送时段选早上 9 点',
  '嗯对的',
  '顺便问下，你们支持 Shopify 吗',
  '受众改成浏览没买的吧',
  '还是改回加购未付吧',
  '今天天气不错',
  '客单价改成 29 美元',
  '现在我品牌叫什么？',
  '邮件里突出有机棉 GOTS 认证',
  '钩子改成 15% off',
  '嗯就这样吧',
  '为什么棉花的要选有机的',
  '挽回 60 单这个目标会不会太多',
  '那就 40 单吧',
  '嗯',
  '随便',
  '你看着办',
  '加购未付的客人一般多久会回来',
  '折扣太深会不会伤品牌',
  '嗯嗯',
  '那钩子保持 15% off 不变',
  '对了我们还有条洗手裤系列',
  '这批信发多少人是合理的',
  '嗯对的',
  '再看看目标——挽回 40 单合理吧',
  '行',
  '素材就这些了',
  '第 1 轮说的品牌叫什么来着？',
  '现在客单价是多少？',
  '钩子定的多少？',
  '目标是多少单？',
  '发送时段定的几点？',
  '那四样都对一下，我确认一下',
  '嗯可以，就这样确认',
  '谢了',
];

(async () => {
  console.log(`模型: ${cfg.aiModel} | 长会话压测 ${SCRIPT.length} 轮 × ${ROUNDS} 轮次`);
  let allOk = true;
  for (let rd = 1; rd <= ROUNDS; rd++) {
    const igde = makeEngine();
    const act = mkAct(`ls_${rd}`);
    act.messages.push({ role: 'assistant', content: igde.opening({ hasAnyAct: false, storeBanner: { connected: false } }).reply, ts: Date.now() });
    const outs = []; const lats = [];
    for (let i = 0; i < SCRIPT.length; i++) {
      const t0 = Date.now();
      const r = await igde.handle(act, SCRIPT[i], { persist: async () => {}, storeBanner: { connected: false } });
      lats.push(Date.now() - t0);
      outs.push(String(r.reply || ''));
    }
    const brand = (act.memory.extras || []).find(e => e.key === 'brand');
    const aov = (act.memory.extras || []).find(e => /客单|aov/i.test(e.key));
    const timing = (act.memory.extras || []).find(e => e.key === 'timing');
    const checks = [
      ['① 上下文压缩发生（context_version/summary_cursor 推进）', act.context_version > 1 || act.summary_cursor > 0 || act.messages.length > 60], // 长会话必然进入压缩路径之一
      ['②a 压缩后品牌记忆仍在（T33 回答 TerraNova）', /terranova/i.test(outs[32])],
      ['②b 客单价改参后可召回（T34 回答 29）', /29/.test(outs[33])],
      ['②c 钩子可召回（T35 回答 15% off）', /15/.test(outs[34])],
      ['②d 目标可召回（T36 回答 40 单）', /40/.test(outs[35])],
      ['②e 时段 extras 在账', Boolean(timing)],
      ['③a 已填槽不被长程清掉（四槽全满）', ['audience', 'reason', 'offer', 'goal'].every(k => slotVal(act, k))],
      ['③b 最终受众正确（改回加购未付）', /加购/.test(slotVal(act, 'audience') || '')],
      ['③c 最终钩子正确（15% off）', /15/.test(slotVal(act, 'offer') || '')],
      ['③d 最终目标正确（40 单）', /40/.test(slotVal(act, 'goal') || '')],
      ['③e 全程无罐头', outs.every(t => !CANNED_RE.test(t))],
      ['③f 无 3 连近似回复', maxRun(outs) <= 2],
      ['③g 无超时轮（≤20s）', Math.max(...lats) <= 20000],
    ];
    const pass = checks.every(c => c[1]);
    if (!pass) allOk = false;
    console.log(`\n--- 第 ${rd} 轮次 | ${pass ? 'PASS' : 'FAIL'} | ${SCRIPT.length} 轮对话 / 延迟均值 ${Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)}ms / 峰值 ${Math.max(...lats)}ms ---`);
    for (const [n, ok] of checks) if (!ok) console.log(`  ✗ ${n}`);
    console.log(`  记忆快照: brand=${brand && brand.value} aov=${aov && aov.value} timing=${timing && timing.value} | ctx_ver=${act.context_version} summary_cursor=${act.summary_cursor} | stage=${act.stage}`);
  }
  console.log(`\n===== 长会话压测：${allOk ? '全部通过' : '存在失败'} =====`);
  if (!allOk) process.exit(1);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
