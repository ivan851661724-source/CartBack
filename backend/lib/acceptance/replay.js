'use strict';
/**
 * lib/acceptance/replay.js — PRD v2 21 句验收的重放 harness（Wave 5 起三句 deferred 清零，全部 in-scope）。
 *
 * 单一权威：输入 = eval/cases/prd-v2.jsonl（21 句）；引擎按句重放脚本化 envelope（假 callAI 注入缝），
 * 断言打在引擎行为上（B1-B5 / 批次域确定性短轮 / Wave 5 短轮）。
 * 消费方：test/acceptance21.test.js（node --test 硬门）与 eval/replay21.js（归档报告，exit 0 跑通）。
 *
 * 逐句断言全部 try/catch 收集 —— runAll() 永不抛错，返回逐句 {pass, failures} 供两侧各自裁决。
 */

const path = require('path');
const { IGDE } = require('../igde');
const assert = require('node:assert/strict');
const { loadCases, makeAcceptanceAct, makePersistRecorder, assertPersistBeforeTokens, assertTurnCommon } = require('./assert');

const CASES_FILE = path.join(__dirname, '..', '..', 'eval', 'cases', 'prd-v2.jsonl');

// —— 21 句 in-scope 的脚本化 envelope（与 jsonl input 一一对应；短轮句的 reply 由引擎确定性组装，脚本值不上屏）——
const ENVELOPES = {
  p01: {
    reply: '收到！LunaGlow 的手工香薰蜡烛，客单价 28 美元，记下了。你最想挽回哪拨客人？加购没付的、逛了没买的，还是好久没来的老客？',
    restatement: ['收到：品牌 LunaGlow，手工香薰蜡烛，客单价 28 美元'],
    slot_updates: [],
    extras: [{ key: 'brand', value: 'LunaGlow' }, { key: '品类', value: '手工香薰蜡烛' }, { key: '客单价', value: '28美元' }],
    corrections: []
  },
  p02: {
    reply: '明白，25 到 40 岁、居家的美国女性客群。那他们为啥会丢？是太久没动静、被别家勾走，还是单纯忘了？',
    restatement: ['收到：主要客户是 25-40 岁美国女性，喜欢居家氛围和天然成分'],
    slot_updates: [{ slot: 'audience', value: '25-40岁美国女性', confidence: 0.95, inferred: false }],
    extras: [{ key: '兴趣', value: '居家氛围、天然成分' }],
    corrections: []
  },
  p03: {
    reply: '好，客单价按 35 美元记。他们为啥快丢，想过了吗？忘了结账、在比价，还是别的原因？',
    restatement: ['收到：客单价改成 35 美元'],
    slot_updates: [],
    extras: [],
    corrections: [{ slot: '客单价', old: '28美元', new: '35美元' }]
  },
  p04: {
    reply: '这里得跟你对齐一下：前面记的是 25-40 岁的美国女性，你刚说主要是年轻人——以哪个为准？18-24 还是 25-34？',
    restatement: ['收到：客户主要是年轻人（与已记客群冲突，需澄清）'],
    slot_updates: [{ slot: 'audience', value: '年轻人', confidence: 0.9, inferred: false }],
    extras: [],
    corrections: []
  },
  p05: {
    reply: '懂了，就盯加购未付款的这拨人。他们回来想干啥——直接把订单付了，还是先回店逛逛？',
    restatement: ['收到：挽回原因盯加购未付款'],
    slot_updates: [{ slot: 'reason', value: '加购未付款', confidence: 0.95, inferred: false }],
    extras: [],
    corrections: []
  },
  p06: {
    reply: '收到，钩子就给 10% off。最后一样：你希望他们回来做到啥？挽回多少单、还是先把流程跑通？',
    restatement: ['收到：折扣力度 10% off'],
    slot_updates: [{ slot: 'offer', value: '10% off', confidence: 0.95, inferred: false }],
    extras: [],
    corrections: []
  },
  p07: {
    reply: '发送时段晚上 8 点，记下了。目标那块你还没说——希望他们回来干啥？挽回订单、冲具体金额，还是先跑通流程？',
    restatement: ['收到：发送时段晚上 8 点'],
    slot_updates: [],
    extras: [{ key: '发送时段', value: '晚上8点' }],
    corrections: []
  },
  p08: {
    reply: '天然大豆蜡、48 小时长烧，这个卖点抓人。咱还差最后一项：你希望他们回来做到啥？',
    restatement: ['收到：产品特色天然大豆蜡、48 小时长烧'],
    slot_updates: [],
    extras: [{ key: '产品特色', value: '天然大豆蜡、48小时长烧' }],
    corrections: []
  },
  p09: {
    reply: '好，营销目标：本月挽回 100 单。四样都齐了，我帮你按这个配一封挽回邮件，你在确认卡里核对一下，行不？',
    restatement: ['收到：营销目标本月挽回 100 单'],
    slot_updates: [{ slot: 'goal', value: '本月挽回 100 单', confidence: 0.95, inferred: false }],
    extras: [],
    corrections: []
  },
  p10: {
    reply: '频率这条记住了：每周不超过 2 封。配置都在确认卡里，你过一眼，行就确认。',
    restatement: ['收到：发送频率每周不超过 2 封'],
    slot_updates: [],
    extras: [{ key: '发送频率', value: '每周不超过2封' }],
    corrections: []
  },
  p11: {
    reply: '这个咱记着呢——目标就是本月挽回 100 单，没变。确认卡就在下面，核对完就能发。',
    restatement: ['收到：营销目标仍是本月挽回 100 单'],
    slot_updates: [{ slot: 'goal', value: '本月挽回 100 单', confidence: 1.0, inferred: false }],
    extras: [],
    corrections: []
  },
  // #12（Wave 5 启用）：对话内语种越权 —— 引擎确定性短轮拒绝（脚本 reply 不上屏）
  p12: {
    reply: '（语种越权拦截由引擎确定性拒绝，本回复不上屏）',
    restatement: ['收到：要求邮件正文用中文'],
    slot_updates: [],
    extras: [],
    corrections: []
  },
  // #13（Wave 2 启用，降级补测）：方案卡/邮件预览类 —— 降级语义见 acceptance21.test.js 专门用例
  // 注意：reply 避开 L4 抢跑词表（「方案卡/主题行/正文…」原词会触发重生成、打乱剧本）
  p13: {
    reply: '配置都在下面确认标签里了，四样都齐。点「确认」我就去你店铺建码、出正式卡片。',
    restatement: ['收到：查看配置'],
    slot_updates: [],
    extras: [],
    corrections: []
  },
  // #14（Wave 5 启用）：S2 后闲聊 —— 在线脚本回复 = 礼貌拉回 + 状态复述（降级 3 连闲聊专项另测）
  p14: {
    reply: '哈哈这个咱就不聊啦～你那四样配置都齐了，就在下面确认卡里，想调哪样说一声，没问题就可以发了。',
    restatement: ['收到：闲聊（拉回主业）'],
    slot_updates: [],
    extras: [],
    corrections: []
  },
  // #15 时序编排：#4 冲突在 #5 被 C6 兜底（受众=年轻人 inferred）后，此处带修正语气重放，两条 correction 均可执行
  p15: {
    reply: '改好了：客群换成老客，钩子换成 15% off。确认卡里已经同步，你再核对一眼。',
    restatement: ['收到：受众改成老客；折扣换成 15%'],
    slot_updates: [],
    extras: [],
    corrections: [
      { slot: 'audience', old: '年轻人', new: '老客' },
      { slot: 'offer', old: '10% off', new: '15% off' }
    ]
  },
  // #16 S2 后任意输入：引导确认（envelope 走流式，保证 B3 顺序断言有 token 帧）
  p16: {
    reply: '都核对好了就点「确认发送」，我这边随时开工。有要再调的地方，直接跟我说。',
    restatement: ['收到：商家确认配置'],
    slot_updates: [],
    extras: [],
    corrections: []
  },
  // #17（Wave 3 启用）：并列批次 —— batch_plan 待确认，引擎逐批复述（确定性组装，reply 不上屏）
  p17: {
    reply: '（拆批确认由引擎按净值预览逐批复述）',
    restatement: ['收到：拆两批 —— 加购未付、下单未付'],
    slot_updates: [],
    extras: [],
    corrections: [],
    batch_plan: [{ audience: '加购未付', offer: '10% off' }, { audience: '下单未付', offer: '10% off' }]
  },
  // #18（Wave 3 启用）：全局停发 —— 黑五日历 + 紧急全停（恢复须明说）
  p18: {
    reply: '（停发编排由引擎确定性组装）',
    restatement: ['收到：黑五停发 + 先全停'],
    slot_updates: [],
    extras: [],
    corrections: [],
    campaign_ops: [
      { op: 'blackout', params: { from: '2026-11-27', to: '2026-11-28', label: '黑五' } },
      { op: 'pause_all' }
    ]
  },
  // #19（Wave 3 启用）：未发部分改折扣（边界声明）
  p19: {
    reply: '（改折扣由引擎组装边界声明）',
    restatement: ['收到：A 批未发部分折扣改为 15%'],
    slot_updates: [],
    extras: [],
    corrections: [],
    campaign_ops: [{ op: 'discount', target: 'A', params: { percent_off: 15 } }]
  },
  // #20（Wave 3 启用）：建批自动排除（核对单净值 + 逐条明细）
  p20: {
    reply: '（建批排除明细由引擎组装）',
    restatement: ['收到：再建一批加购未付，排除已下单与已触达'],
    slot_updates: [],
    extras: [],
    corrections: [],
    batch_plan: [{ audience: '加购未付', offer: '10% off' }]
  },
  // #21（Wave 5 启用）：批次状态汇报 —— 引擎确定性组装（脚本 reply 不上屏）
  p21: {
    reply: '（批次状态汇报由引擎确定性组装，本回复不上屏）',
    restatement: ['收到：问批次状态'],
    slot_updates: [],
    extras: [],
    corrections: []
  }
};
const IN_SCOPE_ORDER = [
  'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11',
  'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20', 'p21'
];

