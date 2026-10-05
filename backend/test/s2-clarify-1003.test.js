'use strict';
/**
 * S2 冲突澄清裁决回归（PRD 更新摘要补录二 · 2026-10-03 · 复测报告 G-7 闭合）
 * 覆盖五条裁决：
 *   ① 同义重申不算冲突（归一化相等 / 完整包含 / 词表同义 → 同值处理，不进 conflictsNew）
 *   ② S2 全满态真冲突澄清优先于引导确认（澄清轮只问不推卡）
 *   ③ 澄清应答视同 correction 走 D2.3（解冻→更新→重渲染，停留 S2）；「维持」只关澄清
 *   ④ 拉锯保护：同槽澄清 ≤1 次（含 S2），第二次改口直接按 correction 处理
 *   ⑤ 剧本 #13/#16 回归：S2 确认期词表叙述提及不反问、复述不误伤（12 字守卫防数字包含误豁免）
 */
const test = require('node:test');
const assert = require('node:assert');
const { IGDE } = require('../lib/igde');
const acc = require('../lib/acceptance/assert');

const NOW = Date.now();

function mkAct(id, stage = 'S1') {
  const act = acc.makeAcceptanceAct(id);
  act.stage = stage;
  return act;
}

function fillAll(act) {
  act.needs.audience = { value: '25-40岁美国女性', source: 'explicit', at: NOW };
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: NOW };
  act.needs.offer = { value: '10% off', source: 'explicit', at: NOW };
  act.needs.goal = { value: '本月挽回100单', source: 'explicit', at: NOW };
  act.filled_count = 4;
}

test('① 同义重申豁免：S1 复述同一客群（措辞微差）→ 0 冲突、不追问、值不变', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a1');
  act.needs.audience = { value: '25-40岁美国女性', source: 'explicit', at: NOW };
  const r = await igde.handle(act, '嗯对，就是 25 到 40 岁的美国女性那批人，没问题', {});
  assert.equal(act.memory.conflicts.length, 0, '同义复述不产冲突候选（B2.3）');
  assert.equal(acc.slotText(act.needs.audience), '25-40岁美国女性', '值不被复述措辞顶掉');
  assert.notEqual(r.askedSlot, 'audience', '不为复述反问受众');
});

test('① 词表同义：「忘了付款」≈「忘记结账」→ 同值处理不追问', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a2');
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: NOW };
  const r = await igde.handle(act, '他们就是忘了付款嘛', {});
  assert.equal(act.memory.conflicts.length, 0, '词表同义组命中 → 不产冲突候选');
  assert.equal(acc.slotText(act.needs.reason), '忘记结账', 'reason 保持原值');
  assert.notEqual(r.askedSlot, 'reason');
});

test('① 12 字守卫回归：10% off vs 110% off（无语气）仍为真冲突', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a3');
  act.needs.offer = { value: '10% off', source: 'explicit', at: NOW };
  const r = await igde.handle(act, '其实想给 110% off', {});
  assert.equal(act.memory.conflicts.length, 1, '数字包含不做同义豁免（真冲突）');
  assert.equal(r.askedSlot, 'offer', '冲突澄清占用本轮提问');
  assert.ok(r.reply.includes('10% off') && r.reply.includes('110% off'), '澄清问句复述新旧两值');
});

test('② S2 全满态真冲突：澄清优先于引导确认；不出预览卡、停留 S2', async () => {
  const envelopes = [{
    reply: '', restatement: [],
    slot_updates: [{ slot: 'audience', value: '浏览未买客户', confidence: 0.95, inferred: false }],
    extras: [], corrections: []
  }];
  const igde = acc.makeScriptedEngine(envelopes);
  const act = mkAct('a4', 'S2');
  fillAll(act);
  const r = await igde.handle(act, '其实主要想召回浏览未买的那批人', {});
  assert.equal(act.stage, 'S2', '澄清轮停留 S2（不回 S1）');
  assert.equal(r.askedSlot, 'audience', '真冲突澄清优先于引导确认');
  assert.deepEqual(r.chips, ['18-24', '25-34', '维持当前年龄定位'], '澄清轮挂冲突 chips');
  assert.equal(r.planCard, null, '澄清轮不产预览卡（C6.5② 只问不推卡）');
  assert.ok(r.reply.includes('25-40岁美国女性'), '先复述旧值');
  assert.ok(r.reply.includes('浏览未买'), '再给新选项');
  assert.ok(!/确认|核对/.test(r.reply), '不混入引导确认话术');
  assert.equal(acc.slotText(act.needs.audience), '25-40岁美国女性', '澄清落定前 needs 不动（S2 冻结）');
  assert.equal(act.memory.clarif_count.audience, 1, '澄清轮计数 +1（拉锯保护依据）');
});

