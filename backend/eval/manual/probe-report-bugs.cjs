'use strict';
/**
 * 真模型探针：重放 09-30《CartBack Agent 功能测试报告》的缺陷样本，核对当前代码是否仍复现。
 * 用法：node eval/manual/probe-report-bugs.cjs [--quick]
 *  --quick = 跳过前 4 轮铺槽（直接 applyNeeds 预填），只测 goal 三连 + 改参/冲突（省 token）
 */
const fs = require('fs');
const path = require('path');
const { LLMClient } = require('../../lib/llm');
const { IGDE } = require('../../lib/igde');
const needsMod = require('../../lib/needs');

const cfgServer = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../.server/config.json'), 'utf-8'));
const QUICK = process.argv.includes('--quick');

async function main() {
  const client = new LLMClient({
    baseUrl: cfgServer.aiBaseUrl, model: cfgServer.aiModel, apiKey: cfgServer.aiKey, timeoutMs: 45000,
  });
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async (messages, opts) => {
      const r = await client.chatStructured({ messages, maxTokens: 1200 });
      return { reply: r.reply, needs: r.needs, slotUpdates: r.slotUpdates || [], extras: r.extras || [], corrections: r.corrections || [], memoryPatch: r.memoryPatch, usage: r.usage };
    },
    callCritic: null,
  });

  const newAct = () => ({
    id: 'act_probe', stage: 'S0', needs: needsMod.emptyNeeds(), messages: [],
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: needsMod.emptyAskCount() },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: null,
  });

  const show = (tag, r, act) => {
    const slots = ['audience', 'reason', 'offer', 'goal'].map(s => `${s}=${act.needs[s] ? `${act.needs[s].value}|${act.needs[s].source}` : '∅'}`).join('  ');
    const extras = (act.memory.extras || []).map(e => `${e.key}:${String(e.value).slice(0, 12)}`).join(', ');
    console.log(`\n===== ${tag} =====`);
    console.log('reply:', String(r.reply || '').replace(/\n+/g, ' ⏎ ').slice(0, 220));
    console.log('slots:', slots);
    console.log('extras:', extras || '(none)');
    if (r.chips) console.log('chips:', JSON.stringify(r.chips).slice(0, 140));
  };

  const needVal = (act, s) => (act.needs[s] && act.needs[s].value) || '';

  const say = async (act, tag, text) => {
    const r = await igde.handle(act, text, { locale: 'en', persist: () => {} });
    show(tag, r, act);
    return r;
  };

  // —— 剧本 act：铺到 goal 空槽 ——
  const act = newAct();
  await say(act, '#1 品牌/品类/客单价', '品牌是 LunaGlow，卖手工香薰蜡烛，客单价 30 美元');
  await say(act, '#2 受众', '25-40 岁的美国女性，喜欢居家氛围');
  await say(act, '#5 挽回原因', '挽回原因就盯加购未付款的');
  await say(act, '#6 优惠', '折扣力度给 10% off');

  if (QUICK) {
    for (const s of [['audience', '25-40岁美国女性'], ['reason', '加购未付款'], ['offer', '10% off']]) {
      if (!needVal(act, s[0])) igde.applyNeeds(act, { [s[0]]: s[1] });
    }
  }

  // —— P0-1：goal 三连（报告 #9/#11 样本） ——
  if (!needVal(act, 'goal')) {
    await say(act, 'P0-1a 营销目标句式', '营销目标是本月挽回 100 单');
  } else {
    console.log('\n[skip P0-1a] goal 已在前几轮被填：', needVal(act, 'goal'));
  }
  if (!needVal(act, 'goal')) {
    await say(act, 'P0-1b 我希望拿到的结果句式', '我希望拿到的结果是：本月挽回 100 单');
  }
  if (!needVal(act, 'goal')) {
    await say(act, 'P0-1c 目标：句式', '目标：本月挽回 100 单');
  }
  console.log('\n>>> P0-1 终态 goal =', needVal(act, 'goal') || '(仍为空)', '/', (act.needs.goal && act.needs.goal.source) || '∅');

  // —— P1-1 改参复述 / P1-2 冲突追问（第二个 act） ——
  const act2 = newAct();
  await say(act2, 'act2 #1 铺底', '品牌是 LunaGlow，卖手工香薰蜡烛，客单价 30 美元');
  await say(act2, 'act2 #2 受众', '25-40 岁的美国女性');
  await say(act2, 'P1-1 改参', '客单价改成 35 美元');
  // 真·冲突样本（「年轻人」与 25-40 兼容，模型不出 update 属合理；45+ 才是硬冲突）
  await say(act2, 'P1-2 硬冲突', '客户主要是 45 岁以上的中年人');

  // —— P0-1 chip 路径：goal chips 点击 = 发送 chip 文本（前端现状），应写入 goal 槽 ——
  const act3 = newAct();
  await say(act3, 'act3 #1 铺底', '品牌是 LunaGlow，卖手工香薰蜡烛，客单价 30 美元');
  await say(act3, 'act3 #2 受众', '25-40 岁的美国女性');
  await say(act3, 'act3 #5 原因', '挽回原因就盯加购未付款的');
  await say(act3, 'act3 #6 优惠', '折扣力度给 10% off');
  await say(act3, 'P0-1d chip「跑通流程」', '跑通流程');
  if (!needVal(act3, 'goal')) await say(act3, 'P0-1e chip「挽回订单」', '挽回订单');
  console.log('\n>>> chip 路径终态 goal =', needVal(act3, 'goal') || '(仍为空)', '/', (act3.needs.goal && act3.needs.goal.source) || '∅');
}

main().catch(e => { console.error('PROBE FAILED:', e && e.stack || e); process.exit(1); });
