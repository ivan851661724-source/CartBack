'use strict';

/**
 * PRD v2 21 句验收 —— in-scope 18 句（#1-#11、#13、#15-#16；Wave 3 启用 #17-#20）离线自动化。
 *
 * 用例本体在 eval/cases/prd-v2.jsonl（输入唯一来源：14 句 in-scope + 7 句 deferred）；
 * 本测试按序重放到**同一个 act**，逐句断言（断言点 = 任务 B-4 剧本）。
 * 模型注入缝复用现有假 callAI 模式（eval/runner.js / igde-context / streaming 同款），
 * envelope 用 PRD v2 新契约 {reply, restatement, slot_updates, extras, corrections}，
 * 引擎侧 B1 依据校验 / B2 合并冲突 / B3 先落库后回复 / B4 选问与 chips / B5 组装全部真实执行。
 * #13（Wave 2 启用）为降级补测：在线重放该句 + 文件底部「断开 LLM 重放 #1-#10」专门用例。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const acc = require('../lib/acceptance/assert');
const { IGDE } = require('../lib/igde');

const CASES_FILE = path.join(__dirname, '..', 'eval', 'cases', 'prd-v2.jsonl');

// —— 13 句 in-scope 的脚本化 envelope（按对话自然顺序 p01→p11→p15→p16；与 jsonl input 一一对应）——
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
  // #13（Wave 2 启用，降级补测）：方案卡/邮件预览类 —— 降级语义见文件底部专门用例（断开 LLM 重放 #1-#10）
  // 注意：reply 避开 L4 抢跑词表（「方案卡/主题行/正文…」原词会触发重生成、打乱剧本）
  p13: {
    reply: '配置都在下面确认标签里了，四样都齐。点「确认」我就去你店铺建码、出正式卡片。',
    restatement: ['收到：查看配置'],
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
  }
};
const IN_SCOPE_ORDER = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11', 'p13', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20'];

/**
 * Wave 3 批次域执行器桩（I1/I2/I3/I4）：与 server.makeCampaignExecutor 同一结构化结果契约，
 * 引擎侧人话组装（逐批复述 / 边界声明 / 排除明细）是真实执行的被测对象。
 */
function makeWave3Executor() {
  const calls = { previewBatches: [], createBatches: [], campaignOps: [], pauseAll: 0, resumeAll: 0, addBlackout: [] };
  const reachOf = (desc) => (String(desc).includes('加购') ? 23 : 17);
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
    async addBlackout(params) { calls.addBlackout.push(params); return { ok: true, range: { from: params.from, to: params.to, label: params.label } }; }
  };
}

test('prd-v2.jsonl 结构：21 句齐全，18 句 in-scope / 3 句 deferred', () => {
  const cases = acc.loadCases(CASES_FILE);
  assert.equal(cases.length, 21, 'prd-v2.jsonl 应含 21 句');
  const inScope = cases.filter(c => !c.deferred);
  const deferred = cases.filter(c => c.deferred);
  assert.equal(inScope.length, 18, 'in-scope 应为 18 句（Wave 2 启用 #13、Wave 3 启用 #17-#20）');
  assert.equal(deferred.length, 3, 'deferred 应为 3 句');
  assert.deepEqual(deferred.map(c => c.id).sort(), ['p12', 'p14', 'p21'], 'deferred 句仍为 #12/#14/#21');
  for (const c of deferred) assert.deepEqual(c.expect, {}, 'deferred 句断言必须为空对象');
  assert.deepEqual(inScope.map(c => c.id), IN_SCOPE_ORDER, 'in-scope 句序应与剧本一致');
  for (const c of inScope) {
    assert.ok(c.input && c.input.length, `${c.id} 缺 input`);
    assert.ok(c.expect && c.expect.assert, `${c.id} 缺断言描述`);
  }
});

