'use strict';
/**
 * 诊断脚本（不入 CI）：多轮对话记忆质量 + 回复丰满度观察。
 * 事实散布在多轮中（商品→市场→长期规矩→受众→痛点→目标钩子），最后测 recall。
 */
const config = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');

const cfg = config.load();
const client = new LLMClient({
  baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiKey,
  contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
  extraBody: cfg.aiExtraBody || null
});

const stats = { calls: 0, jsonOk: 0, memAccepted: 0, memRejected: 0, profAccepted: 0, profRejected: 0 };

async function callAI(messages, opts) {
  stats.calls++;
  const r = await client.streamChatStructured({ messages, maxTokens: cfg.aiMaxOutputTokens, onReplyToken: opts && opts.onReplyToken });
  if (r.jsonOk) stats.jsonOk++;
  return { reply: r.reply, needs: r.needs, memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, usage: r.usage, requestCount: r.requestCount };
}

const engine = new IGDE({ aiEnabled: true, callAI, criticMode: 'off' });

(async () => {
  let act = { id: 'M', stage: 'S0', needs: {}, messages: [], memory: { facts: [], decisions: [], corrections: [] }, summary_cursor: 0, context_version: 1 };
  let profile = {};
  const turns = [
    '我开了个独立站，主要卖跑鞋',
    '客人基本都是欧美的，美国最多',
    '对了我们店有个规矩：打折从来不低于九折，以后发邮件都用这个力度就行',
    '最近好多客户加了购物车没付款',
    '运费有点贵，他们看到就犹豫',
    '想让他们回来付款，给九折码吧',
    '你还记得我店里卖啥吗？主要客人在哪？'
  ];
  for (let i = 0; i < turns.length; i++) {
    const r = await engine.handle(act, turns[i], { agentProfile: profile });
    if (r.agentMeta && r.agentMeta.agentProfile) profile = r.agentMeta.agentProfile;
    if (r.agentMeta) {
      stats.memAccepted += r.agentMeta.memoryAccepted || 0;
      stats.memRejected += r.agentMeta.memoryRejected || 0;
      stats.profAccepted += r.agentMeta.profileAccepted || 0;
      stats.profRejected += r.agentMeta.profileRejected || 0;
    }
    console.log(`\n[T${i + 1}] 用户: ${turns[i]}`);
    console.log(`  AI(${(r.reply || '').length}字): ${r.reply}`);
    console.log(`  needs=${JSON.stringify(r.needs)}`);
    console.log(`  memory=${JSON.stringify(act.memory)}`);
    if (Object.keys(profile).length) console.log(`  profile=${JSON.stringify(profile)}`);
  }
  console.log(`\n===== 汇总 =====`);
  console.log(`jsonOk: ${stats.jsonOk}/${stats.calls}`);
  console.log(`memory patch: accepted=${stats.memAccepted} rejected=${stats.memRejected}`);
  console.log(`profile patch: accepted=${stats.profAccepted} rejected=${stats.profRejected}`);
})().catch(e => { console.error('DIAG FAIL:', e.code || '', e.message); process.exit(1); });
