'use strict';
/**
 * Wave 3 批次域测试（I1 并列批次 / I2 全局停发日历+紧急全停 / I3 未发部分操作 / I4 自动排除）：
 *   A. 域单测（store + lib/campaigns + lib/exclusion + MockConnector + 注入时钟）
 *   B. 对话引擎接线（降级词表整短语 + fake executor；batch_plan 0 静默确认流）
 *   C. HTTP 端到端（spawn 真进程；契约②端点形状 / 停发冻结与顺延 / 紧急全停 / I3 边界声明 / I4 净值明细）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const { Store } = require('../lib/store');
const campaignsMod = require('../lib/campaigns');
const exclusionMod = require('../lib/exclusion');
const execution = require('../lib/execution');
const { MockConnector } = require('../lib/storeConnector');
const { IGDE, extractOps, extractOpsTarget, batchesFromText } = require('../lib/igde');

/* ============================ A. 域单测 ============================ */

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave3-unit-'));
  const store = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  store.init();   // 种子 12 人：加购未付×4 / 弃购×3 / 下单未付×2 / 浏览未买×3
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return store;
}

// 与 server.campaignMatcher 同口径的最小圈人器（拆批语义：加购未付 / 下单未付 分别成批）
function makeMatcher(store) {
  return (desc) => {
    const all = store.getAudience();
    const d = (desc || '').toLowerCase();
    let list;
    if (/加购/.test(d)) list = all.filter(a => /加购/.test(a.intent));
    else if (/下单未付|弃购/.test(d)) list = all.filter(a => /弃购|下单未付/.test(a.intent));
    else if (/浏览/.test(d)) list = all.filter(a => /浏览/.test(a.intent));
    else list = all;
    return list;
  };
}

test('I1 并列批次：逐批独立折扣码；建码失败该批 draft+failed 其余照建；0 静默由确认流保证（引擎测见 B）', async (t) => {
  const store = makeStore(t);
  const connector = new MockConnector({ shop: 'W3' });
  const r = await campaignsMod.createCampaigns(store, {
    batches: [
      { audience_desc: '加购未付', offer_text: '10% off' },
      { audience_desc: '下单未付', offer_text: '15% off' }
    ],
    matcher: makeMatcher(store), connector, brand: 'MyBrand'
  });
  assert.equal(r.campaigns.length, 2, '两批都建成');
  assert.equal(r.failures.length, 0);
  const [a, b] = r.campaigns;
  assert.equal(a.status, 'draft', '建批 ≠ 发送：无排程 → draft');
  assert.equal(b.status, 'draft');
  assert.ok(a.name.startsWith('A'), '人话名字母前缀 A');
  assert.ok(b.name.startsWith('B'), '人话名字母前缀 B');
  assert.equal(a.discount.code_status, 'created');
  assert.equal(b.discount.code_status, 'created');
  assert.ok(a.discount.code && b.discount.code, '两批各自有真实回执码');
  assert.notEqual(a.discount.code, b.discount.code, '逐批独立建码（E2），绝不复用');
  assert.equal(a.percent_off, 10);
  assert.equal(b.percent_off, 15);
  // 建码真实存在（mock 店可验）
  assert.ok(await connector.verifyDiscountCode(a.discount.code));
  assert.ok(await connector.verifyDiscountCode(b.discount.code));

  // 建码失败分支：失败批 draft + code_status=failed + failures 三出口；其余照建（无码批不需要建码）
  const bad = new MockConnector({ shop: 'W3F', createFails: true });
  const r2 = await campaignsMod.createCampaigns(store, {
    batches: [
      { audience_desc: '浏览未买', offer_text: '包邮' },          // 无码钩子 → 不建码 → 照建
      { name: 'Z 失败批', audience_desc: '加购未付', offer_text: '20% off' }
    ],
    matcher: makeMatcher(store), connector: bad, brand: 'MyBrand'
  });
  assert.equal(r2.campaigns.length, 2);
  const failed = r2.campaigns.find(c => c.name === 'Z 失败批');
  assert.equal(failed.status, 'draft', '失败批 status=draft');
  assert.equal(failed.discount.code_status, 'failed');
  assert.equal(failed.discount.code, null, '卡面绝不出现未真实存在的码');
  assert.equal(r2.failures.length, 1);
  assert.equal(r2.failures[0].name, 'Z 失败批');
  assert.deepEqual(r2.failures[0].options, campaignsMod.CODE_FAIL_OPTIONS, '失败三出口');
  assert.equal(r2.campaigns.find(c => c.name.startsWith('A 浏览')).discount.code_status, 'none', '其余照建（无码批）');
});

test('I1 重叠人群：后发批自动排除并计入 excluded 明细（重叠者归先发批）；>3 批给建议不硬拦', async (t) => {
  const store = makeStore(t);
  const connector = new MockConnector({ shop: 'W3' });
  const matcher = makeMatcher(store);
  const r = await campaignsMod.createCampaigns(store, {
    batches: [
      { audience_desc: '加购未付', offer_text: '10% off' },
      { audience_desc: '加购未付那批', offer_text: '10% off' }   // 同人群 → 全部重叠
    ],
    matcher, connector, brand: 'MyBrand'
  });
  const [a, b] = r.campaigns;
  assert.equal(a.recipients.length, 4, '先发批拿走全部 4 人');
  assert.equal(b.recipients.length, 0, '后发批净值 0（重叠者只收先发那批）');
  const overlap = (b.excluded || []).find(x => /重叠/.test(x.reason));
  assert.ok(overlap, 'excluded 明细含重叠原因');
  assert.equal(overlap.count, 4);
  // 4 批 → 一句建议，不硬拦
  const r4 = await campaignsMod.createCampaigns(store, {
    batches: ['加购未付', '弃购', '浏览未买', '下单未付'].map(aud => ({ audience_desc: aud, offer_text: '10% off' })),
    matcher, connector, brand: 'MyBrand'
  });
  assert.equal(r4.campaigns.length, 4);
  assert.equal(r4.advice, campaignsMod.PARALLEL_BATCH_ADVICE, '并行批次 >3 → 建议（不硬拦）');
});