test('18 句 in-scope 重放到同一个 act：逐句断言全过', async () => {
  const cases = acc.loadCases(CASES_FILE);
  const byId = Object.fromEntries(cases.map(c => [c.id, c]));

  // Wave 3 批次域执行器（I1/I2/I3/I4 结构化结果桩）：人话组装在引擎侧，测试断言调用与确定性回复
  const executor = makeWave3Executor();

  const events = [];
  const igde = acc.makeScriptedEngine(IN_SCOPE_ORDER.map(id => ENVELOPES[id]), events, { executors: executor });
  const act = acc.makeAcceptanceAct('act_acceptance21');
  const op = igde.opening();
  act.messages.push({ role: 'assistant', content: op.reply, ts: 0 });

  const invariant = { actId: act.id, lastFilled: act.filled_count };
  const persistCalls = [];
  const results = {};

  // 逐句断言（在循环内打点：act 是单例，跨轮状态会演变，p01 的断言必须看 p01 时刻的状态）
  const perTurn = {
    p01(a, r) {
      // #1 品牌名/品类/客单价进 extras；audience 仍空；下一问问 audience
      acc.assertSlots(a, { audience: null }, 'p01');
      acc.assertExtras(a, { brand: 'LunaGlow', '品类': '手工香薰蜡烛', '客单价': '28美元' }, 'p01');
      assert.deepEqual(r.chips, ['加购未付', '浏览未买', '老客'], 'p01 chips=audience 快捷项');
      assert.equal(r.askedSlot, 'audience', 'p01 追问槽=audience');
      assert.equal(a.memory.ask_count.audience, 1, 'p01 追问 audience 记账');
    },
    p02(a, r) {
      // #2 audience 采集；兴趣进 extras；下一问问 reason
      acc.assertSlots(a, { audience: { contains: ['25', '40', '美国女性'], source: 'explicit' } }, 'p02');
      acc.assertExtras(a, { '兴趣': '居家氛围、天然成分' }, 'p02');
      assert.deepEqual(r.chips, ['忘记结账', '在对比价格', '我来说原因'], 'p02 chips=reason 快捷项');
      assert.equal(a.memory.ask_count.reason, 1, 'p02 追问 reason 记账');
    },
    p03(a, r) {
      // #3 客单价 correction：extras 更新 + corrections 记账；回复含 35
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
      // #4 冲突检测：audience 不被覆盖；本轮问冲突澄清；chips 固定三项
      assert.equal(acc.slotText(a.needs.audience), '25-40岁美国女性', 'p04 audience 不被「年轻人」覆盖');
      assert.equal(a.needs.audience.source, 'explicit', 'p04 audience 保持 explicit');
      assert.deepEqual(r.chips, ['18-24', '25-34', '维持当前年龄定位'], 'p04 chips=冲突澄清三项');
      assert.equal(r.askedSlot, 'audience', 'p04 追问槽=audience');
      assert.equal(a.memory.ask_count.audience, 2, 'p04 冲突澄清占用 audience ask_count');
      assert.equal(a.memory.conflicts.length, 1, 'p04 冲突候选挂起');
      assert.equal(a.memory.conflicts[0].asked, true, 'p04 冲突已追问标记');
    },
    p05(a, r) {
      // #5 reason 回归样本（原 pain 槽漏接）：加购未付 必须接住；C6 兜底 audience inferred
      acc.assertSlots(a, { reason: { contains: ['加购未付'], source: 'explicit' } }, 'p05');
      assert.equal(acc.slotText(a.needs.audience), '年轻人', 'p05 C6：冲突候选值接受为 audience');
      assert.equal(a.needs.audience.source, 'inferred', 'p05 C6 兜底 source=inferred');
      assert.equal(a.memory.conflicts.length, 0, 'p05 冲突已消解');
      assert.ok(/我理解为|不对请纠正/.test(r.reply), 'p05 inferred 槽回复必须带「不对请纠正」表述');
    },
    p06(a) {
      // #6 offer 数值+单位
      acc.assertSlots(a, { offer: { equals: '10% off', source: 'explicit' } }, 'p06');
    },
    p07(a, r) {
      // #7 发送时段进 extras；offer/goal 不动；仍问缺失项
      acc.assertExtras(a, { '发送时段': '晚上8点' }, 'p07');
      assert.equal(acc.slotText(a.needs.offer), '10% off', 'p07 offer 不动');
      assert.equal(acc.slotText(a.needs.goal), '', 'p07 goal 仍空');
      assert.equal(r.askedSlot, 'goal', 'p07 仍问缺失项 goal');
      assert.deepEqual(r.chips, ['挽回订单', '具体金额', '跑通流程', '我自己定'], 'p07 chips=goal 快捷项');
    },
    p08(a) {
      // #8 产品特色进 extras；仍问缺失项
      acc.assertExtras(a, { '产品特色': '天然大豆蜡、48小时长烧' }, 'p08');
      assert.equal(acc.slotText(a.needs.goal), '', 'p08 goal 仍空');
    },
    p09(a, r) {
      // #9 goal 采集：filled_count=4；stage=S2；方案卡产出；无追问 chips
      acc.assertSlots(a, { goal: { contains: ['100'], source: 'explicit' } }, 'p09');
      assert.equal(a.filled_count, 4, 'p09 filled_count=4');
      assert.equal(a.stage, 'S2', 'p09 stage=S2');
      assert.deepEqual(r.chips, [], 'p09 无追问 → chips=[]');
      assert.ok(r.planCard, 'p09 四要素齐产出方案卡');
      assert.deepEqual(r.planCard.inferred_slots, ['audience'], 'p09 planCard.inferred_slots 标记 C6 兜底槽');
    },
    p10(a, r) {
      // #10 发送频率错切回归：offer 不动；extras 增加；stage 保持 S2
      assert.equal(acc.slotText(a.needs.offer), '10% off', 'p10 offer 不被「发送频率」错切');
      acc.assertExtras(a, { '发送频率': '每周不超过2封' }, 'p10');
      assert.equal(a.stage, 'S2', 'p10 stage 保持 S2');
      assert.deepEqual(r.chips, [], 'p10 无追问 chips=[]');
    },
    p11(a, r, ctx) {
      // #11 goal 同值忽略：不清零、act.id 不变、stage 保持 S2、corrections 不新增
      assert.equal(a.filled_count, 4, 'p11 filled_count 保持 4');
      assert.equal(a.stage, 'S2', 'p11 stage 保持 S2');
      assert.equal(a.memory.corrections.length, ctx.corrBefore, 'p11 同值忽略不记 corrections');
      assert.deepEqual(r.chips, [], 'p11 无追问 chips=[]');
    },
    p13(a, r) {
      // #13（Wave 2）：S2 查看方案卡 —— 在线轮出「无码预览卡」（E2 红线：卡面无未真实存在的码）；stage 停留 S2
      assert.equal(a.stage, 'S2', 'p13 stage 保持 S2（真实出卡在 /confirm 建码之后）');
      assert.equal(a.filled_count, 4, 'p13 filled_count 保持 4');
      assert.ok(r.planCard, 'p13 在线轮产出方案卡预览');
      assert.equal(r.planCard.discount && r.planCard.discount.code || null, null, 'p13 预览卡不含折扣码');
      assert.equal(r.planCard.coupon || '', '', 'p13 预览卡 coupon 为空（无假码）');
      assert.ok(!/COMEBACK-/i.test(JSON.stringify(r.planCard)), 'p13 卡面不得出现本地拼的假码');
      assert.deepEqual(r.chips, [], 'p13 无追问 chips=[]');
    },
    p15(a, r) {
      // #15 同轮双 correction：audience→老客、offer→15%；corrections +2；回复复述两个新值
      // （old 以库内现值重算——#13 重放后库内现值随原话采集演进，只断言 slot 与新值）
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
    }
  };

  let corrBefore = 0;
  for (const id of IN_SCOPE_ORDER) {
    const turn = byId[id];
    if (id === 'p11') corrBefore = act.memory.corrections.length;
    const before = events.length;
    const r = await igde.handle(act, turn.input, {
      locale: 'en',
      onReplyToken: () => events.push({ t: 'token', at: Date.now() }),
      persist: acc.makePersistRecorder(events, persistCalls)
    });
    results[id] = r;
    acc.assertPersistBeforeTokens(events.slice(before), `${id} B3 顺序`);
    acc.assertTurnCommon(invariant, act, r, turn);
    perTurn[id](act, r, { corrBefore, executor });
  }

  assert.equal(persistCalls.length, 18, '每句恰好落库一次');
  assert.equal(Object.keys(ENVELOPES).length, 18);
  assert.ok(results.p01, '18 轮全部执行');

  // —— 终态汇总：extras 7 条、四槽全 explicit、id 不变 ——
  assert.equal(act.memory.extras.length, 7, '终态 extras 应为 7 条');
  for (const s of ['audience', 'reason', 'offer', 'goal']) {
    assert.equal(act.needs[s].source, 'explicit', `终态 needs.${s} 应为 explicit`);
  }
  assert.equal(act.id, 'act_acceptance21', '全程同一个 act');
  assert.deepEqual(
    acc.extrasMap(act.memory),
    {
      brand: 'LunaGlow', '品类': '手工香薰蜡烛', '客单价': '35美元', '兴趣': '居家氛围、天然成分',
      '发送时段': '晚上8点', '产品特色': '天然大豆蜡、48小时长烧', '发送频率': '每周不超过2封'
    },
    '终态 extras 快照'
  );
});

