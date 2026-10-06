'use strict';
/**
 * 2026-10-05 用户实测反馈回归：AI 网关抖动期（全降级会话）正向回复后「确认卡」永不弹出，
 * 而 stub 话术逐句引用「确认卡里核对/点下面的『确认』按钮」——指向一张永远不出现的卡（撒谎）；
 * 「按这个配」在 S2 满卡态还被弱信号离题误吞到闲聊池（hits=SCOPE）。
 * 修复契约：① 降级轮话术卡感知——act.plan_card 不存在时绝不引用当前可见的卡/按钮，
 *   改说「等我恢复稳了就把确认卡摆出来」（剧本 #13 降级不出卡不变）；
 *   ② _offTopicWeak 在 S2/S3 不适用（确认/否认/调整由 S2 stub 分支全权处理）+ 推进语气词扩充。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE } = require('../lib/igde');

const deadEngine = () => new IGDE({
  aiEnabled: true,
  callAI: async () => { throw new Error('LLM HTTP 503'); },
  callCritic: async () => true,
  maxLlmCallsPerTurn: 3, criticMode: 'suspicious'
});

function mkAct(id) {
  return { id, stage: 'S0', needs: { audience: null, reason: null, offer: null, goal: null }, messages: [], memory: { corrections: [], extras: [], prefs: {}, conflicts: [], ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } }, context_summary: null, summary_cursor: 0, context_version: 1, code_status: 'none', filled_count: 0, status: 'active', created_at: Date.now(), updated_at: Date.now(), user_id: 't' };
}

/** 镜像 server 行为：每轮返回的 planCard 由交付层持久化到 act.plan_card（刷新召回源） */
async function turn(igde, act, text) {
  const r = await igde.handle(act, text, { persist: async () => {} });
  if (r.planCard && !act.plan_card) act.plan_card = r.planCard;
  return r;
}

const USER_FLOW = ['我想挽回客人', '加购未付的，顾客还在对比然后忘记了，给赠品贴膜', '挽回5单', '好', '按这个配'];

test('① 全降级重放用户轨迹：满卡轮话术不得引用当前可见的卡/按钮（诚实等恢复）', async () => {
  const igde = deadEngine();
  const act = mkAct('dch1');
  const rs = [];
  for (const input of USER_FLOW) rs.push(await turn(igde, act, input));
  // 满卡轮（挽回5单 → S2）与确认轮（好）均无卡产出（剧本 #13）
  assert.equal(rs[2].planCard, null, '降级满卡轮不出卡（剧本 #13）');
  assert.equal(rs[3].planCard, null, '降级确认轮不出卡');
  for (const i of [2, 3]) {
    const reply = rs[i].reply;
    assert.ok(!/点下面的「确认」按钮/.test(reply), `T${i + 1} 不得引用确认按钮：${reply}`);
    assert.ok(!/在下面确认卡里|在下面的确认卡里|在下面确认卡上|在下面的确认卡上/.test(reply), `T${i + 1} 不得引用当前可见的卡：${reply}`);
    assert.ok(/恢复稳了|直接说|直接跟我说/.test(reply), `T${i + 1} 应给诚实出口：${reply}`);
  }
  assert.equal(act.stage, 'S2', '状态机照常进 S2');
  assert.ok(act.needs.goal && /5\s*单/.test(act.needs.goal.value), 'goal 照常入槽');
});

test('② 降级 S2「按这个配」→ 确认分支，不再被弱信号离题误吞（无 SCOPE、无闲聊池）', async () => {
  const igde = deadEngine();
  const act = mkAct('dch2');
  for (const input of USER_FLOW.slice(0, 4)) await turn(igde, act, input);
  const r = await turn(igde, act, '按这个配');
  assert.ok(!/帮不上/.test(r.reply), `不得误判离题：${r.reply}`);
  assert.ok(!(r.guardrailHits || []).includes('SCOPE'), `不得记 SCOPE：${JSON.stringify(r.guardrailHits)}`);
  assert.ok(/记下了|恢复稳了|确认卡/.test(r.reply), `应走确认/待恢复分支：${r.reply}`);
});

test('③ 在线轮产出卡之后的降级轮：卡在屏上，话术可继续引用（act.plan_card 感知）', async () => {
  const igde = deadEngine();
  const act = mkAct('dch3');
  // 模拟此前在线轮已产出卡并持久化（防呆强制弹卡路径在 aiEnabled 档位会出卡）
  act.needs = {
    audience: { value: '加购未付客户', source: 'explicit', at: 1 },
    reason: { value: '忘记结账', source: 'inferred', at: 1 },
    offer: { value: '10% off', source: 'explicit', at: 1 },
    goal: { value: '挽回 20 单', source: 'explicit', at: 1 }
  };
  act.stage = 'S2';
  act.plan_card = { title: '挽回方案卡' };
  const r = await turn(igde, act, '好');
  assert.ok(/确认/.test(r.reply), `卡在屏上时可引用：${r.reply}`);
});

test('④ 降级 S1 采集期 3+ 轮无进展闲聊仍被弱信号接住（S2 跳过不误伤 S1 兜底）', async () => {
  const igde = deadEngine();
  const act = mkAct('dch4');
  await turn(igde, act, '我想挽回客人');
  await turn(igde, act, '今天天气不错');
  await turn(igde, act, '你吃午饭了吗');
  const r = await turn(igde, act, '外面的天空真蓝啊');
  assert.ok(/帮不上|挽回|邮件|流失|客人/.test(r.reply), `S1 stalled 仍应接住：${r.reply}`);
});

test('⑤ 无 key 桩引擎（aiEnabled=false）防呆弹卡轮：话术同样不引用当前可见的卡', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('dch5');
  await igde.handle(act, '我想挽回加购没付的客人', { persist: async () => {} });
  const r = await igde.handle(act, '别问了，直接生成', { persist: async () => {} });
  assert.equal(r.planCard, null, '无 key 档位不出卡');
  assert.ok(!/在下面确认卡里|在下面的确认卡里|点下面的「确认」按钮/.test(r.reply), `不得引用当前可见的卡：${r.reply}`);
  assert.ok(/恢复稳了|直接跟我说|直接说/.test(r.reply), `应给诚实出口：${r.reply}`);
});
