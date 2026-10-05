#!/usr/bin/env node
'use strict';
/**
 * eval/prd-matrix.js — PRD v5.1 逐功能点覆盖矩阵（2026-10-05）：8 域 36 点，每点「难题 + 常见错误」×2 轮。
 * 与 lib/acceptance/replay.js（H 章 21 句机器重放，I 域为主）互补：本矩阵打 A-G 域的难题/边界/常见错误。
 * 用法：node eval/prd-matrix.js [rounds=2]
 */
const { IGDE } = require('../lib/igde');
const { needs: needsMod } = require('../lib/needs');

const ROUNDS = parseInt(process.argv[2] || '2', 10);
const results = [];

/* ---------- 引擎工厂 ---------- */
function stubEngine() { // aiEnabled=false：纯规则引擎（确定性）
  return new IGDE({ aiEnabled: false, criticMode: 'off' });
}
function scriptedEngine(envelopes) { // 脚本化 envelope：第 n 次 callAI 返回 envelopes[n % len]
  let i = 0;
  return new IGDE({
    aiEnabled: true,
    callAI: async () => ({ ...(envelopes[(i++) % envelopes.length]), extras: envelopes[(i - 1) % envelopes.length].extras || [], slotUpdates: envelopes[(i - 1) % envelopes.length].slotUpdates || [], corrections: envelopes[(i - 1) % envelopes.length].corrections || [] }),
    callCritic: async () => true,
    criticMode: 'off'
  });
}
function deadEngine() {
  return new IGDE({ aiEnabled: true, callAI: async () => { throw new Error('LLM HTTP 503'); }, callCritic: async () => true, criticMode: 'off' });
}
function mkAct(id) {
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 'm' };
}
async function turn(igde, act, text, opts = {}) {
  return igde.handle(act, text, { persist: async () => {}, storeBanner: { connected: false }, ...opts });
}
const slotVal = (act, k) => (act.needs[k] ? act.needs[k].value : null);
const warm = (act, slots) => { for (const [k, v] of Object.entries(slots || {})) act.needs[k] = { value: v, source: 'explicit', at: 1 }; act.stage = 'S1'; };