test('B3 落库失败：不发回复、token 不外流、错误话术可直达用户', async () => {
  const igde = acc.makeScriptedEngine([ENVELOPES.p01]);
  const act = acc.makeAcceptanceAct('act_persist_fail');
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: 0 });
  const tokens = [];
  let persistCalls = 0;
  await assert.rejects(
    () => igde.handle(act, '我的品牌叫 LunaGlow，做手工香薰蜡烛，客单价 28 美元', {
      onReplyToken: (p) => tokens.push(p),
      persist: () => { persistCalls++; throw new Error('disk full'); }
    }),
    (e) => {
      assert.equal(e.message, '刚才那句我没存上，再说一次', '落库失败错误话术');
      assert.equal(e.code, 'PERSIST_FAIL', '错误码 PERSIST_FAIL');
      return true;
    },
    '落库失败应拒绝本轮回复'
  );
  assert.equal(persistCalls, 1, '落库尝试过一次');
  assert.equal(tokens.length, 0, 'B3：落库失败则 token 一帧都不外流');
});

test('B1 critic：无原文依据的 slot_update 被丢弃（丢弃优先）', async () => {
  const seen = [];
  const igde = new IGDE({
    aiEnabled: true,
    criticMode: 'off',
    callAI: async () => {
      seen.push(1);
      return {
        reply: '收到，客群就按欧美白领理解了，我按这个来，不对请纠正。',
        restatement: ['收到：欧美白领（原文无依据）'],
        slot_updates: [{ slot: 'audience', value: '欧美高净值白领', confidence: 0.98, inferred: false }],
        extras: [],
        corrections: []
      };
    }
  });
  const act = acc.makeAcceptanceAct('act_critic');
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: 0 });
  // 输入不含任何槽位关键词（避免词表兜底补缺干扰 critic 丢弃语义的验证）
  const r = await igde.handle(act, '这个先不着急，你看着办', {});
  assert.equal(acc.slotText(act.needs.audience), '', '无原文依据的 slot_update 必须丢弃');
  assert.equal(r.engine, 'online');
  assert.equal(seen.length, 1);
});