test('② S2 同义重申不触发澄清（豁免先行）：复述 → 引导确认照常', async () => {
  const envelopes = [{
    reply: '', restatement: [],
    slot_updates: [{ slot: 'audience', value: '25 到 40 岁的美国女性', confidence: 0.95, inferred: false }],
    extras: [], corrections: []
  }];
  const igde = acc.makeScriptedEngine(envelopes);
  const act = mkAct('a5', 'S2');
  fillAll(act);
  const r = await igde.handle(act, '对，客群就是 25 到 40 岁的美国女性', {});
  assert.equal(act.memory.conflicts.length, 0, '同义重申不进 conflictsNew（误伤源消灭）');
  assert.equal(r.askedSlot, null, '复述轮不反问');
  assert.deepEqual(r.chips, [], '无追问 chips');
  assert.ok(/确认|核对/.test(r.reply), 'S2 收口引导照常');
});

test('③ 澄清应答闭环：答新值 → explicit 入槽 + corrections 留痕，停留 S2（D2.3）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a6', 'S2');
  fillAll(act);
  act.memory.conflicts = [{ slot: 'audience', old: '25-40岁美国女性', new: '浏览未买客户', at: NOW, asked: true }];
  act.memory.clarif_count = { audience: 1, reason: 0, offer: 0, goal: 0 };
  await igde.handle(act, '浏览未买', {});
  assert.equal(acc.slotText(act.needs.audience), '浏览未买客户', '应答值 explicit 入槽（解冻更新）');
  assert.equal(act.needs.audience.source, 'explicit', 'source=explicit');
  assert.equal(act.memory.corrections.some(c => c.slot === 'audience' && c.old === '25-40岁美国女性'), true, 'corrections 留痕');
  assert.equal(act.stage, 'S2', '停留 S2（确认卡重渲染数据就绪）');
});

test('③ 答「维持当前年龄定位」→ 只关澄清：值不变、无新候选（S2 冻结保持）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a7', 'S2');
  fillAll(act);
  act.memory.conflicts = [{ slot: 'audience', old: '25-40岁美国女性', new: '年轻人', at: NOW, asked: true }];
  act.memory.clarif_count = { audience: 1, reason: 0, offer: 0, goal: 0 };
  const r = await igde.handle(act, '维持当前年龄定位', {});
  assert.equal(acc.slotText(act.needs.audience), '25-40岁美国女性', '快照不变');
  assert.equal(act.stage, 'S2', 'S2 保持');
  assert.ok(/确认|核对/.test(r.reply), '澄清关闭后恢复收口引导');
});

test('④ 拉锯保护：同槽第二次改口（无语气）→ 直接按 correction 落账，不再追问', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a8', 'S2');
  fillAll(act);
  act.memory.clarif_count = { audience: 1, reason: 0, offer: 0, goal: 0 };
  const r = await igde.handle(act, '其实主要还是想发给加购未付的客户', {});
  assert.equal(acc.slotText(act.needs.audience), '加购未付客户', '第二次改口直接生效');
  assert.equal(act.needs.audience.source, 'explicit', '按 correction 落账');
  assert.equal(act.memory.corrections.some(c => c.slot === 'audience'), true, 'corrections 留痕');
  assert.equal(r.askedSlot, null, '不再追问（第二次改口不澄清）');
  assert.equal(act.memory.conflicts.length, 0, '不产新冲突候选');
  assert.equal(act.stage, 'S2', '停留 S2');
});

test('⑤ 剧本 #13/#16 回归：S2 确认期词表叙述提及不反问、不推卡（降级路径）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a9', 'S2');
  fillAll(act);
  const r = await igde.handle(act, '加购未付的客户忘了付款，希望他们回来完成付款，把方案卡给我看看', {});
  assert.equal(act.memory.conflicts.length, 0, 'S2 冻结期词表叙述不产冲突候选');
  assert.equal(r.askedSlot, null, '不反问（引导确认而非继续采集）');
  assert.deepEqual(r.chips, [], '无追问 chips（剧本 #13 口径）');
  assert.equal(r.planCard, null, '降级轮不出 planCard');
  assert.ok(/确认|核对|方案/.test(r.reply), '收口引导不空转');
  assert.equal(acc.slotText(act.needs.audience), '25-40岁美国女性', '受众不被叙述提及顶掉');
});

test('② S1 冲突轮（对照）：桩路径只发澄清问句，一轮一问', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('a10');
  act.needs.audience = { value: '25-40岁美国女性', source: 'explicit', at: NOW };
  const r = await igde.handle(act, '客户主要是年轻人', {});
  // 降级词表对「年轻人」无槽命中（p13 基线），用词表可命中的对照值再验一轮
  assert.equal(r.askedSlot, 'reason', '对照轮正常问下一缺失项');
  const act2 = mkAct('a11');
  act2.needs.audience = { value: '25-40岁美国女性', source: 'explicit', at: NOW };
  const r2 = await igde.handle(act2, '其实主要想召回浏览未买的客户', {});
  assert.equal(r2.askedSlot, 'audience', 'S1 真冲突 → 澄清轮');
  assert.deepEqual(r2.chips, ['18-24', '25-34', '维持当前年龄定位'], '冲突 chips 同源');
  assert.ok(r2.reply.includes('25-40岁美国女性'), '桩路径同样先复述旧值');
  assert.ok(!/这批信你想先召回谁/.test(r2.reply), '同轮不再叠加常规问句（一轮一问）');
});
