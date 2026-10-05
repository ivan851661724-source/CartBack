'use strict';
/**
 * 2026-10-05 PRD 逐点矩阵（eval/prd-matrix.js）抓到的 4 个引擎缺陷回归：
 *  ① G2 降级离题路由误吞业务首句：BIZ_RE 词表比提取词表窄，「客人说运费太贵就不付了/
 *     我品牌叫 X」类零上下文首句被当闲聊刷掉，槽位/素材整句丢失 → 提取命中/品牌句放行。
 *  ② C2 竞品词缺口：「被别的牌子勾走了」不入 reason。
 *  ③ B2 一句双改：「10% off，不对，还是 15% off」→ 取最终值（原取首个）。
 *  ④ A3/M8 召回问句污染记忆：「我品牌叫啥？」→ brand 被覆写成「啥」→ 疑问捕获不入账。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE, extractNeeds, isNonInfo } = require('../lib/igde');

function stubEngine() {
  return new IGDE({ aiEnabled: false, criticMode: 'off' });
}
function mkAct(id) {
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 't' };
}
async function turn(igde, act, text, opts = {}) {
  return igde.handle(act, text, { persist: async () => {}, storeBanner: { connected: false }, ...opts });
}
const slotVal = (act, k) => (act.needs[k] ? act.needs[k].value : null);

test('① 降级零上下文首句「客人说运费太贵就不付了」→ 提取放行、reason 入槽（不被闲聊刷掉）', async () => {
  const igde = stubEngine();
  const act = mkAct('hc1');
  await turn(igde, act, '客人说运费太贵就不付了');
  assert.equal(slotVal(act, 'reason'), '嫌运费贵、临门犹豫', `实际 reason：${slotVal(act, 'reason')}`);
});

test('① 降级零上下文首句「我品牌叫 LunaGlow…」→ 品牌入 extras（不被闲聊刷掉）', async () => {
  const igde = stubEngine();
  const act = mkAct('hc1b');
  await turn(igde, act, '我品牌叫 LunaGlow 做香薰的');
  assert.ok((act.memory.extras || []).some(e => e.key === 'brand' && e.value === 'LunaGlow'),
    `实际 extras：${JSON.stringify(act.memory.extras)}`);
});

test('① 真闲聊（天气）仍走温和接住拉回——守卫不放过闲聊', async () => {
  const igde = stubEngine();
  const act = mkAct('hc1c');
  const r = await turn(igde, act, '今天天气怎么样');
  assert.ok(/丢了|回来|正事|客人/.test(r.reply), `实际回复：${r.reply}`);
  assert.equal(act.needs.audience, null);
});

test('② 「被别的牌子勾走了」→ reason=可能被竞品勾走', async () => {
  assert.equal(extractNeeds('感觉是被别的牌子勾走了').reason, '可能被竞品勾走');
});

test('③ 一句双改「10% off，不对，还是 15% off」→ 落最终值 15% off', async () => {
  const igde = stubEngine();
  const act = mkAct('hc3');
  await turn(igde, act, '钩子给 10% off，不对，还是 15% off');
  assert.equal(slotVal(act, 'offer'), '15% off', `实际 offer：${slotVal(act, 'offer')}`);
});

test('④ 召回问句「我品牌叫啥？」不得把已存 brand 覆写成「啥」（M8 同源）', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: '你的品牌叫 LunaGlow。', slotUpdates: [], extras: [], corrections: [] }),
    callCritic: async () => true, criticMode: 'off'
  });
  const act = mkAct('hc4');
  await turn(igde, act, '我品牌叫 LunaGlow 做香薰的');
  await turn(igde, act, '我品牌叫啥？客单价多少？');
  const brand = (act.memory.extras || []).find(e => e.key === 'brand');
  assert.ok(brand && brand.value === 'LunaGlow', `brand 被污染：${JSON.stringify(brand)}`);
});

test('⑤ E1 语境守卫：「保证挽回 50%」是效果承诺问句，不触发冲动折扣拦截', async () => {
  const igde = stubEngine();
  const act = mkAct('hc5');
  const r = await turn(igde, act, '我卖灯具的，你能保证挽回 50% 吗，保证不了我不用了');
  assert.ok(!/毛利直接打穿/.test(r.reply), `误触发拦截：${r.reply}`);
  assert.ok(/保证|没法|拍胸脯|试|数据/.test(r.reply) || r.reply.length > 0);
});

test('⑤ 反向：「清仓保证五折」MASS 词仍在，照拦', async () => {
  const impulse = require('../lib/impulse');
  const det = impulse.detectImpulse('清仓大甩卖，保证五折');
  assert.equal(det.hit, true, '清仓+大甩卖必须拦');
});

test('⑥ B1 跨轮依据：模型交「上一轮用户原话」证据的槽可入账（batch3 S14 类早给信息）', async () => {
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async () => ({ reply: '被 Shein 拉走这事儿记下了。', slotUpdates: [{ slot: 'reason', value: '被 Shein 拉走', confidence: 0.9, inferred: false }], extras: [], corrections: [] }),
    callCritic: async () => true, criticMode: 'off'
  });
  const act = mkAct('hc6');
  await turn(igde, act, '我卖泳装的，客人都被 Shein 拉走了');
  await turn(igde, act, '想挽回浏览没买的');
  assert.ok(/shein|拉走/i.test(slotVal(act, 'reason') || ''), `reason 未入槽：${slotVal(act, 'reason')}`);
});
