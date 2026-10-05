'use strict';
/**
 * F5 功能导览流（剧本 #22 · 2026-10-03 新增 P1）+ F1 出口意图「好，帮我写一封」（剧本 #23 / F1 处理逻辑 4）
 *   - F5：触发 → 菜单 chips（与导航同源 ≤5）；选中 → 讲解（被依赖标注挡住的段不播）；
 *         全程 needs / stage / 清单零变化；业务输入立即让路。
 *   - F1 出口：缺槽 C6 推断补满（全 inferred，0 编造数值）→ 进 S2 出确认卡数据；四槽已齐交回正常流程。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { IGDE } = require('../lib/igde');
const { countFilled } = require('../lib/needs');
const acc = require('../lib/acceptance/assert');

const NOW = Date.now();

function mkAct(id, stage = 'S0') {
  const act = acc.makeAcceptanceAct(id);
  act.stage = stage;
  return act;
}

test('F5 触发轮：「介绍一下其他功能」→ 入口问句 + 菜单 chips（与导航同源 ≤5），零状态变更', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t1');
  const needsBefore = JSON.stringify(act.needs);
  const r = await igde.handle(act, '介绍一下其他功能', {});
  assert.equal(r.reply, '你需要了解哪个功能？', '入口问句 = 定稿话术');
  assert.deepEqual(r.chips, ['邮件配置', '数据看板', '用户', '竞品', '设置'], '菜单 chips 与左侧导航同源（助手除外）');
  assert.equal(r.chips.length <= 5, true, '菜单 chips ≤5');
  assert.equal(JSON.stringify(act.needs), needsBefore, '导览轮 needs 零变化');
  assert.equal(act.stage, 'S0', '导览轮不推进 stage');
  assert.equal(r.planCard, null, '导览轮不出卡');
  assert.equal(r.askedSlot, null, '导览轮不追问');
  assert.equal(act.pending_tour, true, '菜单轮挂起等待选中');
});

test('F5 选中轮：点「邮件配置」→ 讲解含操作路径；被依赖标注挡住的段（发送策略/检索）不播', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t2');
  await igde.handle(act, '介绍一下其他功能', {});
  const r = await igde.handle(act, '邮件配置', {});
  assert.ok(r.reply.includes('点击左侧邮件tab查看所有生成的历史邮件'), '讲解含操作路径（定稿句）');
  assert.ok(r.reply.includes('生成邮件预览后会出现对应的详情卡片'), '详情卡片句（能力已落地）');
  assert.ok(!r.reply.includes('发送策略'), '发送策略未落地 → 对应气泡不播放（依赖标注）');
  assert.ok(!r.reply.includes('查找特定的邮件'), '检索能力未落地 → 对应气泡不播放');
  assert.equal(act.pending_tour, null, '讲解轮结束清挂起');
  assert.equal(act.stage, 'S0', 'needs/stage 零变化');
  assert.equal(countFilled(act.needs), 0, '导览轮 0 槽写入');
});

test('F5 选中轮：数据看板讲解四段播放、报告检索段不播', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t3');
  await igde.handle(act, '有什么功能', {});
  const r = await igde.handle(act, '数据看板', {});
  assert.ok(r.reply.includes('点击左侧数据看板来查看过往邮件获单效果的数据统计'), '侧栏路径句');
  assert.ok(r.reply.includes('转化漏斗哪一栏的百分比掉得最多'), '漏斗行动建议句');
  assert.ok(r.reply.includes('回流GMV，这个量化投放指标'), '回流 GMV 句');
  assert.ok(!r.reply.includes('查找特定的报告'), '报告检索未落地 → 不播（依赖标注）');
});

test('F5 让路：菜单挂起时输入业务内容 → 立即回正常流水线（采集照常、不讲解）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t4');
  await igde.handle(act, '介绍一下其他功能', {});
  assert.equal(act.pending_tour, true, '菜单轮挂起');
  const r = await igde.handle(act, '我想挽回加购未付的客户，我的品牌叫 LunaGlow，做香薰蜡烛', {});
  assert.equal(act.pending_tour, null, '业务输入 → 导览让路（挂起清除）');
  assert.ok(!r.reply.includes('是这样用的'), '不播讲解');
  assert.ok(act.memory.extras.some(e => e.key === 'brand' && /LunaGlow/.test(e.value)), '业务信息正常入 extras（C5）');
  assert.ok(r.askedSlot, '正常采集追问继续（B4）');
});

test('F1 出口「好，帮我写一封」：缺槽 C6 推断补满（全 inferred、0 编造数值）→ 进 S2', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t5');
  const r = await igde.handle(act, '好，帮我写一封', { storeBanner: { connected: true, weekly_abandoned_count: 214 } });
  assert.equal(countFilled(act.needs), 4, '缺槽全部推断补满');
  for (const s of ['audience', 'reason', 'offer', 'goal']) {
    assert.equal(act.needs[s].source, 'inferred', `${s} 推断补满标 inferred（卡上「我推断的，可改」）`);
  }
  assert.ok(/加购未付/.test(acc.slotText(act.needs.audience)), 'audience 按店铺数据/常见打法推断');
  assert.equal(acc.slotText(act.needs.offer), '待定', 'offer 无数值不编默认值（C3 红线）');
  assert.equal(acc.slotText(act.needs.goal), '先跑通流程', 'goal 非数值合法目标（C4 0 编造）');
  assert.equal(act.stage, 'S2', '推断补满 → S2 确认卡（不给缺槽直出邮件开口）');
  assert.equal(r.planCard, null, '推断轮不出预览卡（卡随 /confirm 建码后出）');
  assert.ok(/推断/.test(r.reply), '回复明示推断可改');
});

test('F1 出口：四槽已齐时「帮我写一封」交回正常 S2 流程（引导确认，不重复推断）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t6', 'S2');
  act.needs.audience = { value: '加购未付客户', source: 'explicit', at: NOW };
  act.needs.reason = { value: '忘记结账', source: 'explicit', at: NOW };
  act.needs.offer = { value: '10% off', source: 'explicit', at: NOW };
  act.needs.goal = { value: '本月挽回100单', source: 'explicit', at: NOW };
  act.filled_count = 4;
  const r = await igde.handle(act, '帮我写一封', {});
  assert.equal(act.needs.offer.source, 'explicit', '已确认值不被推断覆盖（S2 冻结）');
  assert.ok(/确认|核对/.test(r.reply), '引导确认照常');
  assert.equal(act.stage, 'S2', '停留 S2');
});

test('F1 出口（在线档位）：推断补满后产出 S2 无码预览卡（D1 确认卡数据源，F1 处理逻辑 4）', async () => {
  const igde = acc.makeScriptedEngine([]); // 写邮件出口为确定性短轮，不消耗 envelope 脚本
  const act = mkAct('t5b');
  const r = await igde.handle(act, '好，帮我写一封', { storeBanner: { connected: true, weekly_abandoned_count: 214 } });
  assert.equal(countFilled(act.needs), 4, '缺槽推断补满');
  assert.equal(r.planCard !== null && r.planCard !== undefined, true, '在线档位出预览卡（确认卡可渲染）');
  assert.equal(r.planCard.code == null, true, '预览卡无折扣码（E2 红线：真实出卡在 /confirm）');
  assert.equal(act.stage, 'S2', '进 S2');
});

test('F1 出口：带业务内容的长句不误触写邮件意图（走正常采集）', async () => {
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = mkAct('t7');
  const r = await igde.handle(act, '帮我写一封挽回加购未付客户的邮件', {});
  assert.equal(act.stage, 'S1', '正常采集流程（非出口短句）');
  assert.ok(r.askedSlot, '继续 B4 追问');
});
