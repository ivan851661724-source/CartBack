'use strict';
/**
 * Token Plan 模型横评（真实 token，不入 CI）
 * 用法：node test/model-bakeoff.js [模型名过滤]
 * 每个模型跑同一套 5 轮 agent 场景（走生产同款 streamChatStructured 链路），
 * 按：JSON解析成功率 / 探针命中 / 时延 / 非流式兜底重试率 打分。
 */
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { LLMClient, buildCoachContext } = require('../lib/llm');

const cfg = config.load();

const MODELS = [
  'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash',
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2',
  'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'glm-5.2', 'glm-5.1', 'glm-5', 'MiniMax-M2.5',
];

/* 每模型 5 轮场景；probe.exp: 全部组需命中（组内任一） */
const TURNS = [
  { u: '我卖瑜伽裤的，客单价 258，加购未付的客户很多，他们嫌价格贵，希望他们回来付款，给85折优惠码',
    check: (r) => ({ json: !!r.jsonOk, needs: ['加购', '价', '付', '85'].every(k => Object.values(r.needs || {}).join('|').includes(k)) }), tag: '一次说全' },
  { u: '我店里客单价多少来着？', check: (r) => ({ json: !!r.jsonOk, needs: (r.reply || '').includes('258') }), tag: '记忆保持' },
  { u: '改一下，不是瑜伽裤，是瑜伽垫', check: (r) => ({ json: !!r.jsonOk, needs: (r.reply || '').includes('瑜伽垫') }), tag: '纠错' },
  { u: '我们从来不搞折扣，刚才是我口误，邮件里别提折扣', check: (r) => ({ json: !!r.jsonOk, needs: true }), tag: '否定约束' },
  { u: '那现在告诉我，你建议我怎么做挽回？', check: (r) => ({ json: !!r.jsonOk, needs: (r.reply || '').length >= 30 }), tag: '开放问答' },
];

async function testModel(model) {
  const client = new LLMClient({
    baseUrl: cfg.aiBaseUrl, model, apiKey: cfg.aiKey,
    contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
    extraBody: cfg.aiExtraBody || null,
    timeoutMs: 45000,
  });
  const act = { id: 'bakeoff-' + model, stage: 'S0', needs: {}, messages: [], memory: { facts: [], decisions: [], corrections: [] }, summary_cursor: 0, context_version: 1 };
  const out = { model, calls: 0, jsonOk: 0, retries: 0, totalMs: 0, probes: [], errors: [] };
  for (const t of TURNS) {
    const t0 = Date.now();
    try {
      const ctx = buildCoachContext({ act, userText: t.u, needs: act.needs, stage: act.stage, missing: ['audience', 'pain', 'goal', 'offer'].filter(f => !act.needs[f]) });
      const r = await client.streamChatStructured({ messages: ctx.messages, maxTokens: cfg.aiMaxOutputTokens, onReplyToken: () => {} });
      const ms = Date.now() - t0;
      out.calls++; out.totalMs += ms;
      if (r.jsonOk) out.jsonOk++;
      if ((r.requestCount || 1) > 1) out.retries++;
      const c = t.check(r);
      out.probes.push({ tag: t.tag, json: c.json, needs: c.needs, ms, reply: (r.reply || '').slice(0, 60) });
      act.messages.push({ role: 'user', content: t.u, ts: Date.now() });
      act.messages.push({ role: 'assistant', content: r.reply || '', ts: Date.now() });
      // needs 合并（简化版：模型值优先）
      for (const k of ['audience', 'pain', 'goal', 'offer']) if (r.needs && r.needs[k]) act.needs[k] = r.needs[k];
    } catch (e) {
      out.calls++; out.errors.push(`${t.tag}: ${e.code || ''} ${String(e.message).slice(0, 60)}`);
    }
  }
  return out;
}