test('B1 critic：confidence < 0.6 → inferred:true，且回复带「不对请纠正」', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    criticMode: 'off',
    callAI: async () => ({
      reply: '大概是在比价吧，我理解为「比价」，不对请纠正。你最想挽回哪拨人？',
      restatement: ['收到：比价（低置信）'],
      slot_updates: [{ slot: 'reason', value: '比价', confidence: 0.4, inferred: false }],
      extras: [],
      corrections: []
    })
  });
  const act = acc.makeAcceptanceAct('act_lowconf');
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: 0 });
  // 输入有依据（比价 在原话中）但不触发词表 reason 模式 → 走 confidence<0.6 的 inferred 通道
  await igde.handle(act, '可能是在比价吧', {});
  assert.ok(act.needs.reason, '低置信更新应接受');
  assert.equal(act.needs.reason.source, 'inferred', 'confidence<0.6 → inferred');
  assert.equal(acc.slotText(act.needs.reason), '比价');
});

test('B2 冲突澄清的 C6 兜底：追问轮后用户岔开话题 → 候选值 inferred 入槽', async () => {
  const envelopes = [
    { // 第一轮：填 audience
      reply: '收到，加购未付的。他们为啥快丢？',
      slot_updates: [{ slot: 'audience', value: '加购未付客户', confidence: 0.95, inferred: false }],
      extras: [], corrections: []
    },
    { // 第二轮：冲突值，无修正语气 → 冲突候选 + 澄清追问
      reply: '你刚说年轻白领为主，和前面记的加购未付对不上——以哪个为准？',
      slot_updates: [{ slot: 'audience', value: '年轻白领', confidence: 0.9, inferred: false }],
      extras: [], corrections: []
    },
    { // 第三轮：岔开话题（无 audience 信息）→ C6 接受候选值 inferred
      reply: '行，那咱先聊钩子。想给点什么？',
      slot_updates: [], extras: [], corrections: []
    }
  ];
  const igde = acc.makeScriptedEngine(envelopes);
  const act = acc.makeAcceptanceAct('act_c6');
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: 0 });

  await igde.handle(act, '加购未付的客户', {});
  await igde.handle(act, '主要是年轻白领吧', {});
  assert.equal(acc.slotText(act.needs.audience), '加购未付客户', '冲突轮不覆盖');
  assert.equal(act.memory.conflicts.length, 1, '冲突候选已挂起');

  const r3 = await igde.handle(act, '算了先不聊这个，今天天气不错', {});
  assert.equal(acc.slotText(act.needs.audience), '年轻白领', 'C6：候选值接受入槽');
  assert.equal(act.needs.audience.source, 'inferred', 'C6 兜底 source=inferred');
  assert.ok(/我理解为|不对请纠正/.test(r3.reply), 'C6 接受后回复带纠正话术');
});