test('I4 三类排除：净值 = 圈定 − 排除、明细逐条；覆盖「别排除」→ 照发 + 审计留痕；冻结晚于排除', async (t) => {
  const store = makeStore(t);
  const connector = new MockConnector({ shop: 'W3' });
  const jiagou = store.getAudience().filter(a => /加购/.test(a.intent));   // 4 人
  // ① 已购买：店铺订单事件（purchased）
  store.addEvent({ type: 'purchased', audience_id: jiagou[0].id, ts: Date.now() });
  // ② 已触达：sends 实发表（频控窗口内，任意 campaign_id）
  store.recordSendRow({ campaign_id: 'cmp_probe', recipient: jiagou[1].email, status: 'sent', at: Date.now() });
  // ③ 已挽回：归因 conversion
  store.addEvent({ type: 'convert', audience_id: jiagou[2].id, value: 88, ts: Date.now() });

  const r = await campaignsMod.createCampaigns(store, {
    batches: [{ audience_desc: '加购未付', offer_text: '10% off' }],
    matcher: makeMatcher(store), connector, brand: 'MyBrand'
  });
  const camp = r.campaigns[0];
  assert.equal(camp.recipients.length, 1, '净值 = 4 − 3 = 1（排除在出核对单之前完成）');
  const reasons = (camp.excluded || []).map(x => x.reason);
  assert.ok(reasons.some(x => /已购买/.test(x)), '明细：已购买（已下单）');
  assert.ok(reasons.some(x => /已触达/.test(x)), '明细：已触达');
  assert.ok(reasons.some(x => /已挽回/.test(x)), '明细：已挽回');
  for (const x of camp.excluded || []) assert.equal(x.count, 1, '逐条明细各 1 人');
  // I4 与 E3 频控同源：窗口常量单处（exclusion 读 config）
  assert.equal(exclusionMod.RECOVERY_WINDOW_MS, 30 * 86400000);

  // 覆盖：别排除 → 照发（净值全量）+ 审计事件留痕
  const auditBefore = store.getEvents().filter(e => e.type === 'audit').length;
  const r2 = await campaignsMod.createCampaigns(store, {
    batches: [{ audience_desc: '加购未付', offer_text: '10% off' }],
    matcher: makeMatcher(store), connector, brand: 'MyBrand', exclusionOverride: true
  });
  const camp2 = r2.campaigns[0];
  assert.equal(camp2.recipients.length, 4, '覆盖后净值 = 圈定全量');
  assert.equal(camp2.exclusion_override, 1);
  const audits = store.getEvents().filter(e => e.type === 'audit');
  assert.equal(audits.length, auditBefore + 1, '审计事件留痕（events type=audit）');
  // 冻结晚于排除：holdout 按净值名单圈定（种子 <200 不冻结，仅验证口径函数序）
  const hold = campaignsMod.freezeCampaignHoldouts(store, camp2, camp2.recipients);
  assert.equal(hold.frozen, false, '名单 <200 不冻结（Wave 2 口径保持）');
});

