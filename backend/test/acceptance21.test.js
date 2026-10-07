'use strict';

/**
 * PRD v2 21 句验收 —— 全部 21 句 in-scope（Wave 5 起 #12/#14/#21 启用，deferred 清零）离线自动化。
 *
 * 用例本体在 eval/cases/prd-v2.jsonl（输入唯一来源）；重放 harness 在 lib/acceptance/replay.js
 * （单一权威，与 eval/replay21.js 归档脚本共用）：按序重放到**同一个 act**，逐句断言（断言点 = 任务 B-4 剧本）。
 * 模型注入缝复用现有假 callAI 模式，envelope 用 PRD v2 新契约 {reply, restatement, slot_updates, extras, corrections}，
 * 引擎侧 B1 依据校验 / B2 合并冲突 / B3 先落库后回复 / B4 选问与 chips / B5 组装全部真实执行。
 * 专项降级补测：#13（断开 LLM 重放 #1-#10）、#14（连发 3 条闲聊，Wave 5）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const acc = require('../lib/acceptance/assert');
const { IGDE } = require('../lib/igde');
const replay = require('../lib/acceptance/replay');
const { ENVELOPES, IN_SCOPE_ORDER } = replay;

const CASES_FILE = replay.CASES_FILE;

test('prd-v2.jsonl 结构：21 句齐全且全部 in-scope（Wave 5 起 deferred 清零）', () => {
  const cases = acc.loadCases(CASES_FILE);
  assert.equal(cases.length, 21, 'prd-v2.jsonl 应含 21 句');
  const deferred = cases.filter(c => c.deferred);
  assert.equal(deferred.length, 0, 'Wave 5 起 deferred 应清零（#12/#14/#21 已回填 input+断言）');
  assert.deepEqual(cases.map(c => c.id), IN_SCOPE_ORDER, '21 句序应与剧本一致');
  for (const c of cases) {
    assert.ok(c.input && c.input.length, `${c.id} 缺 input`);
    assert.ok(c.expect && c.expect.assert, `${c.id} 缺断言描述`);
  }
});

test('21 句 in-scope 重放到同一个 act：逐句断言全过', async () => {
  const rep = await replay.runAll();
  assert.equal(rep.results.length, 21, '21 轮全部执行');
  assert.equal(rep.persistCalls.length, 21, '每句恰好落库一次');
  const failed = rep.results.filter(r => !r.pass);
  assert.deepEqual(failed.map(r => r.id), [], `失败句：${failed.map(r => `${r.id}: ${r.failures.join('；')}`).join(' | ')}`);

  // —— 终态汇总：extras 7 条、四槽全 explicit、id 不变 ——
  const { act } = rep;
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
  assert.ok(acc.slotText(act.needs.audience), 'audience 已采集（p02 人群画像原话采集，p13 二次采集走冲突保护不覆盖）');
  assert.ok(acc.slotText(act.needs.reason), 'reason 已采集');
  assert.equal(acc.slotText(act.needs.offer), '10% off', 'offer 已采集（数值+单位）');
});

test('剧本 #14 降级补测（Wave 5）：S2 四样齐后连发 3 条闲聊 —— 0 崩溃 0 编造、礼貌拉回 + 状态复述、无槽位写入', async () => {
  const cases = acc.loadCases(CASES_FILE);
  const byId = Object.fromEntries(cases.map(c => [c.id, c]));
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = acc.makeAcceptanceAct('act_p14_chitchat');
  // 预置 S2 四样齐（与主重放 #9 后状态同构）
  const now = Date.now();
  act.stage = 'S2';
  act.needs.audience = { value: '年轻人', source: 'inferred', at: now };
  act.needs.reason = { value: '加购未付款', source: 'explicit', at: now };
  act.needs.offer = { value: '10% off', source: 'explicit', at: now };
  act.needs.goal = { value: '本月挽回 100 单', source: 'explicit', at: now };
  act.filled_count = 4;
  act.messages.push({ role: 'assistant', content: igde.opening().reply, ts: 0 });
  const needsSnapshot = JSON.stringify(act.needs);

  const chitchat = [byId.p14.input, '晚上吃火锅去不去', '你们这软件是谁开发的呀'];
  const extrasBefore = act.memory.extras.length;
  for (const line of chitchat) {
    const r = await igde.handle(act, line, { locale: 'en' });
    assert.ok(r && r.reply && r.reply.trim().length > 2, `「${line}」0 崩溃、回复非空`);
    assert.equal(r.engine, 'degraded', '降级路径照常应答');
    assert.ok(/先不聊|不聊啦|咱不急|回到正题|确认|核对|四样|帮不上|捞回来|挽回/.test(r.reply), `「${line}」礼貌拉回 + 状态复述`);
    assert.ok(!/\d+单|净赚/.test(r.reply), '0 编造：闲聊轮不产业务数字');
    assert.equal(r.askedSlot, null, '闲聊轮不追问四槽');
  }
  assert.equal(JSON.stringify(act.needs), needsSnapshot, '三连闲聊后四槽快照原样（无槽位写入）');
  assert.equal(act.stage, 'S2', 'stage 保持 S2');
  assert.equal(act.filled_count, 4, 'filled_count 保持 4');
  assert.equal(act.memory.extras.length, extrasBefore, 'extras 不新增（0 编造）');
});

/* ---------------- Wave 4（F1 零配置开场 / A3 商家记忆）追加用例 ---------------- */

test('Wave 4 #1 零配置开场：欢迎语只在首个 act 拼一次；清单 + 出口 chips（F1 · 剧本 #23）', () => {
  const { IGDE } = require('../lib/igde');
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  // 场景一：商家名下无任何 act（含 closed）→ 首条 agent 气泡开头拼接欢迎语
  const first = igde.opening({ hasAnyAct: false, storeBanner: { connected: false } });
  assert.ok(first.reply.startsWith('欢迎使用百客，我是你的专属智能邮件营销助手。'), '#1 欢迎语开头一次性拼接');
  assert.equal(first.welcome, true, 'welcome 标识（前端 eligible=false 时不显示）');
  assert.ok(first.reply.includes('我还需要的信息'), '首条气泡含「我还需要的信息」清单（无进度数字）');
  assert.ok(!/\d\s*\/\s*4/.test(first.reply), '清单无进度数字（F4）');
  assert.deepEqual(first.chips, ['好，帮我写一封', '介绍一下其他功能', '其他需求'], '出口 chips 3 项（剧本 #23）');
  // 场景二：老用户恢复会话 / 新会话（名下已有 act）→ 不再出现欢迎语
  const second = igde.opening({ hasAnyAct: true, storeBanner: { connected: false } });
  assert.ok(!second.reply.includes('欢迎使用百客'), '第二个 act 起不再拼欢迎语');
  // 场景三：已连接店铺 → 店铺真实数据先于清单 + 出口 chips
  const data = igde.opening({
    hasAnyAct: false,
    storeBanner: { connected: true, store_name: 'LunaGlow', weekly_abandoned_count: 214, aov: 45, abandoned_value: 9630, currency: 'USD' }
  });
  const iW = data.reply.indexOf('欢迎使用百客');
  const iD = data.reply.indexOf('我了解到你的品牌名是LunaGlow');
  const iL = data.reply.indexOf('我还需要的信息');
  assert.ok(iW < iD && iD < iL, '数据先于清单（数据先于提问）');
  assert.ok(data.reply.includes('本周214个加购未付'), '数据开场句');
  assert.ok(data.chips.length <= 3, 'chips ≤3（出口 3 项）');
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
