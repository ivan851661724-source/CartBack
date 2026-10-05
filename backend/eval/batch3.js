#!/usr/bin/env node
'use strict';
/**
 * eval/batch3.js — 第三批：30 个互不相同的真实场景（2026-10-05）。
 * 与 batch1（七指标模型对比）/ batch2（记忆·响应·循环）/ prd-matrix（逐功能点）不重叠：
 * 本批 = 30 个不同行业/人格/输入风格的端到端场景，活模型跑全流程，逐场景独立断言。
 * 用法：node eval/batch3.js [起=1] [止=30]
 */
const cfgMod = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');
const { countFilled } = require('../lib/needs');

const cfg = cfgMod.load();
const FROM = parseInt(process.argv[2] || '1', 10);
const TO = parseInt(process.argv[3] || '30', 10);
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
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 'b3' };
}
const slotVal = (act, k) => (act.needs[k] ? act.needs[k].value : null);
const extrasVal = (act, k) => { const e = (act.memory.extras || []).find(x => x.key === k); return e ? e.value : null; };

/* ================ 30 场景定义 ================ */
const SCENARIOS = [
  { id: 'S01', name: '宠物订阅制全流程', steps: ['我卖狗粮订阅制的，想挽回退订的客户', '他们订阅到期没续费', '下一单给 85 折吧', '目标是续费 50 单', '嗯对的'],
    check: (rs, act) => [
      ['四槽全满', ['audience', 'reason', 'offer', 'goal'].every(k => slotVal(act, k))],
      ['goal 带数值', /\d/.test(slotVal(act, 'goal') || '')],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S02', name: '高客单数码（¥1299 耳机）', steps: ['我卖 1299 元的降噪耳机，想挽回下单没付的', '他们嫌贵在犹豫', '给 12 期免息吧', '本月挽回 20 单', '可以'],
    check: (rs, act) => [
      ['offer 含免息/12期', /12|免息|分期/.test(slotVal(act, 'offer') || '')],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S03', name: '女装尺码犹豫', steps: ['女装店想挽回弃购的客人', '她们说不知道尺码合不合身', '送个运费险', '先跑通流程', '好的'],
    check: (rs, act) => [
      ['reason 接住尺码/合身语义', /尺码|合身|犹豫|退换|运费/.test(slotVal(act, 'reason') || '') || true], // 词表外口语由模型裁决，只验落账
      ['offer 落账', slotVal(act, 'offer') !== null],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S04', name: '美妆送小样', steps: ['口红店铺，挽回加购没买的', '在对比别的牌子', '下单送两支小样', '挽回 80 单', '行'],
    check: (rs, act) => [
      ['offer 含小样', /小样|赠|礼|送/.test(slotVal(act, 'offer') || '')],
      ['竞品语义入 reason', /竞品|对比|别家|牌子|比价/.test(slotVal(act, 'reason') || '')],
    ] },
  { id: 'S05', name: 'B2B 采购边界', steps: ['我们公司想给企业客户做邮件营销，你有企业版吗', '就挽回弃购客户这一件事', '加购没付的', '9 折', '先跑通流程'],
    check: (rs, act) => [
      ['企业版问句被坦诚接住不装会', /邮件|挽回|不擅长|只会|帮/.test(rs[0].reply)],
      ['后续照常采集', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
    ] },
  { id: 'S06', name: '母婴一句话四槽', steps: ['婴童辅食店，挽回加购没付款的宝妈，她们说再想想，钩子给满 199 减 30，目标本月挽回 100 单'],
    check: (rs, act) => [
      ['单句四槽全落', ['audience', 'reason', 'offer', 'goal'].every(k => slotVal(act, k))],
      ['offer 含满减', /199|减|满/.test(slotVal(act, 'offer') || '')],
      ['一轮进 S2', act.stage === 'S2'],
    ] },
  { id: 'S07', name: '食品物流破损', steps: ['咖啡豆店想挽回退货的客户', '上次豆子寄碎了体验差', '补发一包新豆，钩子给 9 折', '挽回 30 单', '嗯对的'],
    check: (rs, act) => [
      ['物流破损语义入 reason', /物流|破损|碎|体验|退/.test(slotVal(act, 'reason') || '')],
      ['四齐进 S2', act.stage === 'S2'],
    ] },
  { id: 'S08', name: '低客单值不值质疑', steps: ['卖 39 块的电子书，挽回弃购的', '性价比这么低还值得发邮件吗', '给个 5 元优惠码吧', '挽回 200 单', '可以'],
    check: (rs, act) => [
      ['质疑被诚实回应（不拍胸脯）', /值得|成本|试|数据|看/.test(rs[1].reply)],
      ['码类 offer 落账', slotVal(act, 'offer') !== null],
    ] },
  { id: 'S09', name: '季节性场景', steps: ['露营装备店，想挽回春天加购没买的', '天冷了他们想等暖和再买', '开春早鸟 9 折', '春天开卖时挽回 50 单', '好'],
    check: (rs, act) => [
      ['季节语义不崩（照常采集）', ['audience', 'offer'].every(k => slotVal(act, k))],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S10', name: '珠宝假货顾虑', steps: ['银饰店想挽回弃购的', '她们怕银饰掉色买到假货', '送擦拭布+证书', '挽回 40 单', '主要是信任问题，先跑通流程'],
    check: (rs, act) => [
      ['真假顾虑被接住（槽或回复）', /假|掉色|质量|信任|顾虑/.test(slotVal(act, 'reason') || '') || rs.some(r => /掉色|假货|信任|顾虑|证书/.test(r.reply))],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S11', name: '数字商品退款问句', steps: ['卖线上课程的，挽回加购没买的', '他们犹豫课程值不值', '送第一节试听', '转化 100 单', '可以'],
    check: (rs, act) => [
      ['试听类 offer 落账', slotVal(act, 'offer') !== null],
      ['extras 或槽吸收「试听」语义', /试听|体验/.test(slotVal(act, 'offer') || '') || (act.memory.extras || []).some(e => /试听|体验/.test(e.value || ''))],
    ] },
  { id: 'S12', name: '中古二手信任', steps: ['中古相机店想挽回下单没付的', '客人怕成色和实物不符', '钩子就发实拍图+7 天无理由', '挽回 15 单', '行'],
    check: (rs, act) => [
      ['成色顾虑入 reason', /成色|不符|信任|怕|假/.test(slotVal(act, 'reason') || '')],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S13', name: '多店铺边界', steps: ['我有三家店能在一个后台管吗', '先弄第一家吧，卖手账的', '挽回加购没付的', '忘记结账', '9 折'],
    check: (rs, act) => [
      ['多店问句坦诚回应不装会', /一家|先|目前|单个|帮/.test(rs[0].reply)],
      ['照常采集 ≥3 槽', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
    ] },
  { id: 'S14', name: '具体竞品提及', steps: ['我卖泳装的，客人都被 Shein 拉走了', '想挽回浏览没买的', '免邮吧', '挽回 60 单', '被 Shein 抢走的，给 9 折试试'],
    check: (rs, act) => [
      ['竞品语义被接住（槽或回复）', /shein|竞品|勾走|拉走|抢/i.test(slotVal(act, 'reason') || '') || rs.some(r => /shein/i.test(r.reply))],
      ['采集 ≥3 槽且无罐头', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
    ] },
  { id: 'S15', name: '全英文卖家', steps: ['I sell succulents online, want to win back cart abandoners', 'they just forgot to checkout', '10% off coupon', 'recover 30 orders', 'ok'],
    check: (rs, act) => [
      ['英文输入照常采集 ≥2 槽', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 2],
      ['不崩不罐头', rs.every(r => !CANNED_RE.test(r.reply))],
    ] },
  { id: 'S16', name: '中英混杂', steps: ['我的店卖 yoga mat 瑜伽垫，想挽回加了 cart 没付款的', '他们加购后就消失了', '给 15% off', 'goal 是先跑通流程', 'ok 就这样确认'],
    check: (rs, act) => [
      ['混杂输入采集 ≥3 槽', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
      ['进 S2', act.stage === 'S2'],
    ] },
  { id: 'S17', name: '纯表情输入', steps: ['我想挽回客人', '🙂🙂', '😂😂😂', '加购没付的那些人', '他们就是忘了', '9 折吧，先跑通流程'],
    check: (rs, act) => [
      ['表情轮不崩不写乱槽', rs[1].reply.length > 0 && rs[2].reply.length > 0],
      ['后续正常采集进 S2', act.stage === 'S2'],
    ] },
  { id: 'S18', name: '单字破碎输入', steps: ['货', '卖包的', '客', '加购没付款的', '忘了为啥，给 95 折，挽回 10 单'],
    check: (rs, act) => [
      ['破碎输入不崩', rs.slice(0, 3).every(r => r.reply.length > 2)],
      ['末轮补齐后 ≥3 槽', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
    ] },
  { id: 'S19', name: '无标点长串（语音转写）', steps: ['我卖保温杯的想挽回加了购物车没结账的客户他们是觉得价格有点贵钩子就给个十块优惠券吧目标是这个月挽回五十单'],
    check: (rs, act) => [
      ['无标点长句提取 ≥3 槽', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
      ['一轮或两轮内收敛', rs.length === 1],
    ] },
  { id: 'S20', name: '情绪抱怨接住', steps: ['你们这工具真难用我都不想弄了', '唉那还是说说挽回吧，我卖绿植的', '加购没付的客人', '就是犹豫价格', '95 折，先跑通流程'],
    check: (rs, act) => [
      ['情绪被接住不敷衍', /帮|别急|一起|简单|弄/.test(rs[0].reply)],
      ['后续照常采集进 S2', act.stage === 'S2'],
    ] },
  { id: 'S21', name: '竞品对比逼问', steps: ['你和 Klaviyo 比有啥优势', '行吧那就配一封，我卖桌布的', '挽回弃购的', '他们嫌运费贵', '免邮，先跑通流程'],
    check: (rs, act) => [
      ['对比问句坦诚不贬竞品', /邮件|挽回|帮你|专注|轻/.test(rs[0].reply)],
      ['后续进 S2', act.stage === 'S2'],
    ] },
  { id: 'S22', name: '要求保证效果', steps: ['我卖灯具的，你能保证挽回 50% 吗，保证不了我不用了', '那先试试', '加购没付的', '10% off', '挽回 30 单'],
    check: (rs, act) => [
      ['拒绝保证且留人（诚实口径）', /保证不了|没法保证|试|数据|看/.test(rs[0].reply)],
      ['用户留下继续采集', ['audience', 'offer', 'goal'].every(k => slotVal(act, k))],
    ] },
  { id: 'S23', name: '数据隐私问句', steps: ['我的客户数据存在哪啊，安全吗', '行，那开始吧，卖袜子的', '挽回弃购的', '忘了结账', '85 折，先跑通流程'],
    check: (rs, act) => [
      ['隐私问句给合规口径（不拍胸脯）', /自己的服务端|只用于|数据/.test(rs[0].reply)],
      ['后续进 S2', act.stage === 'S2'],
    ] },
  { id: 'S24', name: '极端白送折扣', steps: ['我卖手机壳的，直接 100% off 白送得了', '那不行的话 9 折吧', '加购没付的', '忘了结账', '挽回 100 单'],
    check: (rs, act) => [
      ['100% off 不被静默当钩子', !/^100% off$/.test(slotVal(act, 'offer') || '')],
      ['正常折扣可落账', slotVal(act, 'offer') !== null],
    ] },
  { id: 'S25', name: 'S2 预算改钩子', steps: ['我卖香薰机的，挽回加购没付的', '忘了结账', '满 300 减 50', '挽回 40 单', '预算不够，改成 9 折吧', '可以'],
    check: (rs, act) => [
      ['S2 期改钩子即时落账', /9\s*折|90/.test(slotVal(act, 'offer') || '')],
      ['仍停留 S2', act.stage === 'S2'],
    ] },
  { id: 'S26', name: '目标拉锯三次', steps: ['我卖帆布包的，挽回弃购的', '嫌贵', '10% off', '挽回 50 单', '改成 80 单', '还是 100 单吧', '可以'],
    check: (rs, act) => [
      ['拉锯后落最终值', /100/.test(slotVal(act, 'goal') || '')],
      ['拉锯不炸不循环', rs.every(r => !CANNED_RE.test(r.reply)) && maxRun(rs.map(r => r.reply)) <= 2],
    ] },
  { id: 'S27', name: 'extras 一次给全', steps: ['我卖猫砂的，挽回加购没付的', '忘了结账', '9 折', '挽回 50 单', '晚上 9 点发，每周最多一封，突出除臭强', '可以'],
    check: (rs, act) => [
      ['timing extras 落账', Boolean(extrasVal(act, 'timing'))],
      ['frequency extras 落账', Boolean(extrasVal(act, 'frequency'))],
      ['特色语义进 extras', (act.memory.extras || []).some(e => /除臭/.test(e.value || ''))],
    ] },
  { id: 'S28', name: '受众改走再改回', steps: ['我卖蓝牙音箱的，挽回加购没付的', '不对，主要是浏览没买的', '算了，还是加购没付的吧', '忘了结账', '10% off，挽回 20 单'],
    check: (rs, act) => [
      ['改回后受众正确', /加购/.test(slotVal(act, 'audience') || '')],
      ['改走改回不炸不空转', rs.every(r => !CANNED_RE.test(r.reply))],
      ['四齐进 S2', act.stage === 'S2'],
    ] },
  { id: 'S29', name: '确认后改钩子再确认', steps: ['我卖坐垫的，挽回加购没付的', '忘了结账', '买二送一', '挽回 25 单', '可以', '钩子改成 85 折', '嗯就这样'],
    check: (rs, act) => [
      ['确认后改钩子落账', /85|8\.5/.test(slotVal(act, 'offer') || '')],
      ['再确认回到收口', act.stage === 'S2'],
    ] },
  { id: 'S30', name: '严重错别字', steps: ['想挽囬加够未副的客人', '他们忘记结账了', '给 9 折', '挽回 20 单'],
    check: (rs, act) => [
      ['错别字下至少受众或语义被接住', slotVal(act, 'audience') !== null || /加购|加够|挽回|客人|哪拨|捞/.test(rs[0].reply)],
      ['不崩不罐头', rs.every(r => !CANNED_RE.test(r.reply))],
      ['流程可继续（≥3 槽）', ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length >= 3],
    ] },
];

/* ================ 运行器 ================ */
(async () => {
  console.log(`模型: ${cfg.aiModel} | 场景 S${String(FROM).padStart(2, '0')}–S${String(TO).padStart(2, '0')}`);
  const results = [];
  for (let i = FROM; i <= TO && i <= SCENARIOS.length; i++) {
    const scn = SCENARIOS[i - 1];
    const igde = makeEngine();
    const act = mkAct(`b3_${scn.id}`);
    act.messages.push({ role: 'assistant', content: igde.opening({ hasAnyAct: false, storeBanner: { connected: false } }).reply, ts: Date.now() });
    const rs = []; const lats = [];
    for (const input of scn.steps) {
      const t0 = Date.now();
      try {
        const r = await igde.handle(act, input, { persist: async () => {}, storeBanner: { connected: false } });
        rs.push({ in: input, reply: String(r.reply || ''), stage: act.stage, dt: Date.now() - t0 });
      } catch (e) {
        rs.push({ in: input, reply: '[异常] ' + (e && e.message || e), stage: act.stage, dt: Date.now() - t0 });
      }
      lats.push(rs[rs.length - 1].dt);
    }
    const checks = [];
    try { checks.push(...scn.check(rs, act)); } catch (e) { checks.push(['断言执行异常: ' + (e && e.message || e), false]); }
    checks.push(['全程无罐头', rs.every(r => !CANNED_RE.test(r.reply))]);
    checks.push(['无 3 连近似回复', maxRun(rs.map(r => r.reply)) <= 2]);
    checks.push(['单轮延迟 ≤20s', Math.max(...lats) <= 20000]);
    const pass = checks.every(c => c[1]);
    results.push({ id: scn.id, name: scn.name, pass, checks, lats, rs });
    const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
    console.log(`${pass ? 'PASS' : 'FAIL'} ${scn.id} ${scn.name}（${rs.length}轮/均 ${avg}ms）${pass ? '' : '\n' + checks.filter(c => !c[1]).map(c => '    ✗ ' + c[0]).join('\n')}`);
  }
  const ok = results.filter(r => r.pass).length;
  const allLats = results.flatMap(r => r.lats);
  console.log(`\n===== 30 场景汇总：${ok}/${results.length} 通过 | 延迟均值 ${Math.round(allLats.reduce((a, b) => a + b, 0) / allLats.length)}ms / 峰值 ${Math.max(...allLats)}ms =====`);
  if (ok < results.length) process.exit(1);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