test('剧本 #13 降级补测：断开 LLM 重放 #1-#10 输入 —— 状态机不瘫、降级不出 planCard', async () => {
  const cases = acc.loadCases(CASES_FILE);
  const byId = Object.fromEntries(cases.map(c => [c.id, c]));
  // 断开 LLM：纯桩引擎（aiEnabled=false），与线上 AI 失联降级同路径（G2）
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = acc.makeAcceptanceAct('act_p13_degraded');
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: 0 });

  const replayIds = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p13'];
  const countFilled = require('../lib/needs').countFilled; // 降级轮无 persist：filled_count 以 needs 现算为准
  let sawProbe = false;       // 逐项确认+下一问（缺失槽轮必有追问与 chips）
  let lastResult = null;
  for (const id of replayIds) {
    const input = byId[id].input;
    assert.ok(input, `${id} input 已回填`);
    const t0 = Date.now();
    const r = await igde.handle(act, input, { locale: 'en' });
    const dt = Date.now() - t0;
    // 降级轮硬口径
    assert.equal(r.engine, 'degraded', `${id} engine=degraded`);
    assert.equal(r.planCard, null, `${id} 降级轮不出 planCard（真实出卡在 /confirm 建码之后）`);
    assert.ok(dt < 1000, `${id} 每轮延迟 <1s（实际 ${dt}ms）`);
    // 状态机仍在推进：缺失槽轮必有单点追问 + 对应 chips；齐了之后 chips=[] 且引导确认
    if (countFilled(act.needs) < 4) {
      if (r.askedSlot) {
        sawProbe = true;
        assert.deepEqual(r.chips, acc.chipsFor(r.askedSlot), `${id} chips=被问槽快捷项（逐项确认+下一问）`);
      }
    } else {
      assert.deepEqual(r.chips, [], `${id} 4/4 后无追问 chips`);
      assert.ok(!r.askedSlot, `${id} 4/4 后不再追问`);
    }
    lastResult = r;
  }
  assert.ok(sawProbe, '重放 #1-#10 过程中状态机持续逐项追问（未瘫）');
  // 4/4 时 stage=S2 且不出 planCard（降级口径；降级轮无 persist，四要素以 needs 现算为准）
  assert.equal(countFilled(act.needs), 4, '重放结束四要素齐');
  assert.equal(act.stage, 'S2', '4/4 时 stage=S2');
  assert.equal(lastResult.planCard, null, '4/4 时不出 planCard');
  assert.ok(/确认|核对|方案/.test(lastResult.reply || ''), '降级收口仍引导确认（不空转）');
  // 四槽语义抽查：降级词表抽取在重放过程中接住了四槽（原话为准，值随输入演进）
  assert.ok(acc.slotText(act.needs.audience).includes('加购'), 'audience 已采集');
  assert.ok(acc.slotText(act.needs.reason), 'reason 已采集');
  assert.equal(acc.slotText(act.needs.offer), '10% off', 'offer 已采集（数值+单位）');
});

/* ---------------- Wave 4（F1 零配置开场 / A3 商家记忆）追加用例 ---------------- */