/**
 * Wave 3/5 批次域执行器桩（I1-I4 + Wave 5 I5/E1 注入缝）：与 server.makeCampaignExecutor 同一结构化结果契约，
 * 引擎侧人话组装（逐批复述 / 边界声明 / 排除明细 / 三行汇报）是真实执行的被测对象。
 */
function makeWave5Executor() {
  const calls = { previewBatches: [], createBatches: [], campaignOps: [], pauseAll: 0, resumeAll: 0, addBlackout: [], audits: [], saleWindow: false };
  const reachOf = (desc) => (String(desc).includes('加购') ? 23 : 17);
  // I5 汇报数据源（publicCampaign 形状）：A 打开率 1/18≈5.6% <10% → 异常建议；B 53% 正常
  const REPORTS = [
    { id: 'cmp_a', name: 'A 加购未付', status: 'running', reach_count: 23, sent_count: 18, stats: { opened: 1, clicked: 0, recovered: 2, gmv: 120, net: 108 } },
    { id: 'cmp_b', name: 'B 下单未付', status: 'running', reach_count: 17, sent_count: 17, stats: { opened: 9, clicked: 4, recovered: 3, gmv: 210, net: 189 } }
  ];
  return {
    calls,
    async previewBatches(batches) {
      calls.previewBatches.push(batches);
      return batches.map((b, i) => ({
        name: `${'ABC'[i]} ${b.audience_desc}`,
        audience_desc: b.audience_desc,
        offer_text: b.offer_text || '10% off',
        percent_off: 10,
        reach_count: reachOf(b.audience_desc),
        excluded: String(b.audience_desc).includes('加购')
          ? [{ reason: '已购买（店铺已下单）', count: 2 }, { reason: '频控窗口内已触达', count: 1 }]
          : []
      }));
    },
    async createBatches(batches) {
      calls.createBatches.push(batches);
      return {
        campaigns: batches.map((b, i) => ({
          id: 'cmp_' + i, name: `${'ABC'[i]} ${b.audience_desc}`, audience_desc: b.audience_desc,
          status: 'draft', discount: { text: '', code: 'CART' + (10 + i), code_status: 'created' },
          reach_count: reachOf(b.audience_desc), scheduled_at: null
        })),
        failures: [],
        advice: null
      };
    },
    resolveTarget() { return { campaign_id: 'cmp_0', name: 'A 加购未付' }; },
    async campaignOp(o) {
      calls.campaignOps.push(o);
      return {
        ok: true, name: 'A 加购未付', code: 'NEW15', oldCode: 'OLD10',
        changed: ['折扣改为 15%'], boundary: '已发 18 封不受影响，改的是未发的 5 封'
      };
    },
    async pauseAll() { calls.pauseAll += 1; return { ok: true, paused: 1, frozen: 1 }; },
    async resumeAll() { calls.resumeAll += 1; return { ok: true, resumed: [], resumed_count: 0 }; },
    async addBlackout(params) { calls.addBlackout.push(params); return { ok: true, range: { from: params.from, to: params.to, label: params.label } }; },
    // —— Wave 5 注入缝 ——
    listCampaignReports() { return REPORTS.map(x => ({ ...x, stats: { ...x.stats } })); },
    saleWindow() { return calls.saleWindow === true; },
    audit(entry) { calls.audits.push(entry); return { ok: true }; }
  };
}