test('I2 日历：挂/撤/并集/命中；窗口内 sendBlocker 拦截；窗口过后 reconcile 顺延恢复（日历冻结唯一自动恢复）', () => {
  const parsed = campaignsMod.parseBlackoutRange({ from: '2026-11-27', to: '2026-11-28', label: '黑五' });
  assert.ok(parsed.ok);
  assert.equal(parsed.range.from, Date.UTC(2026, 10, 27), '起始日 00:00 UTC');
  assert.equal(parsed.range.to, Date.UTC(2026, 10, 29), '结束日全天含内（闭开区间）');
  assert.ok(campaignsMod.parseBlackoutRange({ from: 'bad', to: '2026-11-28' }).ok === false);
  assert.ok(campaignsMod.parseBlackoutRange({ from: '2026-11-28', to: '2026-11-27' }).ok === false, '结束日不得早于起始日');

  // 并集：重叠区间取并集
  const u = campaignsMod.unionRanges([
    { from: Date.UTC(2026, 10, 27), to: Date.UTC(2026, 10, 29) },
    { from: Date.UTC(2026, 10, 28), to: Date.UTC(2026, 10, 30) },
    { from: Date.UTC(2026, 11, 24), to: Date.UTC(2026, 11, 26) }
  ]);
  assert.deepEqual(u, [
    { from: Date.UTC(2026, 10, 27), to: Date.UTC(2026, 10, 30) },
    { from: Date.UTC(2026, 11, 24), to: Date.UTC(2026, 11, 26) }
  ], '日历重叠取并集');

  // sendBlocker：紧急全停 > 日历
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave3-blk-'));
  let store = null;
  try {
    store = new Store({ dbFile: path.join(dir, 'data.sqlite') });
    store.init();
    store.addBlackout({ from: Date.UTC(2026, 10, 27), to: Date.UTC(2026, 10, 29), label: '黑五' });
    const inWin = Date.UTC(2026, 10, 28, 5);
    const outWin = Date.UTC(2026, 10, 30, 5);
    let b = campaignsMod.sendBlocker(store, { now: inWin });
    assert.equal(b.kind, 'calendar', '窗口内 → 日历拦截');
    assert.equal(b.retryAt, Date.UTC(2026, 10, 29), '顺延目标 = 窗口结束时刻');
    assert.equal(campaignsMod.sendBlocker(store, { now: outWin }), null, '窗口外 → 放行');
    campaignsMod.setGlobalPaused(store, true);
    b = campaignsMod.sendBlocker(store, { now: outWin });
    assert.equal(b.kind, 'global', '紧急全停高于一切（含日历）');
    campaignsMod.setGlobalPaused(store, false);

    // 窗口过后 reconcile：日历冻结批次自动恢复 + 顺延提示；紧急全停冻结绝不自动恢复
    const camp = {
      id: 'cmp_blk', user_id: null, name: 'A 加购未付', audience_desc: '加购未付', status: 'frozen',
      offer_text: '10% off', percent_off: 10,
      discount: { text: '', code: 'X', code_status: 'created' },
      recipients: [], excluded: [], scheduled_at: Date.UTC(2026, 10, 28, 9),
      prev_status: 'scheduled', pause_scope: null, freeze_scope: 'calendar',
      frozen_reason: '停发日历', brand: 'MyBrand', subject: '', exclusion_override: 0, gate_note: null,
      created_at: Date.now(), updated_at: Date.now()
    };
    store.upsertCampaign(camp);
    const gCamp = { ...camp, id: 'cmp_blk_g', freeze_scope: 'global', scheduled_at: 0, prev_status: 'scheduled' };
    store.upsertCampaign(gCamp);
    const restored = campaignsMod.reconcileBlackout(store, { now: outWin });
    assert.equal(restored.length, 1, '只恢复日历冻结（紧急全停绝不自动恢复）');
    assert.equal(restored[0].id, 'cmp_blk');
    const after = store.getCampaign('cmp_blk');
    assert.ok(['draft', 'scheduled'].includes(after.status), '窗口已过且无未来排程 → 回 draft（重触发即发）');
    assert.ok(after.resume_note && after.resume_note.includes('恢复'), '逐批恢复提示（resume_note）');
    assert.equal(store.getCampaign('cmp_blk_g').status, 'frozen', '全停冻结保持冻结');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('I2 紧急全停：running→paused、scheduled/frozen→frozen；resumeAll 只解全停范围（user 手动暂停保持）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave3-pa-'));
  let store = null;
  try {
    store = new Store({ dbFile: path.join(dir, 'data.sqlite') });
    store.init();
    const base = { user_id: null, audience_desc: '加购未付', offer_text: '10% off', percent_off: 10, discount: { text: '', code: null, code_status: 'none' }, recipients: [], excluded: [], scheduled_at: 0, prev_status: null, pause_scope: null, freeze_scope: null, frozen_reason: null, brand: 'B', subject: '', exclusion_override: 0, gate_note: null, created_at: Date.now(), updated_at: Date.now() };
    store.upsertCampaign({ ...base, id: 'cmp_r', name: 'A', status: 'running' });
    store.upsertCampaign({ ...base, id: 'cmp_s', name: 'B', status: 'scheduled', scheduled_at: Date.now() + 3600e3 });
    store.upsertCampaign({ ...base, id: 'cmp_u', name: 'C', status: 'paused', pause_scope: 'user', prev_status: 'draft' });
    store.upsertCampaign({ ...base, id: 'cmp_f', name: 'D', status: 'frozen', freeze_scope: 'calendar', prev_status: 'scheduled' });

    const r = campaignsMod.pauseAll(store, { now: Date.now() });
    assert.ok(r.ok);
    assert.equal(campaignsMod.getGlobalPaused(store), true);
    assert.equal(store.getCampaign('cmp_r').status, 'paused', 'running → paused');
    assert.equal(store.getCampaign('cmp_r').pause_scope, 'global');
    assert.equal(store.getCampaign('cmp_s').status, 'frozen', 'scheduled → frozen');
    assert.equal(store.getCampaign('cmp_f').status, 'frozen', 'frozen 保持 frozen');
    assert.equal(store.getCampaign('cmp_u').status, 'paused');

    const r2 = campaignsMod.resumeAll(store, { now: Date.now() });
    assert.equal(campaignsMod.getGlobalPaused(store), false);
    assert.ok(r2.resumed.includes('A') && r2.resumed.includes('B'), '全停范围恢复');
    assert.equal(store.getCampaign('cmp_r').status, 'scheduled', 'running 归一 scheduled（重触发即续跑）');
    assert.equal(store.getCampaign('cmp_s').status, 'scheduled');
    assert.equal(store.getCampaign('cmp_u').status, 'paused', 'user 手动暂停不被 resume-all 越权恢复');
    assert.equal(store.getCampaign('cmp_u').pause_scope, 'user');
    assert.equal(store.getCampaign('cmp_f').status, 'frozen', '日历冻结不归 resume-all 管（reconcile 专管）');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('I3 未发部分操作：边界声明恒含「已发 X 封不受影响，改的是未发的 Y 封」；改折扣建新码旧码仍有效；已发只读', async (t) => {
  const store = makeStore(t);
  const connector = new MockConnector({ shop: 'W3' });
  const r = await campaignsMod.createCampaigns(store, {
    batches: [{ audience_desc: '加购未付', offer_text: '10% off' }],
    matcher: makeMatcher(store), connector, brand: 'MyBrand'
  });
  const camp = r.campaigns[0];
  assert.equal(camp.recipients.length, 4);
  // 已发 3 封（逐收件人落 sends，campaign_id=campaign.id）
  for (const rc of camp.recipients.slice(0, 3)) {
    store.recordSendRow({ act_id: camp.act_id, campaign_id: camp.id, recipient: rc.email, code: camp.discount.code, status: 'sent' });
  }
  const c = campaignsMod.deriveCounts(store, camp);
  assert.deepEqual({ reach: c.reach, sent: c.sent, holdout: c.holdout, pending: c.pending }, { reach: 4, sent: 3, holdout: 0, pending: 1 }, 'sent/pending 派生自 sends/holdouts');
  assert.equal(campaignsMod.boundaryOf(camp, store), '已发 3 封不受影响，改的是未发的 1 封', 'I3 灵魂句（边界声明）');

  // —— 暂停 / 恢复（空批也照给边界；恢复期间全停 → 拒绝）——
  const p = campaignsMod.pauseCampaign(store, camp, { scope: 'user' });
  assert.ok(p.ok && camp.status === 'paused');
  campaignsMod.setGlobalPaused(store, true);
  const rr = campaignsMod.resumeCampaign(store, camp);
  assert.equal(rr.ok, false, '全停期间单批恢复拒绝（恢复必须先解除全停）');
  campaignsMod.setGlobalPaused(store, false);
  const rr2 = campaignsMod.resumeCampaign(store, camp);
  assert.ok(rr2.ok && camp.status === 'draft');

  // —— 改折扣：只改未发；力度变化 → 新码；旧码仅对已发邮件继续有效 ——
  const oldCode = camp.discount.code;
  const sendsBefore = store.getSends({ campaign_id: camp.id }).map(s => ({ r: s.recipient, code: s.code, status: s.status }));
  const d = await campaignsMod.changeDiscount(store, camp, { percentOff: 15, connector });
  assert.ok(d.ok);
  assert.notEqual(d.code, oldCode, '力度变化 → 建新码（E2 逐批建）');
  assert.equal(camp.discount.code, d.code);
  assert.equal(camp.percent_off, 15);
  assert.deepEqual(
    store.getSends({ campaign_id: camp.id }).map(s => ({ r: s.recipient, code: s.code, status: s.status })),
    sendsBefore, '已发 sends 行不变（旧码仍挂在已发邮件上）');
  assert.ok(await connector.verifyDiscountCode(oldCode), '旧码对已发邮件继续有效（店铺中仍存在）');
  assert.ok(await connector.verifyDiscountCode(d.code), '新码真实存在');
  // 已发部分占满 → 改折扣拒绝且边界照给语义
  const campDone = r.campaigns[0];
  for (const rc of campDone.recipients) {
    store.recordSendRow({ campaign_id: campDone.id, recipient: 'x' + rc.email, status: 'sent' }); // 不影响本批净值
  }
  // —— 排除：从未发名单即时移除、逐条留痕；已发部分 → 拒绝并解释 ——
  const pendingOne = camp.recipients[3].email;
  const ex = campaignsMod.excludeFromCampaign(store, camp, { emails: [pendingOne] });
  assert.ok(ex.ok && ex.excluded_count === 1);
  assert.equal(camp.recipients.length, 3, '净值名单即时移除');
  const manual = (camp.excluded || []).find(x => x.reason === '手动排除');
  assert.ok(manual && manual.emails.includes(pendingOne), '逐条留痕（emails 明细）');
  assert.ok(store.getEvents().some(e => e.type === 'audit' && e.draft_id === camp.id), '审计事件留痕');
  const exSent = campaignsMod.excludeFromCampaign(store, camp, { emails: [camp.recipients[0].email] }); // 该人已发
  assert.equal(exSent.ok, false, '操作对象是已发部分 → 拒绝');
  assert.ok(/已发/.test(exSent.reason) && /只读/.test(exSent.reason), '拒绝并解释');

  // —— 重发：未确认 409 needs_confirm + 风险数字；确认 → 新批次（新码）+ 留痕 ——
  // 补一封实发（重发对象=已发未打开；本波打开回执未接 → 已发名单即对象）
  const rr3 = await campaignsMod.resendCampaign(store, camp, { connector, confirmFrequency: false });
  assert.equal(rr3.ok, false);
  assert.equal(rr3.needs_confirm, true);
  assert.match(rr3.risk, /72 小时内已触达 \d+ 人/, '风险数字（频控窗口读 sends）');
  const rr4 = await campaignsMod.resendCampaign(store, camp, { connector, confirmFrequency: true });
  assert.ok(rr4.ok);
  const newCamp = rr4.camp;
  assert.equal(newCamp.status, 'draft', '重发生成新批次（draft，未发）');
  assert.ok(newCamp.name.includes('重发'));
  assert.notEqual(newCamp.discount.code, camp.discount.code, '重发新码');
  assert.equal(newCamp.recipients.length, 3, '重发对象 = 已发未打开（打开回执未接，口径注释）');
  assert.ok(store.getEvents().some(e => e.type === 'audit' && /resend:/.test(e.order_id || '')), '确认后留痕');
});

/* ============================ B. 对话引擎接线 ============================ */

test('降级词表：批次/停发/全停/恢复/单批操作整短语匹配（禁碎片切片）', () => {
  assert.deepEqual(extractOps('先全停'), { kind: 'pause_all' });
  assert.deepEqual(extractOps('都停发，先全停'), { kind: 'pause_all' });
  assert.deepEqual(extractOps('恢复吧'), { kind: 'resume_all' });
  const bk = extractOps('黑五（11/27–11/28）都停发');
  assert.equal(bk.kind, 'blackout');
  assert.deepEqual(bk.params, { from: '2026-11-27', to: '2026-11-28', label: '停发' });
  const bk2 = extractOps('11月27到29号停发');
  assert.deepEqual(bk2.params, { from: '2026-11-27', to: '2026-11-29', label: '停发' });
  assert.deepEqual(extractOps('A 批暂停'), { kind: 'op', op: 'pause', target: { letter: 'A' } });
  const dm = extractOps('没发完的那些折扣改成 15%');
  assert.equal(dm.kind, 'op');
  assert.equal(dm.op, 'discount');
  assert.equal(dm.params.percent_off, 15);
  assert.deepEqual(extractOps('给没打开的再打一轮'), { kind: 'resend', target: null, subject: '' });
  assert.equal(extractOps('把加购未付和下单未付分别做成两个批次').kind, 'batch_plan');
  assert.equal(extractOps('今天的天气不错'), null, '无运维意图不误触');
  assert.equal(extractOps('受众改成老客，折扣换 15%'), null, '非「改成/换成 + N%」相邻结构不误触单批折扣（词表整短语，禁碎片切片）');
  assert.deepEqual(extractOpsTarget('批次 A 暂停'), { letter: 'A' });
  assert.deepEqual(extractOpsTarget('第一封先停'), { ordinal: '一' });
  assert.deepEqual(extractOpsTarget('加购未付那批恢复'), { keyword: '加购未付' });
  assert.deepEqual(batchesFromText('把加购未付和下单未付分别做成两个批次', { needs: { offer: { value: '10% off' } } }),
    [{ audience_desc: '加购未付', offer_text: '10% off' }, { audience_desc: '下单未付', offer_text: '10% off' }],
    '按原话出现顺序拆批（A=加购，B=下单）');
});

/** fake executor：记录调用 + 返回结构化结果（引擎人话组装的真实消费方） */
function makeFakeExecutor() {
  const calls = { previewBatches: [], createBatches: [], campaignOp: [], pauseAll: 0, resumeAll: 0, addBlackout: [] };
  return {
    calls,
    async previewBatches(batches) {
      calls.previewBatches.push(batches);
      return batches.map((b, i) => ({
        name: `${'ABCD'[i]} ${b.audience_desc}`, audience_desc: b.audience_desc,
        offer_text: b.offer_text || '10% off', percent_off: 10,
        reach_count: 23 + i, excluded: [{ reason: '已购买（店铺已下单）', count: 2 }]
      }));
    },
    async createBatches(batches, opts) {
      calls.createBatches.push({ batches, opts });
      return {
        campaigns: batches.map((b, i) => ({
          id: 'cmp_' + i, name: `${'ABCD'[i]} ${b.audience_desc}`, audience_desc: b.audience_desc,
          status: 'draft', discount: { text: '折扣码 C' + i, code: 'CODE' + i, code_status: 'created' },
          reach_count: 23 + i, sent_count: 0, pending_count: 23 + i, holdout_count: 0, excluded: [],
          stats: { opened: 0, clicked: 0, recovered: 0, net: 0 }, created_at: Date.now()
        })),
        failures: [], advice: null
      };
    },
    resolveTarget(ref) { return { campaign_id: 'cmp_0', name: 'A 加购未付' }; },
    async campaignOp(o) {
      calls.campaignOp.push(o);
      if (o.op === 'pause' || o.op === 'resume') return { ok: true, name: 'A 加购未付', status: o.op === 'pause' ? 'paused' : 'draft', boundary: '已发 18 封不受影响，改的是未发的 5 封' };
      if (o.op === 'discount') return { ok: true, name: 'A 加购未付', code: 'NEW15', oldCode: 'OLD10', changed: ['折扣改为 15%'], boundary: '已发 18 封不受影响，改的是未发的 5 封' };
      if (o.op === 'resend' && !(o.params && o.params.confirm_frequency)) return { ok: false, needs_confirm: true, risk: '72 小时内已触达 18 人', campaign_id: 'cmp_0' };
      if (o.op === 'resend') return { ok: true, camp: { name: 'A 加购未付 重发', discount: { code: 'RE12' }, recipients: [1, 2, 3] } };
      return { ok: true, name: 'A 加购未付', boundary: '已发 18 封不受影响，改的是未发的 5 封' };
    },
    async pauseAll() { calls.pauseAll++; return { ok: true, paused: 1, frozen: 2 }; },
    async resumeAll() { calls.resumeAll++; return { ok: true, resumed: ['A 加购未付'], resumed_count: 1 }; },
    async addBlackout(params) { calls.addBlackout.push(params); return { ok: true, range: { from: '2026-11-27', to: '2026-11-28', label: params.label || '停发' } }; }
  };
}

function makeAct() {
  return {
    id: 'act_w3', stage: 'S2',
    needs: { audience: { value: '加购未付客户', source: 'explicit', at: 1 }, reason: { value: '太久没动静', source: 'explicit', at: 1 }, offer: { value: '10% off', source: 'explicit', at: 1 }, goal: { value: '唤醒回流', source: 'explicit', at: 1 } },
    messages: [], memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    code_status: 'none', filled_count: 4, status: 'active', created_at: 0, updated_at: 0
  };
}

test('B 引擎降级流：两个批次 → 逐批复述 + 0 静默（确认才建）→ 确认建批 → 建批 ≠ 发送', async () => {
  const executor = makeFakeExecutor();
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = makeAct();
  const r1 = await igde.handle(act, '把加购未付和下单未付分别做成两个批次', { executors: executor });
  assert.deepEqual(executor.calls.createBatches, [], '0 静默：plan 轮绝不建批');
  assert.equal(executor.calls.previewBatches.length, 1, '逐批复述需要净值预览');
  assert.equal(executor.calls.previewBatches[0].length, 2);
  assert.ok(/批次 A 加购未付/.test(r1.reply) && /批次 B 下单未付/.test(r1.reply), '逐批复述（人话名 + 人 数 + 钩子）');
  assert.ok(/对吗/.test(r1.reply), '逐批复述确认句式');
  assert.ok(/已购买（店铺已下单） 2 人/.test(r1.reply), '核对单排除明细进回复');
  assert.deepEqual(r1.chips, ['确认建批', '改一下'], '确认 chips（0 静默）');
  assert.equal(act.pending_ops.batches.length, 2, '待确认计划挂 act（不落 campaigns）');
  assert.deepEqual(r1.batches.map(b => b.audience_desc), ['加购未付', '下单未付'], 'done 帧 batches（待确认批次卡）');

  const r2 = await igde.handle(act, '对，确认建批', { executors: executor });
  assert.equal(executor.calls.createBatches.length, 1, '确认后才真正建批');
  assert.equal(executor.calls.createBatches[0].batches.length, 2);
  assert.ok(/建好了/.test(r2.reply) && /CODE0/.test(r2.reply) && /CODE1/.test(r2.reply), '确认回复逐批带码');
  assert.ok(/建批不等于发送/.test(r2.reply), '建批 ≠ 发送');
  assert.equal(act.pending_ops, null, '确认后清 pending');
  assert.deepEqual(r2.chips, []);
});

test('B 引擎降级流：全停 → 恢复吧（明说）；单批暂停/改折扣（边界声明）/重发确认流', async () => {
  const executor = makeFakeExecutor();
  const igde = new IGDE({ aiEnabled: false, criticMode: 'off' });
  const act = makeAct();

  const r1 = await igde.handle(act, '先全停', { executors: executor });
  assert.equal(executor.calls.pauseAll, 1, '紧急全停立即执行');
  assert.ok(/恢复必须你明说「恢复吧」/.test(r1.reply), '恢复必须明说（绝不自动恢复）');

  const r2 = await igde.handle(act, '恢复吧', { executors: executor });
  assert.equal(executor.calls.resumeAll, 1, '「恢复吧」= 明说的恢复动作');
  assert.ok(/全停解除/.test(r2.reply));

  const r3 = await igde.handle(act, 'A 批暂停', { executors: executor });
  assert.equal(executor.calls.campaignOp.length, 1);
  assert.equal(executor.calls.campaignOp[0].op, 'pause');
  assert.ok(/已发 18 封不受影响，改的是未发的 5 封/.test(r3.reply), '边界声明');

  const r4 = await igde.handle(act, '没发完的那些折扣改成 15%', { executors: executor });
  assert.equal(executor.calls.campaignOp[1].op, 'discount');
  assert.equal(executor.calls.campaignOp[1].params.percent_off, 15);
  assert.ok(/已发 18 封不受影响/.test(r4.reply), '改折扣回复含边界声明');
  assert.ok(/新码 NEW15/.test(r4.reply) && /旧码 OLD10/.test(r4.reply), '新码只对未发、旧码仍有效');

  const r5 = await igde.handle(act, '给没打开的再打一轮', { executors: executor });
  assert.ok(/72 小时内已触达 18 人/.test(r5.reply), '频次护栏：409 语义 needs_confirm + 风险数字');
  assert.deepEqual(r5.chips, ['确认重发', '先不重发']);
  assert.equal(act.pending_ops.resend.campaign_id, 'cmp_0', '重发确认挂起');
  const r6 = await igde.handle(act, '确认重发', { executors: executor });
  assert.equal(executor.calls.campaignOp[2].params.confirm_frequency, false, '首次重发未确认（护栏）');
  assert.equal(executor.calls.campaignOp[3].op, 'resend');
  assert.equal(executor.calls.campaignOp[3].params.confirm_frequency, true, '确认后带 confirm_frequency 留痕');
  assert.ok(/新批次/.test(r6.reply));
});

test('B 引擎在线 envelope：campaign_ops / batch_plan 经执行器；黑五日历 + 全停 + 恢复', async () => {
  const executor = makeFakeExecutor();
  const igde = new IGDE({
    aiEnabled: true, criticMode: 'off',
    callAI: async () => ({
      reply: '（模型话术，运维轮由引擎确定性组装替换）',
      slot_updates: [], extras: [], corrections: [],
      campaign_ops: [
        { op: 'blackout', params: { from: '2026-11-27', to: '2026-11-28', label: '黑五' } },
        { op: 'pause_all' }
      ]
    })
  });
  const act = makeAct();
  const r = await igde.handle(act, '黑五（11/27–11/28）都停发，先全停', { executors: executor });
  assert.deepEqual(executor.calls.addBlackout, [{ from: '2026-11-27', to: '2026-11-28', label: '黑五' }], '日历挂上');
  assert.equal(executor.calls.pauseAll, 1, '紧急全停');
  assert.ok(/停发日历已挂上/.test(r.reply), '黑五挂日历提示');
  assert.ok(/恢复必须你明说「恢复吧」/.test(r.reply), '全停提示');
  assert.equal(r.campaignOps.length, 2, 'opResults 随结果返回');
  // 恢复轮（envelope 无 ops → 确认流不触发，降级词表接「恢复吧」——在线轮模型须发 campaign_ops；
  // 引擎对在线轮的「恢复吧」交还模型：此处验证不会误触降级词表）
  executor.calls.resumeAll = 0;
  const igde2 = new IGDE({
    aiEnabled: true, criticMode: 'off',
    callAI: async () => ({ reply: '好，全停解除，两批都回到原状态。', slot_updates: [], extras: [], corrections: [], campaign_ops: [{ op: 'resume_all' }] })
  });
  const r2 = await igde2.handle(act, '恢复吧', { executors: executor });
  assert.equal(executor.calls.resumeAll, 1);
  assert.ok(/全停解除/.test(r2.reply));
});

/* ============================ C. HTTP 端到端 ============================ */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

async function startServer(t, { configObj = {}, fakeNow = null, dir = null, keep = false } = {}) {
  const madeDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'wave3-http-'));
  if (!dir) fs.writeFileSync(path.join(madeDir, 'config.json'), JSON.stringify(configObj));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), EY_SERVER_DIR: madeDir, CARTBACK_OPEN_LOCAL: '1' };
  if (fakeNow) env.CARTBACK_FAKE_NOW = String(fakeNow);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  for (let i = 0; i < 40 && !token; i++) {
    try {
      const r = await fetch(base + '/api/bootstrap');
      if (r.ok) token = (await r.json()).token || '';
    } catch (e) { /* retry */ }
    if (!token) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(token, 'server booted');
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-local-token': token },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 1500))]);
    if (!keep) fs.rmSync(madeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { api, dir: madeDir, base };
}

async function waitFor(api, jobId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await api(`/api/jobs/${jobId}`);
    if (['done', 'failed'].includes(j.json.status)) return j.json;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('waitFor job timeout');
}

const CSV_30 = ['name,email,intent,risk,price,abandoned_value',
  ...Array.from({ length: 30 }, (_, i) => `导入${i},bulk${i}@test.com,加购未付,高,中,${100 + i}`)].join('\n');

test('C 契约：POST /api/campaigns 两批独立码 + GET /api/state 顶层 campaigns/blackout/global_paused', async (t) => {
  const { api } = await startServer(t, {
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: 'https://e2e.example', shopBrand: 'MyBrand' }
  });
  await api('/api/audience/import', { method: 'POST', body: { csv: CSV_30 } });
  const cr = await api('/api/campaigns', {
    method: 'POST',
    body: { batches: [{ audience_desc: '加购未付', offer_text: '10% off' }, { audience_desc: '下单未付', offer_text: '15% off' }] }
  });
  assert.equal(cr.status, 200);
  assert.equal(cr.json.ok, true);
  assert.equal(cr.json.campaigns.length, 2);
  assert.deepEqual(cr.json.failures, []);
  const [a, b] = cr.json.campaigns;
  // 契约① campaign JSON 形状
  for (const c of [a, b]) {
    for (const k of ['id', 'act_id', 'name', 'audience_desc', 'status', 'discount', 'reach_count', 'sent_count', 'pending_count', 'holdout_count', 'excluded', 'stats', 'created_at']) {
      assert.ok(k in c, `campaign.${k} 在契约形状内`);
    }
    // Wave 4 F3：stats 从 sends+events 实时派生（不再是 0 占位）；新批次无实发 → 全 0
    assert.deepEqual(Object.keys(c.stats), ['opened', 'clicked', 'recovered', 'gmv', 'net'], 'stats 契约形状（Wave 4 派生）');
    assert.equal(c.stats.opened + c.stats.clicked + c.stats.recovered + c.stats.net, 0, '新批次无实发 stats 全 0');
    assert.equal(c.discount.code_status, 'created');
  }
  assert.notEqual(a.discount.code, b.discount.code, '逐批独立码');
  assert.equal(a.reach_count, 34, '加购未付 = 种子 4 + 导入 30');
  assert.equal(b.reach_count, 5, '下单未付 = 种子 2（周野/温言）… 导入无此 intent');

  const st = await api('/api/state');
  assert.equal(st.status, 200);
  assert.equal(st.json.campaigns.length, 2);
  assert.deepEqual(st.json.blackout, { active: false, ranges: [] }, 'blackout 契约');
  assert.equal(st.json.global_paused, false);

  const list = await api('/api/campaigns');
  assert.equal(list.json.ok, true);
  assert.equal(list.json.campaigns[0].sent_count, 0);
  assert.equal(list.json.campaigns[0].pending_count, list.json.campaigns[0].reach_count, 'pending = 净值 − 已发 − holdout');
});