test('Wave 4 #1 零配置开场：欢迎语只在首个 act 拼一次；数据开场句先于提问（F1）', () => {
  const { IGDE } = require('../lib/igde');
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  // 场景一：商家名下无任何 act（含 closed）→ 首条 agent 气泡开头拼接欢迎语
  const first = igde.opening({ hasAnyAct: false, storeBanner: { connected: false } });
  assert.ok(first.reply.startsWith('欢迎使用百客，我是你的专属智能邮件营销助手。'), '#1 欢迎语开头一次性拼接');
  assert.equal(first.welcome, true, 'welcome 标识（前端 eligible=false 时不显示）');
  assert.deepEqual(first.chips, ['加购未付', '浏览未买', '我自己说'], '开场 chips ≤3 且含自由输入出口');
  // 场景二：老用户恢复会话 / 新会话（名下已有 act）→ 不再出现欢迎语
  const second = igde.opening({ hasAnyAct: true, storeBanner: { connected: false } });
  assert.ok(!second.reply.includes('欢迎使用百客'), '第二个 act 起不再拼欢迎语');
  // 场景三：已连接店铺 → 店铺真实数据先于提问 + 数据式 chips
  const data = igde.opening({
    hasAnyAct: false,
    storeBanner: { connected: true, store_name: 'LunaGlow', weekly_abandoned_count: 214, aov: 45, abandoned_value: 9630, currency: 'USD' }
  });
  const iW = data.reply.indexOf('欢迎使用百客');
  const iD = data.reply.indexOf('已连接LunaGlow');
  const iQ = data.reply.indexOf('想先把这拨人捞回来吗');
  assert.ok(iW < iD && iD < iQ, '数据先于提问');
  assert.ok(data.reply.includes('本周214个加购未付'), '数据开场句');
  assert.ok(data.chips.length <= 3 && data.chips.includes('我自己说'), 'chips ≤3 且含「我自己说」');
});

test('Wave 4 A3 商家记忆：方案沉淀 prefs → 新 act「照上次的来」预填 inferred + 复述；否认清空', async () => {
  const { IGDE } = require('../lib/igde');
  const igde = acc.makeScriptedEngine([]);   // 复用意图为确定性短路轮，不消耗 envelope 脚本
  // ① 上一会话四要素齐（模拟 confirm 成功后的 prefs 沉淀 —— 服务端确认写入见 wave4 HTTP e2e）
  const prev = acc.makeAcceptanceAct('act_prev');
  prev.needs.audience = { value: '加购未付客户', source: 'explicit', at: 1 };
  prev.needs.reason = { value: '太久没动静', source: 'explicit', at: 1 };
  prev.needs.offer = { value: '15% off', source: 'explicit', at: 1 };
  prev.needs.goal = { value: '促成复购', source: 'explicit', at: 1 };
  const prefs = {
    audience: prev.needs.audience.value, reason: prev.needs.reason.value,
    offer_text: prev.needs.offer.value, goal: prev.needs.goal.value,
    discount_percent: '15', brand: 'LunaGlow', signature: 'LunaGlow',
    act_id: prev.id, confirmed_at: String(Date.now()), source: 'confirm'
  };
  // ② 新会话首条消息命中复用意图 → 预填 inferred + 逐项复述 + 「不对请纠正」
  const act = acc.makeAcceptanceAct('act_reuse');
  act.messages.push({ role: 'assistant', content: igde.opening({ hasAnyAct: true }).reply, ts: 0 });
  const r = await igde.handle(act, '照上次的来', { reusePrefs: prefs });
  assert.ok(r.reply.includes('我理解为') && r.reply.includes('不对请纠正'), '预填回复必带「我理解为…不对请纠正」语义');
  assert.ok(r.reply.includes('加购未付客户') && r.reply.includes('15% off') && r.reply.includes('促成复购'), '逐项复述 prefs');
  for (const s of ['audience', 'reason', 'offer', 'goal']) {
    assert.equal(act.needs[s].source, 'inferred', `预填槽 ${s} source=inferred`);
  }
  assert.equal(require('../lib/needs').countFilled(act.needs), 4, '四要素预填齐（filled_count 落库时重算，此处现算 needs）');
  assert.equal(r.stage, 'S2', '预填齐 → S2 等确认');
  assert.equal(act.memory.prefs.reuse_slots, 'audience,reason,offer,goal', '复用标记挂 prefs');
  // ③ 否认复用 → 清空预填回采集
  const r2 = await igde.handle(act, '别用上次的', {});
  assert.ok(/上次的先不用/.test(r2.reply), '否认被接住');
  assert.equal(act.needs.audience, null, '预填清空');
  assert.equal(r2.askedSlot, 'audience', '回 S1 正常采集');
});