/** 逐句断言（在循环内打点：act 是单例，跨轮状态会演变，每句断言看当轮时刻的状态） */
const PER_TURN = {
  p01(a, r) {
    // #1 品牌名/品类/客单价进 extras；audience 仍空；下一问问 audience
    const acc = require('./assert');
    acc.assertSlots(a, { audience: null }, 'p01');
    acc.assertExtras(a, { brand: 'LunaGlow', '品类': '手工香薰蜡烛', '客单价': '28美元' }, 'p01');
    assert.deepEqual(r.chips, ['加购未付', '浏览未买', '老客'], 'p01 chips=audience 快捷项');
    assert.equal(r.askedSlot, 'audience', 'p01 追问槽=audience');
    assert.equal(a.memory.ask_count.audience, 1, 'p01 追问 audience 记账');
  },
  p02(a, r) {
    const acc = require('./assert');
    acc.assertSlots(a, { audience: { contains: ['25', '40', '美国女性'], source: 'explicit' } }, 'p02');
    acc.assertExtras(a, { '兴趣': '居家氛围、天然成分' }, 'p02');
    assert.deepEqual(r.chips, ['忘记结账', '在对比价格', '我来说原因'], 'p02 chips=reason 快捷项');
    assert.equal(a.memory.ask_count.reason, 1, 'p02 追问 reason 记账');
  },
  p03(a, r) {
    const acc = require('./assert');
    const corr = a.memory.corrections[a.memory.corrections.length - 1];
    assert.deepEqual(
      { slot: corr.slot, old: corr.old, new: corr.new, scope: corr.scope },
      { slot: '客单价', old: '28美元', new: '35美元', scope: 'extras' },
      'p03 corrections 应追加客单价纠正（旧值以库内现值重算）'
    );
    acc.assertExtras(a, { '客单价': '35美元' }, 'p03');
    acc.assertReplyIncludes(r, ['35'], 'p03');
    assert.equal(a.filled_count, 1, 'p03 filled_count 不变');
  },
  p04(a, r) {
    const acc = require('./assert');
    assert.equal(acc.slotText(a.needs.audience), '25-40岁美国女性', 'p04 audience 不被「年轻人」覆盖');
    assert.equal(a.needs.audience.source, 'explicit', 'p04 audience 保持 explicit');
    assert.deepEqual(r.chips, ['18-24', '25-34', '维持当前年龄定位'], 'p04 chips=冲突澄清三项');
    assert.equal(r.askedSlot, 'audience', 'p04 追问槽=audience');
    assert.equal(a.memory.ask_count.audience, 2, 'p04 冲突澄清占用 audience ask_count');
    assert.equal(a.memory.conflicts.length, 1, 'p04 冲突候选挂起');
    assert.equal(a.memory.conflicts[0].asked, true, 'p04 冲突已追问标记');
  },
  p05(a, r) {
    const acc = require('./assert');
    acc.assertSlots(a, { reason: { contains: ['加购未付'], source: 'explicit' } }, 'p05');
    assert.equal(acc.slotText(a.needs.audience), '年轻人', 'p05 C6：冲突候选值接受为 audience');
    assert.equal(a.needs.audience.source, 'inferred', 'p05 C6 兜底 source=inferred');
    assert.equal(a.memory.conflicts.length, 0, 'p05 冲突已消解');
    assert.ok(/我理解为|不对请纠正/.test(r.reply), 'p05 inferred 槽回复必须带「不对请纠正」表述');
  },
  p06(a) {
    const acc = require('./assert');
    acc.assertSlots(a, { offer: { equals: '10% off', source: 'explicit' } }, 'p06');
  },
  p07(a, r) {
    const acc = require('./assert');
    acc.assertExtras(a, { '发送时段': '晚上8点' }, 'p07');
    assert.equal(acc.slotText(a.needs.offer), '10% off', 'p07 offer 不动');
    assert.equal(acc.slotText(a.needs.goal), '', 'p07 goal 仍空');
    assert.equal(r.askedSlot, 'goal', 'p07 仍问缺失项 goal');
    assert.deepEqual(r.chips, ['挽回订单', '具体金额', '跑通流程', '我自己定'], 'p07 chips=goal 快捷项');
  },
  p08(a) {
    const acc = require('./assert');
    acc.assertExtras(a, { '产品特色': '天然大豆蜡、48小时长烧' }, 'p08');
    assert.equal(acc.slotText(a.needs.goal), '', 'p08 goal 仍空');
  },
  p09(a, r) {
    const acc = require('./assert');
    acc.assertSlots(a, { goal: { contains: ['100'], source: 'explicit' } }, 'p09');
    assert.equal(a.filled_count, 4, 'p09 filled_count=4');
    assert.equal(a.stage, 'S2', 'p09 stage=S2');
    assert.deepEqual(r.chips, [], 'p09 无追问 → chips=[]');
    assert.ok(r.planCard, 'p09 四要素齐产出方案卡');
    assert.deepEqual(r.planCard.inferred_slots, ['audience'], 'p09 planCard.inferred_slots 标记 C6 兜底槽');
  },
  p10(a, r) {
    const acc = require('./assert');
    assert.equal(acc.slotText(a.needs.offer), '10% off', 'p10 offer 不被「发送频率」错切');
    acc.assertExtras(a, { '发送频率': '每周不超过2封' }, 'p10');
    assert.equal(a.stage, 'S2', 'p10 stage 保持 S2');
    assert.deepEqual(r.chips, [], 'p10 无追问 chips=[]');
  },
  p11(a, r, ctx) {
    assert.equal(a.filled_count, 4, 'p11 filled_count 保持 4');
    assert.equal(a.stage, 'S2', 'p11 stage 保持 S2');
    assert.equal(a.memory.corrections.length, ctx.corrBefore, 'p11 同值忽略不记 corrections');
    assert.deepEqual(r.chips, [], 'p11 无追问 chips=[]');
  },
  p12(a, r) {
    // #12（Wave 5）：对话内语种越权 —— 拒绝 + 解释语种跟随收件人 + 槽位不动
    assert.ok(/语种/.test(r.reply) && /收件人/.test(r.reply), 'p12 拒绝并解释「语种跟收件人走」');
    assert.ok(/没动|不动/.test(r.reply), 'p12 明示槽位不动');
    assert.equal(a.stage, 'S2', 'p12 stage 保持 S2');
    assert.equal(require('./assert').slotText(a.needs.offer), '10% off', 'p12 offer 不动');
    assert.equal(require('./assert').slotText(a.needs.audience), '年轻人', 'p12 audience 不动');
    assert.deepEqual(r.chips, [], 'p12 无追问 chips');
  },
  p13(a, r) {
    // #13（Wave 2）：S2 查看方案卡 —— 在线轮出「无码预览卡」（E2 红线：卡面无未真实存在的码）
    const acc = require('./assert');
    assert.equal(a.stage, 'S2', 'p13 stage 保持 S2（真实出卡在 /confirm 建码之后）');
    assert.equal(a.filled_count, 4, 'p13 filled_count 保持 4');
    assert.ok(r.planCard, 'p13 在线轮产出方案卡预览');
    assert.equal(r.planCard.discount && r.planCard.discount.code || null, null, 'p13 预览卡不含折扣码');
    assert.equal(r.planCard.coupon || '', '', 'p13 预览卡 coupon 为空（无假码）');
    assert.ok(!/COMEBACK-/i.test(JSON.stringify(r.planCard)), 'p13 卡面不得出现本地拼的假码');
    assert.deepEqual(r.chips, [], 'p13 无追问 chips=[]');
  },
  p14(a, r) {
    // #14（Wave 5）：S2 后闲聊 —— 礼貌拉回 + 状态复述；无槽位写入（0 编造：needs 快照不动）
    const acc = require('./assert');
    assert.ok(/不聊|拉回|确认卡|四样|配置|调/.test(r.reply), 'p14 礼貌拉回 + 状态复述');
    assert.equal(acc.slotText(a.needs.offer), '10% off', 'p14 闲聊不写槽位（offer 不动）');
    // B2 冲突规则（真模型联调后对齐）：#13 原话「忘了付款/回来完成付款」会命中 kw 罐头短语，
    // 但 S2 冻结 + 无修正语气 → 不覆盖（候选丢弃），goal 保持用户已确认的具体值
    assert.ok(acc.slotText(a.needs.goal).includes('100'), 'p14 goal 保持用户确认值（kw 罐头不静默覆盖）');
    assert.ok(acc.slotText(a.needs.reason), 'p14 reason 非空（本轮不写入，保持采集态）');
    assert.equal(a.stage, 'S2', 'p14 stage 保持 S2');
    assert.deepEqual(r.chips, [], 'p14 无追问 chips');
    assert.equal(a.memory.extras.length, 7, 'p14 闲聊不新增 extras（0 编造）');
  },
  p15(a, r) {
    // #15 同轮双 correction：audience→老客、offer→15%；corrections +2；回复复述两个新值
    const acc = require('./assert');
    const corr = a.memory.corrections.slice(-2);
    assert.deepEqual(corr.map(c => c.slot).sort(), ['audience', 'offer'], 'p15 corrections 追加两条（audience/offer）');
    assert.deepEqual(corr.map(c => c.new).sort(), ['15% off', '老客'].sort(), 'p15 correction 新值正确');
    acc.assertSlots(a, { audience: { contains: ['老客'], source: 'explicit' }, offer: { contains: ['15%'], source: 'explicit' } }, 'p15');
    acc.assertReplyIncludes(r, ['老客', '15%'], 'p15 回复复述两个新值');
    assert.equal(a.filled_count, 4, 'p15 filled_count 保持 4');
    assert.deepEqual(r.chips, [], 'p15 无追问 chips=[]');
  },
  p16(a, r) {
    // #16 S2 后任意输入：引导确认；不问四槽；chips=[]
    assert.ok(/确认|核对/.test(r.reply), 'p16 回复为引导确认（含 确认/核对）');
    assert.deepEqual(r.chips, [], 'p16 不产出新追问 chips');
    assert.equal(r.askedSlot, null, 'p16 不追问四槽');
    assert.equal(a.stage, 'S2', 'p16 stage 保持 S2');
    assert.equal(a.filled_count, 4, 'p16 filled_count 保持 4');
    assert.equal(a.code_status, 'none', 'p16 code_status 恒 none');
  },
  p17(a, r, ctx) {
    // #17（Wave 3 I1）：拆批逐批复述 —— 0 静默（计划轮绝不建批），待确认计划挂 act
    const ex = ctx.executor.calls;
    assert.deepEqual(ex.createBatches, [], 'p17 0 静默：计划轮 createBatches 未调用');
    assert.equal(ex.previewBatches.length, 1, 'p17 逐批复述需要净值预览');
    assert.equal(ex.previewBatches[0].length, 2);
    assert.ok(a.pending_ops && a.pending_ops.batches.length === 2, 'p17 待确认计划挂 act.pending_ops（不落 campaigns）');
    assert.ok(/批次 A 加购未付/.test(r.reply) && /批次 B 下单未付/.test(r.reply), 'p17 逐批复述（人话名+人数+钩子）');
    assert.ok(/对吗/.test(r.reply), 'p17 逐批复述确认句式');
    assert.ok(Array.isArray(r.batches) && r.batches.length === 2, 'p17 done 帧 batches（待确认批次卡）');
  },
  p18(a, r, ctx) {
    // #18（Wave 3 I2）：黑五日历挂上 + 紧急全停；恢复须明说；p17 计划仍未被静默执行
    const ex = ctx.executor.calls;
    assert.deepEqual(ex.addBlackout, [{ from: '2026-11-27', to: '2026-11-28', label: '黑五' }], 'p18 黑五日历挂上');
    assert.equal(ex.pauseAll, 1, 'p18 紧急全停立即执行');
    assert.ok(/停发日历已挂上/.test(r.reply), 'p18 回复含日历口径（窗口内冻结不删）');
    assert.ok(/恢复必须你明说「恢复吧」/.test(r.reply), 'p18 紧急全停恢复须明说（绝不自动恢复）');
    assert.deepEqual(ex.createBatches, [], 'p18 待确认计划仍未被静默建批');
  },
  p19(a, r, ctx) {
    // #19（Wave 3 I3）：改折扣只改未发 —— 边界声明必含；新码只对未发、旧码对已发继续有效
    const op = ctx.executor.calls.campaignOps[0];
    assert.ok(op, 'p19 campaignOp 已执行');
    assert.equal(op.op, 'discount');
    assert.equal(op.params.percent_off, 15);
    assert.ok(/已发 18 封不受影响，改的是未发的 5 封/.test(r.reply), 'p19 边界声明（I3 灵魂句）');
    assert.ok(/折扣改为 15%/.test(r.reply) && /新码 NEW15/.test(r.reply), 'p19 新码只对未发生效');
    assert.ok(/旧码 OLD10/.test(r.reply), 'p19 旧码对已发邮件继续有效');
  },
  p20(a, r, ctx) {
    // #20（Wave 3 I4）：建批圈人默认排除 —— 核对单净值 = 圈定 − 排除，明细逐条
    const ex = ctx.executor.calls;
    assert.equal(ex.previewBatches.length, 2, 'p20 第二次批次计划预览');
    assert.ok(/已购买（店铺已下单） 2 人/.test(r.reply), 'p20 排除明细：已购买（已下单）');
    assert.ok(/已触达 1 人/.test(r.reply), 'p20 排除明细：已触达');
    assert.ok(a.pending_ops && a.pending_ops.batches.length === 1, 'p20 新计划覆盖待确认（仍不落库）');
    assert.ok(/对吗/.test(r.reply), 'p20 计划轮仍以待确认收口');
  },
  p21(a, r, ctx) {
    // #21（Wave 5 I5）：批次状态汇报 —— 每批一行（状态中文/已发 X/Y/回流净赚），低打开率行尾建议 + chips
    assert.ok(/A 加购未付：发送中，已发 18\/23，回流 2 单净赚 \$108，建议换主题行再打一轮/.test(r.reply), 'p21 批次行 + 低打开率建议');
    assert.ok(/B 下单未付：发送中，已发 17\/17，回流 3 单净赚 \$189/.test(r.reply), 'p21 第二行口径一致');
    assert.deepEqual(r.chips, ['换主题行再打', '先不动'], 'p21 异常建议 chips');
    assert.equal(a.pending_ops && a.pending_ops.resend_target, 'cmp_a', 'p21 建议目标挂 resend_target');
    assert.equal(a.stage, 'S2', 'p21 汇报是查询轮，stage 不动');
    assert.ok(!ctx.executor.calls.audits.length, 'p21 查询轮无审计写入');
  }
};

