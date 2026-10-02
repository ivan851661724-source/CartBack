'use strict';
/**
 * Wave 2 方案与执行链单测（lib/execution.js + store sends/holdouts + queue run_after + 旧 act 兼容）：
 *   D3 planCard 权威形状 / estGmv 公式 / execution_snapshot 四字段 diff（篡改拦截）
 *   D4 五道闸门逐项独立触发（时段用可注入时钟 / 频次灌 72h 记录 / 白标 / 退订 / 码不存在·超时）
 *   E2 offer→percent 解析 / E3 时区与下一个合理时段 / holdout 圈定（≥200 冻 10%，<200 不冻）
 *   sends 实发流水幂等（重试不追加新行）/ 队列 run_after 缓发 / 旧数据 confirm 走迁移后快照
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execution = require('../lib/execution');
const { Store } = require('../lib/store');
const { JobQueue } = require('../lib/queue');
const { IGDE } = require('../lib/igde');
const { MockConnector } = require('../lib/storeConnector');

// —— 固定时钟：2026-01-01T15:00:00Z = 纽约（冬季 UTC-5）10:00 —— 合理时段内
const IN_WINDOW_TS = Date.UTC(2026, 0, 1, 15, 0, 0);
// 2026-01-01T03:00:00Z = 纽约 22:00 —— 窗口外
const OUT_WINDOW_TS = Date.UTC(2026, 0, 1, 3, 0, 0);

function tmpStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-' + label + '-'));
  const store = new Store({ dbFile: path.join(dir, 'data.sqlite') });
  store.init();
  store._write('audience', []); // 清种子，测试自带名单
  return store;
}

const CODE_CONNECTOR = {
  type: 'mock',
  supportsDiscountCodes() { return true; },
  async verifyDiscountCode(code) { return code === 'CODE1' ? { code: 'CODE1', percent_off: 10 } : null; }
};

function basePlanCardBase() {
  return {
    audience: '加购未付客户',
    reason: '太久没动静、快被遗忘',
    goal: '促使完成付款 / 结账',
    offer: '10% off',
    subject: 'Your order is waiting',
    body: 'Hi',
    discount: '10% off',
    discountNum: 10,
    posters: [],
    sendTiming: '30–60 分钟内发送',
    inferred_slots: [],
    needs: { audience: '加购未付客户', reason: '太久没动静、快被遗忘', goal: '促使完成付款 / 结账', offer: '10% off' },
    locale: 'en'
  };
}

function makeAct(snapshotOpts = {}) {
  const card = execution.buildPlanCard({
    base: basePlanCardBase(),
    code: snapshotOpts.code !== undefined ? snapshotOpts.code : 'CODE1',
    codeStatus: snapshotOpts.codeStatus || 'created',
    reachCount: 9,
    extras: [{ key: '客单价', value: '35美元' }],
    brand: 'MyBrand',
    unsubscribeOk: true,
    draftId: 'dr_t'
  });
  return {
    id: 'act_t', stage: 'S3', code_status: snapshotOpts.codeStatus || 'created',
    execution_snapshot: execution.serializeSnapshot(card),
    plan_card: card
  };
}

function makeDraft(patch = {}) {
  return Object.assign({
    id: 'dr_t', act_id: 'act_t', audience: '加购未付客户', matchedCount: 9,
    // estGmv 与 makeAct 快照同源：9 人 × 客单价 35 × 12% = 37.8，折扣成本 3.78 → 34.02
    discount: 10, coupon: 'CODE1', estGmv: 34.02, brand: 'MyBrand', user_id: 'u1'
  }, patch);
}

function makeRecipients(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'aud_' + i, email: `p${i}@example.com`, intent: '加购未付', locale: 'en'
  }));
}

async function runGates(store, { act, draft, config, connector, recipients, clock }) {
  execution.setClock(clock || (() => IN_WINDOW_TS));
  try {
    return await execution.evaluateChecklist({
      act: act || makeAct(),
      draft: draft || makeDraft(),
      store,
      config: config || { publicBaseUrl: 'https://x.example' },
      connector: connector === undefined ? CODE_CONNECTOR : connector,
      recipients: recipients || makeRecipients(9)
    });
  } finally {
    execution.setClock(null);
  }
}

test('E2：parseOfferPercent / parseOfferCodeName（offer → percent_off 唯一口径）', () => {
  assert.equal(execution.parseOfferPercent('10% off'), 10);
  assert.equal(execution.parseOfferPercent('给 12% off'), 12);
  assert.equal(execution.parseOfferPercent('8折'), 20);        // 8 折 = 20% off
  assert.equal(execution.parseOfferPercent('85折'), 15);       // 8.5 折 = 15% off
  assert.equal(execution.parseOfferPercent('专属优惠码'), 10);  // 泛折扣 → 默认 10
  assert.equal(execution.parseOfferPercent('包邮'), null);      // 非折扣型钩子
  assert.equal(execution.parseOfferPercent('无额外优惠'), null);
  assert.equal(execution.parseOfferPercent('满300减50'), null);
  assert.equal(execution.parseOfferCodeName('用我店里现成的优惠码 KEYBOARD12'), 'KEYBOARD12');
  assert.equal(execution.parseOfferCodeName('给点折扣'), null);
});

test('D3：estGmv 公式（reach × 客单价 × 12% − 折扣成本）与客单价来源标注', () => {
  const storeAov = execution.parseAov([{ key: '客单价', value: '35美元' }]);
  assert.deepEqual(storeAov, { aov: 35, source: 'store' });
  const demoAov = execution.parseAov([]);
  assert.deepEqual(demoAov, { aov: 45, source: 'demo' });

  const g1 = execution.computeEstGmv({ reachCount: 200, aov: 35, aovSource: 'store', percentOff: 10 });
  // 期望订单 = 200×12% = 24；GMV = 24×35 = 840；折扣成本 = 24×35×10% = 84；净 756
  assert.equal(g1.amount, 756);
  assert.deepEqual(g1.formula, { people: 200, aov: 35, rate: 0.12, discount_cost: 84 });
  assert.equal(g1.currency, 'USD');
  assert.equal(g1.source, 'store');
  const g2 = execution.computeEstGmv({ reachCount: 200, aov: 45, aovSource: 'demo', percentOff: 0 });
  assert.equal(g2.amount, 1080); // 无钩子：无折扣成本
  assert.equal(g2.formula.discount_cost, 0);
  assert.equal(g2.source, 'demo');
});

test('D3：planCard 权威形状（pain 旧键已删、reason 单键、discount 对象、estGmv 结构）', () => {
  const card = execution.buildPlanCard({
    base: basePlanCardBase(), code: 'COMEBACK-AB12C3', codeStatus: 'created',
    reachCount: 9, extras: [{ key: '客单价', value: '35美元' }],
    brand: 'MyBrand', unsubscribeOk: true, draftId: 'dr_x'
  });
  // 契约键
  for (const k of ['draft_id', 'audience', 'reach_count', 'discount', 'estGmv', 'signature', 'unsubscribe_ok', 'send_window', 'language', 'inferred_slots']) {
    assert.ok(k in card, 'planCard 应含 ' + k);
  }
  assert.equal('pain' in card, false, 'pain 旧键必须删除');
  assert.deepEqual(card.discount, {
    text: '折扣码 COMEBACK-AB12C3（已在你的店铺创建 ✅）',
    code: 'COMEBACK-AB12C3', code_status: 'created', percent_off: 10
  });
  assert.equal(card.coupon, 'COMEBACK-AB12C3');
  assert.equal(card.reason, '太久没动静、快被遗忘');
  assert.equal(card.signature, 'MyBrand');
  assert.equal(card.unsubscribe_ok, true);
  assert.equal(card.draft_id, 'dr_x');
  assert.equal(card.estGmv.amount, 34.02); // 9×35×12% = 37.8 − 折扣成本 3.78 = 34.02
  assert.deepEqual(card.estGmv.formula, { people: 9, aov: 35, rate: 0.12, discount_cost: 3.78 });
  assert.equal(card.estGmv.source, 'store');
});

test('E2 红线：无码状态卡面绝不出现假码（none/pending 文案口径）', () => {
  const none = execution.buildPlanCard({ base: basePlanCardBase(), code: null, codeStatus: 'none', reachCount: 9, extras: [], brand: 'B' });
  assert.equal(none.discount.code, null);
  assert.equal(none.discount.text, '本方案无折扣码');
  assert.equal(none.coupon, '');
  const pending = execution.buildPlanCard({ base: basePlanCardBase(), code: null, codeStatus: 'pending', reachCount: 9, extras: [], brand: 'B' });
  assert.equal(pending.discount.code, null);
  assert.ok(/确认后创建/.test(pending.discount.text));
  assert.ok(!/COMEBACK-/i.test(JSON.stringify(pending)), '预览卡不得出现本地拼的码');
});

test('D3：execution_snapshot ↔ 草稿 diff=0；篡改任一字段被逐项捕获', () => {
  const act = makeAct();
  const snap = act.execution_snapshot;
  const clean = execution.diffSnapshot(snap, makeDraft());
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.fields, []);

  for (const [patch, field] of [
    [{ estGmv: 999 }, 'est_gmv'],
    [{ coupon: 'OTHER' }, 'discount_code'],
    [{ matchedCount: 8 }, 'reach_count'],
    [{ discount: 15 }, 'discount_percent'],
    [{ audience: '老客' }, 'audience']
  ]) {
    const r = execution.diffSnapshot(snap, makeDraft(patch));
    assert.equal(r.ok, false, '篡改 ' + field + ' 必须拦截');
    assert.deepEqual(r.fields, [field]);
  }
  assert.equal(execution.diffSnapshot(null, makeDraft()).ok, false, '快照缺失 = 拦截');
});

test('E3：时区解析 + 合理时段 + 下一个合理时刻（可注入时钟）', () => {
  assert.equal(execution.localHourIn('UTC', Date.UTC(2026, 0, 1, 4, 0)), 4);
  assert.equal(execution.localHourIn('Asia/Shanghai', Date.UTC(2026, 0, 1, 4, 0)), 12);
  assert.equal(execution.tzForRecipient({ country: 'DE' }), 'Europe/Berlin');
  assert.equal(execution.tzForRecipient({ timezone: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(execution.tzForRecipient({}), execution.DEFAULT_TZ);
  assert.equal(execution.majorityTimezone([{ country: 'DE' }, { country: 'DE' }, { country: 'JP' }]), 'Europe/Berlin');

  const next = execution.nextReasonableSendTime('UTC', Date.UTC(2026, 0, 1, 23, 0));
  assert.equal(execution.localHourIn('UTC', next), 10, '缓发目标 = 当地 10:00（窗口内安全点）');
  assert.ok(next > Date.UTC(2026, 0, 1, 23, 0));
  assert.ok(next - Date.UTC(2026, 0, 1, 23, 0) <= 25 * 3600 * 1000, '25 小时内必有下一个合理时段（非永久拒绝）');
});

test('D4① 时段闸：窗口内通过；窗口外拦截并给出缓发时刻（可注入时钟）', async () => {
  const store = tmpStore('window');
  const ok = await runGates(store, { clock: () => IN_WINDOW_TS });
  assert.equal(ok.items.find(i => i.gate === 'window').pass, true);
  assert.equal(ok.windowRetryAt, null);

  const night = await runGates(store, { clock: () => OUT_WINDOW_TS });
  const w = night.items.find(i => i.gate === 'window');
  assert.equal(w.pass, false);
  assert.ok(/不在合理发送时段/.test(w.reason));
  assert.ok(night.windowRetryAt > OUT_WINDOW_TS, '时段闸不过 → 缓发（非永久拒绝）');
});

test('D4② 频次闸：72h 内灌 emailed 记录 → 全被剔除则拦截；常量单处 72h', async () => {
  // 事件时间基与注入时钟同基（evaluateChecklist 内 frequencyFilter 用同一时钟）
  const store = tmpStore('freq');
  store.upsertDraft({ id: 'dr_prev', audience: '加购未付客户', user_id: 'u1' });
  for (const r of makeRecipients(9)) {
    store.addEvent({ type: 'emailed', draft_id: 'dr_prev', audience_id: r.id, ts: IN_WINDOW_TS - 3600 * 1000 });
  }
  const capped = await runGates(store, { clock: () => IN_WINDOW_TS });
  const f = capped.items.find(i => i.gate === 'frequency');
  assert.equal(f.pass, false);
  assert.ok(/72 小时/.test(f.reason));
  assert.equal(capped.net.length, 0);

  // 窗口外（>72h）的同活动触达不拦截
  const store2 = tmpStore('freq2');
  store2.upsertDraft({ id: 'dr_prev', audience: '加购未付客户', user_id: 'u1' });
  for (const r of makeRecipients(9)) {
    store2.addEvent({ type: 'emailed', draft_id: 'dr_prev', audience_id: r.id, ts: IN_WINDOW_TS - 73 * 3600 * 1000 });
  }
  const open = await runGates(store2, { clock: () => IN_WINDOW_TS });
  assert.equal(open.items.find(i => i.gate === 'frequency').pass, true);
});

test('D4③④ 白标/退订闸：品牌缺省（CartBack）与 publicBaseUrl 缺失各自独立拦截', async () => {
  const store = tmpStore('wl');
  const noBrand = await runGates(store, { draft: makeDraft({ brand: 'CartBack' }) });
  const wl = noBrand.items.find(i => i.gate === 'whitelabel');
  assert.equal(wl.pass, false);
  assert.ok(/品牌/.test(wl.reason));

  const noUnsub = await runGates(store, { config: { publicBaseUrl: '' } });
  const u = noUnsub.items.find(i => i.gate === 'unsubscribe');
  assert.equal(u.pass, false);
  assert.ok(/publicBaseUrl/.test(u.reason));

  // 其余闸不受影响（可独立定位失败项）
  assert.equal(noBrand.items.find(i => i.gate === 'unsubscribe').pass, true);
  assert.equal(noUnsub.items.find(i => i.gate === 'whitelabel').pass, true);
});

test('D4⑤ 金额与码闸：diff 篡改 / 码不存在 / 店铺校验超时 / 无码标注', async () => {
  const store = tmpStore('amount');

  // diff 篡改（人为篡改草稿 estGmv → P0 拦截）
  const tampered = await runGates(store, { draft: makeDraft({ estGmv: 999.99 }) });
  const t = tampered.items.find(i => i.gate === 'amount_code');
  assert.equal(t.pass, false);
  assert.ok(/预估 GMV/.test(t.reason));

  // 码不存在（店铺查无此码：快照与草稿一致、但店铺核销无此码）
  const emptyShop = {
    supportsDiscountCodes() { return true; },
    async verifyDiscountCode() { return null; }
  };
  const missing = await runGates(store, { connector: emptyShop });
  const m = missing.items.find(i => i.gate === 'amount_code');
  assert.equal(m.pass, false);
  assert.ok(/未在你的店铺中找到/.test(m.reason));

  // 店铺校验超时/异常 → 视为不过（宁缓发不错发）
  const throwing = {
    supportsDiscountCodes() { return true; },
    async verifyDiscountCode() { throw new Error('upstream timeout'); }
  };
  const timeout = await runGates(store, { connector: throwing });
  assert.equal(timeout.items.find(i => i.gate === 'amount_code').pass, false);
  assert.ok(/宁缓发不错发/.test(timeout.items.find(i => i.gate === 'amount_code').reason));

  // 店铺未连接 + 有码方案 → 拦截
  const noShop = await runGates(store, { connector: null });
  assert.equal(noShop.items.find(i => i.gate === 'amount_code').pass, false);

  // 无钩子方案（none）：只校验 diff，pass 并标注「本方案无折扣码」
  const noneAct = makeAct({ code: null, codeStatus: 'none' });
  const noneDraft = makeDraft({ coupon: '', discount: 0, estGmv: noneAct.execution_snapshot.estGmv.amount });
  const none = await runGates(store, { act: noneAct, draft: noneDraft, connector: null });
  const n = none.items.find(i => i.gate === 'amount_code');
  assert.equal(n.pass, true);
  assert.equal(n.reason, '本方案无折扣码');
});

test('D4：五道闸全过 → items 恒 5 项、固定顺序、all_pass', async () => {
  const store = tmpStore('all');
  const r = await runGates(store, {});
  assert.deepEqual(r.items.map(i => i.gate), ['window', 'frequency', 'whitelabel', 'unsubscribe', 'amount_code']);
  assert.equal(r.items.length, 5);
  assert.equal(r.all_pass, true);
  assert.ok(r.net.length === 9);
});

test('holdout：≥200 名单冻 10%（确定性、可复现）；<200 不冻', () => {
  const big = makeRecipients(250).map(r => ({ email: r.email }));
  const h1 = execution.selectHoldout(big);
  assert.equal(h1.frozen, true);
  assert.equal(h1.count, 25);           // 250 × 10%
  assert.equal(h1.ratio, 0.1);
  assert.equal(h1.members.length, 25);
  const h2 = execution.selectHoldout(big);
  assert.deepEqual(h1.members, h2.members, 'confirm 预览与 send 冻结两次圈定结果一致（确定性哈希序）');

  const small = execution.selectHoldout(makeRecipients(199).map(r => ({ email: r.email })));
  assert.equal(small.frozen, false);
  assert.equal(small.count, 0);
  assert.ok(/不足/.test(small.note));
});

test('sends 实发流水：幂等键 campaign+recipient，重试不追加新行；holdouts 冻结幂等', () => {
  const store = tmpStore('sends');
  const row = { act_id: 'act_t', campaign_id: 'dr_t', recipient: 'A@Example.com', template: 'discount', tag: '加购未付', code: 'CODE1', tz: 'America/New_York', gate_snapshot: { all_pass: true }, status: 'sent' };
  store.recordSendRow(row);
  store.recordSendRow({ ...row, status: 'failed' });   // 重试同键 → 更新不追加
  const rows = store.getSends({ campaign_id: 'dr_t' });
  assert.equal(rows.length, 1, '同 (campaign_id, recipient) 只有一行');
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].recipient, 'a@example.com');
  assert.deepEqual(rows[0].gate_snapshot, { all_pass: true });

  const f1 = store.freezeHoldouts({ act_id: 'act_t', campaign_id: 'dr_t', recipients: ['a@x.com', 'b@x.com'], ratio: 0.1, source: 'single_plan' });
  const f2 = store.freezeHoldouts({ act_id: 'act_t', campaign_id: 'dr_t', recipients: ['a@x.com', 'c@x.com'], ratio: 0.1, source: 'single_plan' });
  assert.deepEqual(f1.members.sort(), ['a@x.com', 'b@x.com']);
  assert.deepEqual(f2.members, ['c@x.com'], '已冻结成员不覆盖、新成员追加');
  assert.equal(store.getHoldouts({ campaign_id: 'dr_t' }).length, 3);
  // 对照成员绝不写入 sends（表隔离）
  assert.equal(store.getSends({ campaign_id: 'dr_t' }).some(r => store.getHoldouts({ campaign_id: 'dr_t' }).some(h => h.recipient === r.recipient)), false);
});

test('queue：run_after 定时任务不到点不执行、到点自动执行（时段闸缓发机制）', async () => {
  const store = tmpStore('queue');
  const ran = [];
  const q = new JobQueue({ store, concurrency: 1, baseDelayMs: 10, maxRetries: 0 });
  q.register('t', async ({ payload }) => { ran.push(payload.n); return { n: payload.n }; });
  q.enqueue({ type: 't', payload: { n: 'later' }, runAfter: Date.now() + 500 });
  q.enqueue({ type: 't', payload: { n: 'now' } });
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(ran, ['now'], '未到点的任务不执行，即时任务不被压住');
  await new Promise(r => setTimeout(r, 700));
  assert.deepEqual(ran, ['now', 'later'], '到点后自动执行');
  q.stop();
});

test('旧 act 兼容：老数据（纯字符串 needs + pain 槽）读出迁移后可走 confirm 快照链路', () => {
  const store = tmpStore('legacy');
  store.upsertAct({
    id: 'act_old', stage: 'S2',
    needs: { audience: '加购未付客户', pain: '忘了结账' },  // 旧契约：纯字符串 + pain 槽
    messages: [], status: 'active', created_at: 1, updated_at: 1
  });
  const act = store.getAct('act_old');   // 读出即迁移（三态槽 + pain→reason + code_status/filled_count 兜底）
  assert.equal(act.needs.audience.value, '加购未付客户');
  assert.equal(act.needs.reason.value, '忘了结账', 'pain → reason 迁移');
  assert.equal(act.code_status, 'none');

  const igde = new IGDE({});
  const base = igde.producePlanCard(act, { locale: 'en' });  // confirm 内部第一步
  assert.equal(base.reason, '忘了结账');
  assert.equal(base.coupon, undefined, '基础卡不再带本地拼码');
  const card = execution.buildPlanCard({
    base, code: null, codeStatus: 'none',
    reachCount: 3, extras: act.memory.extras, brand: 'MyBrand', unsubscribeOk: true, draftId: 'dr_old'
  });
  const snap = execution.serializeSnapshot(card);
  assert.equal(snap.audience, '加购未付客户');
  assert.equal(snap.discount.code_status, 'none');
  const draftLike = { audience: card.audience, matchedCount: 3, coupon: '', discount: 0, estGmv: card.estGmv.amount };
  assert.equal(execution.diffSnapshot(snap, draftLike).ok, true, '迁移后快照与草稿 diff=0');
});

test('E2：MockConnector 建码/验码注入缝（回执权威、重复建码失败、createFails 开关）', async () => {
  const mock = new MockConnector({ shop: 'T', codes: { SAVE10: { percent_off: 10 } } });
  assert.equal(mock.supportsDiscountCodes(), true);
  const hit = await mock.verifyDiscountCode('save10');
  assert.equal(hit.code, 'SAVE10');
  const created = await mock.createDiscountCode({ code: 'comeback-ab12c3', percent_off: 12 });
  assert.equal(created.code, 'COMEBACK-AB12C3', '回执码大写返回');
  assert.equal((await mock.verifyDiscountCode('COMEBACK-AB12C3')).percent_off, 12);
  await assert.rejects(() => mock.createDiscountCode({ code: 'COMEBACK-AB12C3', percent_off: 12 }), /已存在/);
  const failing = new MockConnector({ shop: 'T', createFails: true });
  await assert.rejects(() => failing.createDiscountCode({ code: 'X1', percent_off: 10 }), /建码失败/);
});