(async () => {
  const only = (process.argv[2] || '').split(',').filter(Boolean);
  const ROUNDS = parseInt(process.argv[3] || '1', 10);
  const models = MODELS.filter(m => !only.length || only.some(o => m.toLowerCase().includes(o.toLowerCase())));
  console.log(`测试 ${models.length} 个模型 × ${TURNS.length} 轮 × ${ROUNDS} 轮次（真实 token，并发 5）...\n`);
  const acc = {};   // model -> 累计统计
  for (const m of models) acc[m] = { calls: 0, jsonOk: 0, retries: 0, probePass: 0, totalMs: 0, errors: [], leaks: 0 };
  for (let round = 1; round <= ROUNDS; round++) {
    const results = [];
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(5, models.length) }, async () => {
      while (idx < models.length) {
        const model = models[idx++];
        const client = new LLMClient({
          baseUrl: cfg.aiBaseUrl, model, apiKey: cfg.aiKey,
          contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
          extraBody: cfg.aiExtraBody || null,
          timeoutMs: 45000,
        });
        const act = { id: 'bakeoff-' + model, stage: 'S0', needs: {}, messages: [], memory: { facts: [], decisions: [], corrections: [] }, summary_cursor: 0, context_version: 1 };
        for (const t of TURNS) {
          const t0 = Date.now();
          try {
            const ctx = buildCoachContext({ act, userText: t.u, needs: act.needs, stage: act.stage, missing: ['audience', 'pain', 'goal', 'offer'].filter(f => !act.needs[f]) });
            const r = await client.streamChatStructured({ messages: ctx.messages, maxTokens: cfg.aiMaxOutputTokens, onReplyToken: () => {} });
            const ms = Date.now() - t0;
            const a = acc[model];
            a.calls++; a.totalMs += ms;
            if (r.jsonOk) a.jsonOk++;
            if ((r.requestCount || 1) > 1) a.retries++;
            const reply = r.reply || '';
            if (reply.trim().startsWith('[{')) a.leaks++;   // 信封数组退化输出
            const c = t.check(r);
            if (c.json && c.needs) a.probePass++;
            act.messages.push({ role: 'user', content: t.u, ts: Date.now() });
            act.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
            for (const k of ['audience', 'pain', 'goal', 'offer']) if (r.needs && r.needs[k]) act.needs[k] = r.needs[k];
          } catch (e) {
            acc[model].calls++; acc[model].errors.push(`${t.tag}: ${e.code || ''} ${String(e.message).slice(0, 50)}`);
          }
        }
        results.push(model);
        console.log(`  [round ${round}] ${model} 完成`);
      }
    }));
  }
  // 记分卡（聚合全部轮次）
  const score = models.map(m => {
    const a = acc[m];
    return {
      model: m,
      calls: a.calls,
      parseRate: +(a.jsonOk / Math.max(1, a.calls)).toFixed(3),
      probeRate: +(a.probePass / Math.max(1, a.calls)).toFixed(3),
      retryRate: +(a.retries / Math.max(1, a.calls)).toFixed(3),
      leakRate: +(a.leaks / Math.max(1, a.calls)).toFixed(3),
      avgMs: Math.round(a.totalMs / Math.max(1, a.calls)),
      errors: a.errors.length,
      score: +(a.probePass / Math.max(1, a.calls)) * 500 - (a.retries / Math.max(1, a.calls)) * 100 - (a.leaks / Math.max(1, a.calls)) * 100 - a.errors * 50 - Math.round(a.totalMs / Math.max(1, a.calls) / 100),
    };
  }).sort((a, b) => b.score - a.score);
  console.log('\n===== 模型记分卡（聚合 ' + ROUNDS + ' 轮） =====');
  console.log('模型'.padEnd(18) + '样本  解析率   探针率   兜底率   泄露率   均时延   得分');
  for (const s of score) {
    console.log(`${s.model.padEnd(18)} ${String(s.calls).padEnd(5)} ${s.parseRate.toFixed(2).padEnd(7)} ${s.probeRate.toFixed(2).padEnd(7)} ${s.retryRate.toFixed(2).padEnd(7)} ${s.leakRate.toFixed(2).padEnd(7)} ${String(s.avgMs + 'ms').padEnd(8)} ${s.score}`);
  }
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'model-bakeoff.json'), JSON.stringify({ rounds: ROUNDS, score, acc }, null, 2));
  console.log('详情已落盘 output/model-bakeoff.json');
})().catch(e => { console.error('BAKEOFF FAIL:', e.message); process.exit(1); });