/**
 * 全 21 句重放（同一 act；永不去 throw —— 逐句失败进 failures）。
 * @returns {{results:[{id,input,pass,failures,reply,chips,stage,expect}], passed, failed, act, executor, persistCalls}}
 */
async function runAll() {
  const acc = require('./assert');
  const cases = loadCases(CASES_FILE);
  const byId = Object.fromEntries(cases.map(c => [c.id, c]));
  const executor = makeWave5Executor();
  const events = [];
  const igde = acc.makeScriptedEngine(IN_SCOPE_ORDER.map(id => ENVELOPES[id]), events, { executors: executor });
  const act = makeAcceptanceAct('act_acceptance21');
  const op = igde.opening();
  act.messages.push({ role: 'assistant', content: op.reply, ts: 0 });

  const invariant = { actId: act.id, lastFilled: act.filled_count };
  const persistCalls = [];
  const results = [];
  let corrBefore = 0;
  for (const id of IN_SCOPE_ORDER) {
    const turn = byId[id];
    if (!turn) {
      results.push({ id, input: '', pass: false, failures: ['jsonl 缺该句'], reply: null, chips: null, stage: null, expect: {} });
      continue;
    }
    if (id === 'p11') corrBefore = act.memory.corrections.length;
    const before = events.length;
    const failures = [];
    let reply = null;
    let chips = null;
    try {
      const r = await igde.handle(act, turn.input, {
        locale: 'en',
        onReplyToken: () => events.push({ t: 'token', at: Date.now() }),
        persist: makePersistRecorder(events, persistCalls)
      });
      reply = r.reply;
      chips = r.chips;
      assertPersistBeforeTokens(events.slice(before), `${id} B3 顺序`);
      assertTurnCommon(invariant, act, r, turn);
      if (PER_TURN[id]) PER_TURN[id](act, r, { corrBefore, executor });
    } catch (e) {
      failures.push(String((e && e.message) || e));
    }
    results.push({
      id, input: turn.input, pass: failures.length === 0, failures,
      reply, chips, stage: act.stage, expect: turn.expect || {}
    });
  }
  return {
    results,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    act, executor, persistCalls
  };
}

module.exports = {
  CASES_FILE,
  ENVELOPES,
  IN_SCOPE_ORDER,
  makeWave5Executor,
  runAll
};