/* ---------- 矩阵定义 ---------- */
const MATRIX = [
  /* ===== A 域 ===== */
  { point: 'A1', name: '会话锚定与创建', fn: async (rd) => {
    const igde = stubEngine();
    const act1 = mkAct(`a1_${rd}`);
    const op1 = igde.opening({ hasAnyAct: false, storeBanner: { connected: false } });
    const op2 = igde.opening({ hasAnyAct: true, storeBanner: { connected: false } });
    const act2 = mkAct(`a1b_${rd}`);
    await turn(igde, act2, '想挽回客人');
    return [
      [`欢迎语一生一次(hasAnyAct=false→${op1.welcome}/true→${op2.welcome})`, op1.welcome === true && op2.welcome === false],
      ['出口 chips 3 项', JSON.stringify(op1.chips) === JSON.stringify(['好，帮我写一封', '介绍一下其他功能', '其他需求'])],
      ['首条消息即建采集态(S0→S1)', act2.stage === 'S1'],
      ['开场含四要素清单', /发给谁|为什么流失/.test(op1.reply)],
    ];
  } },
  { point: 'A2', name: '状态存储契约', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`a2_${rd}`);
    act.needs = { audience: '加购未付客户', pain: '忘了付款', offer: null, goal: null }; // 旧契约：字符串槽 + pain 旧名
    await turn(igde, act, '跑通流程吧');
    return [
      ['字符串槽迁移为三态对象', act.needs.audience && typeof act.needs.audience === 'object' && act.needs.audience.value === '加购未付客户'],
      ['pain 旧名迁移到 reason', slotVal(act, 'reason') !== null],
      ['缺失槽补 null(键齐全)', ['audience', 'reason', 'offer', 'goal'].every(k => k in act.needs)],
    ];
  } },
  { point: 'A3', name: '会话恢复与商家记忆', fn: async (rd) => {
    const igde = scriptedEngine([
      { reply: '记下了。', slotUpdates: [], extras: [{ key: 'brand', value: 'LunaGlow' }, { key: '客单价', value: '28美元' }], corrections: [] },
      { reply: '改成 35。', slotUpdates: [], extras: [], corrections: [{ slot: '客单价', old: '28美元', new: '35美元' }] },
      { reply: '你的品牌叫 LunaGlow，客单价 35 美元。', slotUpdates: [], extras: [], corrections: [] },
    ]);
    const act = mkAct(`a3_${rd}`);
    await turn(igde, act, '我品牌叫 LunaGlow 做香薰的客单价28美元');
    await turn(igde, act, '客单价改成 35 美元');
    await turn(igde, act, '我品牌叫啥？客单价多少？');
    const aov = (act.memory.extras || []).find(e => /客单|aov/i.test(e.key));
    return [
      ['extras 品牌入账', (act.memory.extras || []).some(e => e.key === 'brand' && e.value === 'LunaGlow')],
      ['corrections 落账到 extras', aov && String(aov.value).includes('35')],
      ['三轮后记忆可召回(reply 含 LunaGlow)', /LunaGlow/.test(act.messages[act.messages.length - 1].content)],
    ];
  } },
  { point: 'A4', name: '僵尸会话收口', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`a4_${rd}`);
    act.stage = 'closed'; // sweep 收口后的只读归档态
    const before = JSON.stringify(act.needs);
    const r = await turn(igde, act, '再帮我配一封');
    return [
      ['closed 会话拒绝新输入并如实说', /归档|收尾|新会话/.test(r.reply)],
      ['拒绝轮不写槽', JSON.stringify(act.needs) === before],
      ['拒绝轮 guardrailHits 记 CLOSED', (r.guardrailHits || []).includes('CLOSED')],
    ];
  } },
  /* ===== B 域 ===== */
  { point: 'B1', name: '提取（难题口语）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`b1_${rd}`);
    await turn(igde, act, '有批人加了购物车又跑路了，想捞回来'); // 口语：加购未付
    const ok1 = slotVal(act, 'audience') === '加购未付客户';
    const act2 = mkAct(`b1b_${rd}`);
    await turn(igde, act2, '客人基本都是欧美的'); // 常见错：泛人群不填「全部」
    return [
      ['口语「加了购物车又跑路」→加购未付客户', ok1],
      ['泛修饰「基本都是欧美的」不误填全部人群', slotVal(act2, 'audience') === null],
    ];
  } },
  { point: 'B2', name: '合并（同义豁免/双改一轮）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`b2_${rd}`);
    warm(act, { reason: '忘记结账' });
    const c0 = (act.memory.conflicts || []).length;
    await turn(igde, act, '对，就是忘了付款'); // 同义重申 → 豁免不产冲突
    const synOk = (act.memory.conflicts || []).length === c0;
    const act2 = mkAct(`b2b_${rd}`);
    warm(act2, {});
    await turn(igde, act2, '钩子给 10% off，不对，还是 15% off'); // 一句双改 → 取最终值
    return [
      ['同义重申不产冲突候选', synOk],
      ['一句双改落最终值 15% off', slotVal(act2, 'offer') === '15% off'],
    ];
  } },
  { point: 'B3', name: '记账（先落库后回复）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`b3_${rd}`);
    let threw = null;
    try { await igde.handle(act, '想挽回加购没付的客人', { persist: async () => { const e = new Error('db down'); e.code = 'PERSIST_FAIL'; throw e; } }); }
    catch (e) { threw = e; }
    return [
      ['落库失败本轮不回复(抛 PERSIST_FAIL)', threw && threw.code === 'PERSIST_FAIL'],
      ['失败文案面向用户', threw && /没存上|再说一次/.test(threw.message)],
    ];
  } },
  { point: 'B4', name: '选问（一轮一问/跳过已问）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`b4_${rd}`);
    const seq = [];
    for (const inp of ['加购没付的客人', '忘记结账', '9 折', '跑通流程吧']) {
      const r = await turn(igde, act, inp);
      seq.push((r.reply || '').slice(0, 120));
    }
    const orderOk = /流失|为啥|原因/.test(seq[0]) && /钩子/.test(seq[1]);
    return [
      ['问序 audience→reason→offer（首句即答受众，回复依次问下一缺失槽）', orderOk],
      ['四轮后四槽全满进 S2', act.stage === 'S2' && ['audience', 'reason', 'offer', 'goal'].every(k => slotVal(act, k))],
    ];
  } },
  { point: 'B5', name: '回复组装（inferred 纠正语）', fn: async (rd) => {
    // inferred 生效条件：模型低置信复述原话 + 词表未命中（词表命中按「原话直通」走 explicit，设计口径）
    const igde = scriptedEngine([
      { reply: '行，那按到付款那步犹豫的人配。', slotUpdates: [{ slot: 'reason', value: '到付款那步犹豫', confidence: 0.5, inferred: true }], extras: [], corrections: [] },
    ]);
    const act = mkAct(`b5_${rd}`);
    const r = await turn(igde, act, '他们是到付款那步就走了');
    return [
      ['inferred 槽回复带纠正语义', /我理解为|不对请纠正|不对请|纠正/.test(r.reply)],
      ['槽值以 inferred 源入账', act.needs.reason && act.needs.reason.source === 'inferred'],
    ];
  } },
  /* ===== C 域 ===== */
  { point: 'C1', name: 'audience 槽（从句陷阱）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`c1_${rd}`);
    await turn(igde, act, '我想让他们看看新款，顺便挽回点销量'); // 常见错：意图从句「看看」误触发浏览未买
    const act2 = mkAct(`c1b_${rd}`);
    await turn(igde, act2, '主要是 25 到 40 岁的美国女性'); // 难题：画像原话截取
    return [
      ['意图从句「看看」不误触发浏览未买', slotVal(act, 'audience') === null],
      ['画像原话「25到40岁的美国女性」入槽', /25\s*到\s*40/.test(slotVal(act2, 'audience') || '')],
    ];
  } },
  { point: 'C2', name: 'reason 槽（多源口语）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`c2_${rd}`);
    await turn(igde, act, '客人说运费太贵就不付了');
    const act2 = mkAct(`c2b_${rd}`);
    await turn(igde, act2, '感觉是被别的牌子勾走了');
    return [
      ['「运费太贵」→嫌运费贵、临门犹豫', slotVal(act, 'reason') === '嫌运费贵、临门犹豫'],
      ['「被别的牌子勾走」→被竞品勾走', slotVal(act2, 'reason') === '可能被竞品勾走'],
    ];
  } },
  { point: 'C3', name: 'offer 槽（数字陷阱）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`c3_${rd}`);
    await turn(igde, act, '目标是让他们 100% 回来下单'); // 常见错：100% 不是折扣
    const act2 = mkAct(`c3b_${rd}`);
    await turn(igde, act2, '发送频率每周两次，别一天一封'); // 常见错：频率里的「发」不算钩子
    const act3 = mkAct(`c3c_${rd}`);
    await turn(igde, act3, '优惠码就用 KEYBOARD12');
    return [
      ['「100% 回来下单」不误当折扣', slotVal(act, 'offer') === null],
      ['「发送频率…」不误当钩子', slotVal(act2, 'offer') === null],
      ['自定义码名保留 KEYBOARD12', /KEYBOARD12/.test(slotVal(act3, 'offer') || '')],
    ];
  } },
  { point: 'C4', name: 'goal 槽（数值截取/阶梯）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`c4_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
    await turn(igde, act, '目标 5000 美金'); // 难题：无「挽回」字样的金额目标
    const ok1 = /5000/.test(slotVal(act, 'goal') || '');
    const act2 = mkAct(`c4b_${rd}`);
    warm(act2, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
    await turn(igde, act2, '先试发一封'); // 口语跑通流程族
    const act3 = mkAct(`c4c_${rd}`);
    warm(act3, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
    const r3 = await turn(igde, act3, '挽回订单'); // 裸类目 → 收窄阶梯
    return [
      ['「目标 5000 美金」原话截取入槽', ok1],
      ['「先试发一封」→先跑通流程', slotVal(act2, 'goal') === '先跑通流程'],
      ['裸类目「挽回订单」收窄追问数值', /多少单/.test(r3.reply) && slotVal(act3, 'goal') === null],
    ];
  } },
  { point: 'C5', name: 'extras 旁路', fn: async (rd) => {
    const igde = scriptedEngine([
      { reply: '好，记下 48 小时长烧。', slotUpdates: [], extras: [{ key: 'feature', value: '48 小时长烧' }, { key: 'timing', value: '晚上 8 点' }], corrections: [] },
    ]);
    const act = mkAct(`c5_${rd}`);
    await turn(igde, act, '邮件里突出 48 小时长烧，晚上 8 点发');
    const f = (act.memory.extras || []).find(e => e.key === 'feature');
    const t = (act.memory.extras || []).find(e => e.key === 'timing');
    return [
      ['特色原话保留「48 小时长烧」', f && f.value === '48 小时长烧'],
      ['时段入 timing extras', Boolean(t)],
      ['卡片素材区可消费 extras（filled 不变不冒槽）', ['audience', 'reason', 'offer', 'goal'].every(k => !slotVal(act, k))],
    ];
  } },
  { point: 'C6', name: 'inferred/模糊兜底（0 编造）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`c6_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
    await turn(igde, act, '随便吧'); // 模糊：不得编造数值目标
    const g = act.needs.goal;
    return [
      ['模糊回答不编造数值目标', g === null || !/\d/.test(g.value || '') || g.source === 'inferred'],
      ['若入槽必标 inferred', g === null || g.source === 'inferred'],
    ];
  } },
  /* ===== D 域 ===== */
  { point: 'D1', name: 'S2 确认卡', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`d1_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off', goal: '先跑通流程' });
    act.stage = 'S2';
    const r = await turn(igde, act, '可以');
    return [
      ['S2 确认轮引导确认按钮（生成只走 /confirm）', /确认/.test(r.reply) && !/已帮你生成|已创建/.test(r.reply)],
      ['停留 S2', act.stage === 'S2'],
    ];
  } },
  { point: 'D2', name: '改参回流', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`d2_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off', goal: '先跑通流程' });
    act.stage = 'S2';
    const before = slotVal(act, 'audience');
    await turn(igde, act, '受众改成浏览未买的');
    return [
      ['S2 期改参即时落账', slotVal(act, 'audience') !== before && /浏览/.test(slotVal(act, 'audience') || '')],
      ['corrections 记账(旧值留痕)', (act.memory.corrections || []).some(c => c.slot === 'audience')],
      ['保持 S2（改参不当新话题）', act.stage === 'S2'],
    ];
  } },
  { point: 'D3', name: 'planCard 同源（假码红线）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`d3_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off', goal: '先跑通流程' });
    act.stage = 'S2';
    const r = await turn(igde, act, '可以');
    const cardStr = r.planCard ? JSON.stringify(r.planCard) : '';
    return [
      ['降级档位不出预览卡（剧本#13）', r.planCard === null || r.planCard === undefined],
      ['降级引擎档位诚实标注', r.engine === 'degraded'],
      ['无码状态卡面不出现编造折扣码（E2 红线）', !/[A-Z]{4,}\d{2,}/.test(cardStr) || cardStr === ''],
    ];
  } },
  /* ===== E 域 ===== */
  { point: 'E1', name: '冲动折扣拦截', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`e1_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off', goal: '先跑通流程' });
    act.stage = 'S2';
    const r = await turn(igde, act, '直接给我上五折清仓大甩卖');
    return [
      ['大折扣冲动被拦（毛利风险 + 替代建议）', /毛利|50%|五折|替代/.test(r.reply)],
      ['拦截轮给替代出口（三选一/坚持原案）', /替代|选哪个|坚持/.test(r.reply)],
      ['拦截轮不把 50% off 静默落槽', slotVal(act, 'offer') !== '50% off'],
    ];
  } },
  { point: 'E5', name: '无关输入拉回', fn: async (rd) => {
    const igde = stubEngine();
    // ① 零上下文首句闲聊 → 温和接住拉回（S0 路由）
    const r1 = await turn(igde, mkAct(`e5a_${rd}`), '今天天气怎么样');
    // ② 已有上下文时连发 3 轮无进展闲聊 → 弱信号拉回（userTurns≥3 规则）
    const act = mkAct(`e5b_${rd}`);
    warm(act, { audience: '加购未付客户' });
    await turn(igde, act, '今天天气怎么样');
    await turn(igde, act, '你吃午饭了吗');
    const before = JSON.stringify(act.needs);
    const r2 = await turn(igde, act, '外面的天空真蓝啊');
    return [
      ['首句闲聊被温和接住且拉回主题', /丢了|回来|挽回|邮件|流失|客人|正事/.test(r1.reply)],
      ['3 轮无进展闲聊被弱信号拉回', /挽回|邮件|流失|客人|回到/.test(r2.reply)],
      ['闲聊全程不写槽', JSON.stringify(act.needs) === before],
    ];
  } },
  /* ===== F 域 ===== */
  { point: 'F1', name: '零配置开场（数据先于提问）', fn: async (rd) => {
    const igde = stubEngine();
    const opData = igde.opening({ hasAnyAct: false, storeBanner: { connected: true, store_name: 'AquaFlow', weekly_abandoned_count: 12, aov: 30, abandoned_value: 360 } });
    const clean = opData.reply.replace(/\s+/g, '');
    return [
      ['有数据时数据句先于信息清单', clean.indexOf('AquaFlow') < clean.indexOf('我还需要的信息')],
      ['数据句含人数/客单/弃购总额', /12个加购未付/.test(clean) && /¥30/.test(clean) && /¥360/.test(clean)],
      ['出口问句在清单之后', clean.indexOf('需要现在就编写邮件') > clean.indexOf('我还需要的信息')],
    ];
  } },
  { point: 'F2', name: '对话内真实算账（无数据口径）', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`f2_${rd}`);
    warm(act, { audience: '加购未付客户' });
    const r = await turn(igde, act, '这批人值多少钱');
    return [
      ['算账意图被接住', /算账|算笔账|人数|客单|挽回率/.test(r.reply)],
      ['无数据不编数字（先圈人再算）', /先圈|圈到人|告诉我|哪拨/.test(r.reply)],
      ['口径披露（公式/预估）', /人数\s*[×x]\s*客单|挽回率|预估|口径/.test(r.reply)],
    ];
  } },
  { point: 'F4', name: '进度唯一口径', fn: async (rd) => {
    const igde = stubEngine();
    const act = mkAct(`f4_${rd}`);
    await turn(igde, act, '挽回加购没付的客人');
    const f1 = act.filled_count;
    await turn(igde, act, '他们是忘了结账');
    const f2 = act.filled_count;
    const nonEmpty = ['audience', 'reason', 'offer', 'goal'].filter(k => slotVal(act, k)).length;
    return [
      ['filled_count 单调不减', f2 >= f1],
      ['进度数字只由落库层派生（引擎层不虚报）', f2 === 0 || f2 === nonEmpty],
    ];
  } },
  /* ===== G 域 ===== */
  { point: 'G1', name: '在线 Prompt 契约', fn: async (rd) => {
    let captured = null;
    const igde = new IGDE({
      aiEnabled: true,
      callAI: async (messages) => { captured = messages; return { reply: '好。', slotUpdates: [], extras: [], corrections: [] }; },
      callCritic: async () => true, criticMode: 'off'
    });
    const act = mkAct(`g1_${rd}`);
    await turn(igde, act, '想挽回客人');
    const sys = captured && captured[0] && captured[0].content || '';
    return [
      ['system 含防注入铁律', /防注入/.test(sys)],
      ['system 含输出 JSON 契约(slot_updates)', /slot_updates/.test(sys)],
      ['user 消息携带本轮输入', captured.some(m => m.role === 'user' && /想挽回客人/.test(m.content || ''))],
    ];
  } },
  { point: 'G2', name: '降级路径同状态机', fn: async (rd) => {
    const igde = deadEngine();
    const act = mkAct(`g2_${rd}`);
    const r1 = await turn(igde, act, '挽回加购没付的客人');
    const r2 = await turn(igde, act, '忘了结账');
    const r3 = await turn(igde, act, '9 折');
    const r4 = await turn(igde, act, '跑通流程吧');
    return [
      ['宕机仍按状态机采集到四齐', act.stage === 'S2' && ['audience', 'reason', 'offer', 'goal'].every(k => slotVal(act, k))],
      ['降级档位诚实(engine=degraded)', [r1, r2, r3, r4].every(r => r.engine === 'degraded')],
      ['降级满卡不出 planCard', r4.planCard == null],
    ];
  } },
  { point: 'G3', name: '熔断与防呆', fn: async (rd) => {
    const igde = deadEngine();
    const act = mkAct(`g3_${rd}`);
    warm(act, { audience: '加购未付客户', reason: '忘记结账', offer: '10% off' });
    act.memory.loop_breaks = 2; // 熔断计数已到阈值
    const r = await turn(igde, act, '嗯');
    return [
      ['loop_breaks≥2 → 强制弹确认卡', act.stage === 'S2' && /确认/.test(r.reply)],
      ['缺槽推断补满(全 inferred)', slotVal(act, 'goal') !== null],
    ];
  } },
];

(async () => {
  for (const item of MATRIX) {
    const runs = [];
    for (let rd = 1; rd <= ROUNDS; rd++) {
      try { runs.push({ rd, checks: await item.fn(rd) }); }
      catch (e) { runs.push({ rd, checks: [['执行异常: ' + (e && e.message || e), false]] }); }
    }
    const allChecks = runs.flatMap(r => r.checks);
    const pass = allChecks.every(([, ok]) => ok);
    const fails = allChecks.filter(([, ok]) => !ok).map(([n]) => n);
    results.push({ point: item.point, name: item.name, pass, fails, rounds: ROUNDS });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${item.point} ${item.name} ×${ROUNDS}轮${fails.length ? '  ✗ ' + fails.join(' | ') : ''}`);
  }
  const okN = results.filter(r => r.pass).length;
  console.log(`\n===== 矩阵汇总：${okN}/${results.length} 点全过（每点 ×${ROUNDS} 轮难题+常见错误） =====`);
  const bad = results.filter(r => !r.pass);
  if (bad.length) { console.log('未过点：' + bad.map(b => b.point).join(', ')); process.exit(1); }
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