test('C I2：黑五日历窗口内排程发送 → 冻结不删不发送；窗口过后自动顺延恢复 + resume_note', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave3-http-blk-'));
  const IN_WINDOW = Date.UTC(2026, 10, 27, 12);   // 黑五当天
  const phase1 = await startServer(t, {
    dir, keep: true,
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: 'https://e2e.example', shopBrand: 'MyBrand' },
    fakeNow: IN_WINDOW
  });
  await phase1.api('/api/audience/import', { method: 'POST', body: { csv: CSV_30 } });
  // 挂日历（可提前挂）
  const bk = await phase1.api('/api/blackout', { method: 'POST', body: { from: '2026-11-27', to: '2026-11-28', label: '黑五' } });
  assert.equal(bk.status, 200);
  assert.equal(bk.json.active, true);
  assert.deepEqual(bk.json.blackout, { id: bk.json.blackout.id, from: '2026-11-27', to: '2026-11-28', label: '黑五' });
  // 建批 + 发送（入口即停发检查 → 冻结，不删不发送；无需等 job）
  const cr = await phase1.api('/api/campaigns', { method: 'POST', body: { batches: [{ audience_desc: '加购未付', offer_text: '10% off' }] } });
  const campId = cr.json.campaigns[0].id;
  const sd = await phase1.api(`/api/campaigns/${campId}/send`, { method: 'POST', body: { scheduled_at: Date.now() + 1500 } });
  assert.equal(sd.status, 202);
  assert.equal(sd.json.frozen, true, '命中停发日 → 冻结（不删不发送）');
  assert.equal(sd.json.kind, 'calendar');
  const frozen = (await phase1.api('/api/campaigns')).json.campaigns.find(c => c.id === campId);
  assert.equal(frozen.status, 'frozen');
  // 紧急全停也一并验掉（同进程）：全停后单批恢复拒绝
  const pa = await phase1.api('/api/pause-all', { method: 'POST', body: {} });
  assert.equal(pa.json.global_paused, true);
  const resBlocked = await phase1.api(`/api/campaigns/${campId}/resume`, { method: 'POST', body: {} });
  assert.equal(resBlocked.status, 409, '全停期间单批恢复拒绝');
  // 停发期间新批次可建（draft）不可发
  const cr2 = await phase1.api('/api/campaigns', { method: 'POST', body: { batches: [{ audience_desc: '浏览未买', offer_text: '10% off' }] } });
  assert.equal(cr2.status, 200, '停发期间可建批');
  const sendWhilePaused = await phase1.api(`/api/campaigns/${cr2.json.campaigns[0].id}/send`, { method: 'POST', body: {} });
  assert.equal(sendWhilePaused.status, 202);
  assert.equal(sendWhilePaused.json.frozen, true, '停发期间不可发（冻结）');
  const ra = await phase1.api('/api/resume-all', { method: 'POST', body: {} });
  assert.equal(ra.json.global_paused, false, '恢复须明说（端点即显式动作）');

  const db1 = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const sends1 = db1.prepare('SELECT COUNT(*) AS n FROM sends').get();
  db1.close();
  assert.equal(sends1.n, 0, '窗口内零发送');

  // Phase 2：注入时钟到窗口后 → 对账自动顺延恢复
  const AFTER = Date.UTC(2026, 10, 29, 12);
  const phase2 = await startServer(t, { dir, keep: true, fakeNow: AFTER });
  const st = await phase2.api('/api/state');
  const resumed = st.json.campaigns.find(c => c.id === campId);
  assert.ok(['draft', 'scheduled'].includes(resumed.status), '窗口过后自动顺延恢复');
  assert.ok(resumed.resume_note && /恢复/.test(resumed.resume_note), '逐批恢复提示');
  assert.equal(resumed.sent_count, 0, '窗口内未发（冻结不删）');
  const db2 = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const sends2 = db2.prepare('SELECT COUNT(*) AS n FROM sends').get();
  const blk = db2.prepare('SELECT COUNT(*) AS n FROM blackouts').get();
  db2.close();
  assert.equal(sends2.n, 0);
  assert.equal(blk.n, 1, '日历冻结不删除（可撤）');
  const del = await phase2.api(`/api/blackout/${bk.json.blackout.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* Windows 句柄延迟：尽力清理 */ }
});

test('C I3：改折扣只改未发（已发 18 封边界声明 + 旧码仍有效 + sends 不变）；排除/重发确认流', async (t) => {
  const { api, dir } = await startServer(t, {
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: 'https://e2e.example', shopBrand: 'MyBrand' }
  });
  await api('/api/audience/import', { method: 'POST', body: { csv: CSV_30 } });
  const cr = await api('/api/campaigns', { method: 'POST', body: { batches: [{ audience_desc: '加购未付', offer_text: '10% off' }] } });
  const camp = cr.json.campaigns[0];
  assert.equal(camp.reach_count, 34);
  const oldCode = camp.discount.code;
  // 模拟 A 批已发 18 封（直接落 sends 实发流水；归因只认实发；旧码挂在已发行上）
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const ins = db.prepare('INSERT INTO sends (id, campaign_id, recipient, code, status, at) VALUES (?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  for (let i = 0; i < 18; i++) ins.run('snd_t' + i, camp.id, `bulk${i}@test.com`, oldCode, 'sent', now);
  db.close();

  // 改折扣：只改未发 → 边界声明必含「已发 18 封不受影响」
  const d = await api(`/api/campaigns/${camp.id}/discount`, { method: 'POST', body: { percent_off: 15 } });
  assert.equal(d.status, 200);
  assert.equal(d.json.ok, true);
  assert.equal(d.json.boundary, '已发 18 封不受影响，改的是未发的 16 封', 'I3 灵魂句');
  assert.deepEqual(d.json.changed, ['折扣改为 15%']);
  assert.notEqual(d.json.campaign.discount.code, oldCode, '新码');
  const db2 = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const sentRows = db2.prepare("SELECT recipient, code, status FROM sends WHERE campaign_id = ? AND status = 'sent'").all(camp.id);
  db2.close();
  assert.equal(sentRows.length, 18, '已发 18 封不变');
  assert.ok(sentRows.every(r => r.code === oldCode), '旧码仍挂在已发邮件上（仅对已发继续有效）');

  // 排除：未发名单即时移除 + 留痕；已发部分拒绝
  const exSent = await api(`/api/campaigns/${camp.id}/exclude`, { method: 'POST', body: { emails: ['bulk0@test.com'] } });
  assert.equal(exSent.status, 409, '已发部分 → 拒绝并解释');
  assert.ok(/已发/.test(exSent.json.error));
  const ex = await api(`/api/campaigns/${camp.id}/exclude`, { method: 'POST', body: { emails: ['bulk20@test.com', 'bulk21@test.com'] } });
  assert.equal(ex.status, 200);
  assert.equal(ex.json.excluded_count, 2);
  assert.equal(ex.json.boundary, '已发 18 封不受影响，改的是未发的 14 封', '排除后边界声明同步');
  assert.ok((ex.json.campaign.excluded || []).some(x => x.reason === '手动排除' && (x.emails || []).length === 2), '逐条留痕');

  // 重发：未确认 409 needs_confirm + 风险数字；确认 → 新批次（新码）
  const rs1 = await api(`/api/campaigns/${camp.id}/resend`, { method: 'POST', body: {} });
  assert.equal(rs1.status, 409);
  assert.equal(rs1.json.needs_confirm, true);
  assert.match(rs1.json.risk, /72 小时内已触达 18 人/);
  const rs2 = await api(`/api/campaigns/${camp.id}/resend`, { method: 'POST', body: { subject: 'One more look', confirm_frequency: true } });
  assert.equal(rs2.status, 200);
  assert.equal(rs2.json.campaign.status, 'draft', '重发 = 新批次（未发）');
  assert.notEqual(rs2.json.campaign.discount.code, oldCode, '重发新码');
  assert.equal(rs2.json.campaign.reach_count, 18, '重发对象 = 已发未打开（本波打开回执未接）');

  // 暂停/恢复边界
  const p = await api(`/api/campaigns/${camp.id}/pause`, { method: 'POST', body: {} });
  assert.equal(p.json.campaign.status, 'paused');
  assert.equal(p.json.boundary, '已发 18 封不受影响，改的是未发的 14 封', '暂停也带边界声明');
  const r = await api(`/api/campaigns/${camp.id}/resume`, { method: 'POST', body: {} });
  assert.equal(r.json.campaign.status, 'draft');
});

test('C I4：建批默认排除已下单/已触达（净值=圈定−排除、明细逐条）；「别排除」→ 照发 + 审计留痕', async (t) => {
  const { api, dir } = await startServer(t, {
    configObj: { stores: [{ type: 'mock', shop: 'E2E' }], publicBaseUrl: 'https://e2e.example', shopBrand: 'MyBrand' }
  });
  const imp = await api('/api/audience/import', { method: 'POST', body: { csv: CSV_30 } });
  assert.equal(imp.status, 200);
  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const audRows = db.prepare('SELECT id, email FROM audience WHERE email LIKE ?').all('bulk%@test.com');
  assert.equal(audRows.length, 30);
  // ① 已下单（店铺订单事件）② 已触达（sends 实发表）
  db.prepare('INSERT INTO events (id, type, audience_id, ts) VALUES (?, ?, ?, ?)').run('ev_w3p', 'purchased', audRows[0].id, Date.now());
  db.prepare('INSERT INTO sends (id, campaign_id, recipient, status, at) VALUES (?, ?, ?, ?, ?)').run('snd_w3r', 'cmp_probe', audRows[1].email, 'sent', Date.now());
  db.close();

  const cr = await api('/api/campaigns', { method: 'POST', body: { batches: [{ audience_desc: '加购未付', offer_text: '10% off' }] } });
  const camp = cr.json.campaigns[0];
  assert.equal(camp.reach_count, 32, '净值 = 34 − 2（排除在出核对单之前完成）');
  const reasons = camp.excluded.map(x => x.reason);
  assert.ok(reasons.some(r => /已购买/.test(r)), '明细：已购买（已下单）');
  assert.ok(reasons.some(r => /已触达/.test(r)), '明细：已触达');
  for (const x of camp.excluded) assert.equal(x.count, 1, '逐条原因+人数');

  // 别排除，就要发 → 风险已提示（对话层），API 照建 + 审计留痕
  const ov = await api('/api/campaigns', { method: 'POST', body: { batches: [{ audience_desc: '加购未付', offer_text: '10% off' }], exclusion_override: true } });
  assert.equal(ov.json.campaigns[0].reach_count, 34, '覆盖后净值 = 圈定全量');
  assert.equal(ov.json.campaigns[0].exclusion_override, undefined, '覆盖标记不外泄（明细在 excluded）');
  const db3 = new DatabaseSync(path.join(dir, 'data.sqlite'));
  const audits = db3.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'audit'").get();
  db3.close();
  assert.equal(audits.n, 1, '覆盖留痕（审计事件，明细含 overridden 标记）');
});
