'use strict';
/**
 * lib/execution.js — Wave 2 方案与执行链的唯一权威（E2 / D3 / D4 / holdout / E3 时区）。
 *
 * 职责：
 *  - D3 planCard 服务端权威序列化：confirm 时由冻结 needs + 店铺回执产出唯一 planCard，
 *    并冻结 execution_snapshot（audience/reach_count/discount/estGmv 四字段口径）；
 *    卡面渲染与草稿渲染都读这一份（diff≠0 = P0 事故，闸门⑤前置拦截）。
 *  - E2 真实建码决策：offer 文案 → percent_off 解析；code 一律来自店铺连接器真实回执，
 *    禁止本地拼码（卡面绝不出现未真实存在的折扣码 —— 共同红线）。
 *  - D4 五道发送闸门：window(时段/E3 时区) / frequency(72h) / whitelabel(署名) /
 *    unsubscribe(退订检测，暂不拦截) / amount_code(金额与码核对)；阻断项不过给中文原因；
 *    时段闸不过 → 缓发（返回下一个合理时刻，非永久拒绝）；店铺校验超时 → 视为不过。
 *  - holdout 对照组：按 10% 从闸门过滤后的净值名单圈定（确定性哈希序），<200 人不冻结。
 *
 * 本模块零网络依赖：store / connector / config 以参数注入，时钟可注入（测试）。
 */

const crypto = require('crypto');
const {
  FREQUENCY_WINDOW_MS, HOLDOUT_RATIO, HOLDOUT_MIN_LIST,
  SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR,
  RECOVERY_RATE_REFERENCE, INDUSTRY_DEFAULT_AOV
} = require('./config');

/* --------------------------- 可注入时钟（E3 测试缝） --------------------------- */
let _clock = () => Date.now();
/** 测试注入时钟：setClock(() => fixedTs)；传 null 恢复真实时间 */
function setClock(fn) { _clock = typeof fn === 'function' ? fn : () => Date.now(); }
/** 支持环境变量覆盖（spawn 子进程 e2e 用）：CARTBACK_FAKE_NOW=<epoch ms> 只影响本模块的时段闸 */
function now() {
  const fake = process.env.CARTBACK_FAKE_NOW;
  if (fake && /^\d+$/.test(fake)) return Number(fake);
  return _clock();
}

/* ------------------------------ E3 时区/时段 ------------------------------ */
// 国家 → 代表性时区（覆盖连接器 normalizeLocale 的国家集；缺失回落跨境主力市场）
const COUNTRY_TZ = {
  US: 'America/New_York', CA: 'America/Toronto', GB: 'Europe/London', IE: 'Europe/Dublin',
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', ZA: 'Africa/Johannesburg',
  DE: 'Europe/Berlin', AT: 'Europe/Vienna', CH: 'Europe/Zurich',
  FR: 'Europe/Paris', BE: 'Europe/Brussels', LU: 'Europe/Luxembourg',
  ES: 'Europe/Madrid', MX: 'America/Mexico_City', AR: 'America/Argentina/Buenos_Aires',
  CO: 'America/Bogota', CL: 'America/Santiago', IT: 'Europe/Rome',
  PT: 'Europe/Lisbon', BR: 'America/Sao_Paulo', NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw', CZ: 'Europe/Prague', RU: 'Europe/Moscow', TR: 'Europe/Istanbul',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', CN: 'Asia/Shanghai', TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong',
  SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh',
  PH: 'Asia/Manila', ID: 'Asia/Jakarta', IN: 'Asia/Kolkata',
  AE: 'Asia/Dubai', SA: 'Asia/Riyadh'
};
const DEFAULT_TZ = 'America/New_York'; // 无国家/时区信息时的兜底（跨境主力市场；测试经 CARTBACK_FAKE_NOW 锚定）

/** 收件人时区解析链：r.timezone → country 映射 → 兜底（E3：按收件人时区发送） */
function tzForRecipient(recipient, fallbackTz = DEFAULT_TZ) {
  const r = recipient || {};
  const tz = String(r.timezone || '').trim();
  if (tz) return tz;
  const c = String(r.country || '').trim().toUpperCase();
  if (c && COUNTRY_TZ[c]) return COUNTRY_TZ[c];
  return fallbackTz;
}

/** 时区内当地时间小时（0-23）；非法时区回落 0（保守：永不判为合理时段） */
function localHourIn(tz, ts) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: '2-digit'
    }).formatToParts(new Date(ts));
    const h = Number((parts.find(p => p.type === 'hour') || {}).value);
    return Number.isFinite(h) ? h % 24 : 0;
  } catch (e) { return 0; }
}

function isReasonableHour(h) {
  return h >= SEND_WINDOW_START_HOUR && h < SEND_WINDOW_END_HOUR;
}

/** 下一个合理发送时刻：扫描未来 ≤25 小时，取收件人时区当地时间第一个 10:00 整点（窗口内安全点） */
function nextReasonableSendTime(tz, fromTs) {
  const start = Number(fromTs) || now();
  const targetHour = Math.min(SEND_WINDOW_START_HOUR + 1, SEND_WINDOW_END_HOUR - 1);
  for (let k = 1; k <= 25; k++) {
    const t = start + k * 3600 * 1000;
    if (localHourIn(tz, t) === targetHour) return t;
  }
  return start + 25 * 3600 * 1000; // 理论不可达；保底不再阻塞
}

/** 名单主流时区（众数；平票取字典序最小，保证确定性） */
function majorityTimezone(recipients) {
  const counts = new Map();
  for (const r of recipients || []) {
    const tz = tzForRecipient(r);
    counts.set(tz, (counts.get(tz) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [tz, n] of counts) {
    if (n > bestN || (n === bestN && tz < best)) { best = tz; bestN = n; }
  }
  return best || DEFAULT_TZ;
}

/* --------------------------- E2 offer → percent_off --------------------------- */
/**
 * 从 offer 槽文案解析折扣百分比（% off 口径，与 igde.discountNum 同规则）。
 * 返回 null = 非「折扣码/折扣百分比」型钩子（包邮/赠品/满减/无额外优惠…）→ E2 走无码分支。
 */
function parseOfferPercent(offer) {
  const t = String(offer || '');
  const zheM = t.match(/(\d+(?:\.\d+)?)\s*折/);
  if (zheM) {
    const zhe = parseFloat(zheM[1]);
    const norm = zhe > 10 ? zhe / 10 : zhe;   // 「85 折」= 8.5 折
    return +((10 - norm) * 10).toFixed(1);
  }
  const pctM = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctM) return +pctM[1];
  if (/(优惠码|折扣|coupon|promo|code)/i.test(t)) return 10; // 泛折扣表述 → 默认 10% off
  return null;
}

/** 从 offer 文案提取用户指定码名（「用专属优惠码 KEYBOARD12」→ KEYBOARD12） */
function parseOfferCodeName(offer) {
  const m = String(offer || '').match(/(?:code|码)\s*[^A-Za-z0-9]{0,6}([A-Za-z][A-Za-z0-9]{2,15})/i);
  return m ? m[1].toUpperCase() : null;
}

/* ------------------------------ D3 estGmv 公式 ------------------------------ */
/** 客单价：extras「客单价」解析（'35美元'→35）；缺失用行业默认并标参考估算（PRD D3） */
function parseAov(extras) {
  const entries = (Array.isArray(extras) ? extras : []).filter(e => e && ['客单价', 'aov'].includes(e.key));
  entries.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  for (const e of entries) {
    const m = String(e.value || '').match(/(\d+(?:\.\d+)?)/);
    if (m) return { aov: +m[1], source: 'store' };
  }
  return { aov: INDUSTRY_DEFAULT_AOV, source: 'reference' };
}

/**
 * estGmv = reach_count × 客单价 × 挽回率(12% 行业参考，标注) − 折扣成本(回流期望×折扣率)。
 * percentOff ≤ 0（无钩子）→ 折扣成本 0。source：store（extras 客单价）| reference（行业默认）。
 */
function computeEstGmv({ reachCount, aov, aovSource, percentOff }) {
  const people = Math.max(0, Number(reachCount) || 0);
  const price = Math.max(0, Number(aov) || 0);
  const rate = RECOVERY_RATE_REFERENCE;
  const expectedOrders = people * rate;
  const pct = Math.max(0, Number(percentOff) || 0);
  const discountCost = expectedOrders * price * (pct / 100);
  const amount = Math.max(0, +(expectedOrders * price - discountCost).toFixed(2));
  return {
    amount,
    currency: 'USD',
    formula: { people, aov: price, rate, discount_cost: +discountCost.toFixed(2) },
    source: aovSource === 'store' ? 'store' : 'reference'
  };
}

/** 草稿/邮件渲染管线的折扣数值（% off）：
 *  - card.discountNum 为有限数（≥0）→ 权威直用（0 = 无钩子方案，绝不虚报折扣）；
 *  - card.discount 为对象（Wave 2 planCard.discount）→ 读 percent_off；
 *  - 其余（旧卡文本/数字）→ parseFloat 兜底 → 默认 10。 */
function resolveDiscountNum(card) {
  if (!card) return 10;
  const dn = Number(card.discountNum);
  if (Number.isFinite(dn) && dn >= 0) return dn;
  if (card.discount && typeof card.discount === 'object') return Number(card.discount.percent_off) || 0;
  const p = parseFloat(card.discount);
  return Number.isFinite(p) && p > 0 ? p : 10;
}

/* --------------------------- D3 planCard 权威序列化 --------------------------- */
/**
 * 由 igde 基础卡（subject/body/posters/needs…）+ confirm 元数据合成服务端权威 planCard。
 * - discount 形状：{ text, code|null, code_status, percent_off, note? }（删 pain 旧键，reason 单键）。
 * - code 必须来自店铺连接器真实回执（E2 红线：卡面绝不出现未真实存在的折扣码）。
 */
function buildPlanCard({
  base, code = null, codeStatus = 'none', reachCount = 0, extras = [],
  brand = '', unsubscribeOk = false, draftId = null, note = null, sendWindowText = null, codeDefault = false
}) {
  const b = base || {};
  const status = ['created', 'reused', 'none', 'pending'].includes(codeStatus) ? codeStatus : 'none';
  const percentOff = (status === 'created' || status === 'reused') ? (Number(b.discountNum) || 0) : 0;
  const offerText = b.offer || '';
  let text;
  if (status === 'created' && codeDefault) text = `折扣码 ${code}（默认码 · 店铺未连接）`;
  else if (status === 'created') text = `折扣码 ${code}（已在你的店铺创建 ✅）`;
  else if (status === 'reused') text = `折扣码 ${code}（店内现成码，已校验有效）`;
  else if (status === 'pending') text = !offerText || /待定|未决定|再想/.test(offerText) ? '优惠尚未决定' : /无优惠|不放优惠|不打折|none/i.test(offerText) ? '无优惠（无需创建折扣码）' : /%|折/.test(offerText) ? `${offerText}（折扣码将在确认后创建）` : `${offerText}（准备时核对执行方式）`;
  else text = offerText && parseOfferPercent(offerText) == null ? offerText : '本方案无折扣码';
  const discount = { text, code: code || null, code_status: status, percent_off: percentOff };
  if (codeDefault) discount.default = true;   // 默认码标记：闸门⑤不要求店铺校验，卡面如实标注
  if (note) discount.note = note;
  const aovParsed = parseAov(extras);
  const estGmv = computeEstGmv({ reachCount, aov: aovParsed.aov, aovSource: aovParsed.source, percentOff });
  estGmv.note = '预估'; // PRD：estGmv 发送前标「预估」（发送后按实发口径结算）
  return {
    draft_id: draftId || null,
    audience: b.audience || '',
    reason: b.reason || '',                 // PRD v2：只留 reason（pain 旧键已删除）
    goal: b.goal || '',
    subject: b.subject || '',
    body: b.body || '',
    product: b.product || '', category: b.category || '', copy_warning: b.copy_warning || null,
    discount,
    discountNum: percentOff || b.discountNum || 0,  // 邮件文案用数值口径（无码方案为 0）
    coupon: code || '',                              // 草稿/mailgen 消费别名（= discount.code）
    brand: brand || '',                              // 草稿/mailgen 品牌链消费（= signature）
    posters: b.posters || [],
    sendTiming: b.sendTiming || null,
    reach_count: Math.max(0, Number(reachCount) || 0),
    estGmv,
    signature: brand || '',                          // ③ 白标：署名 = 商家品牌
    unsubscribe_ok: Boolean(unsubscribeOk),          // ④ 退订：URL 可解析 + List-Unsubscribe 头
    send_window: sendWindowText || `${String(SEND_WINDOW_START_HOUR).padStart(2, '0')}:00–${String(SEND_WINDOW_END_HOUR).padStart(2, '0')}:00 收件人当地时间`,
    language: b.locale || 'en',
    inferred_slots: b.inferred_slots || [],
    needs: b.needs || {},
    locale: b.locale || 'en',
    generatedAt: Date.now()
  };
}

/** confirm 冻结的四字段快照（闸门⑤ diff 的唯一依据；发送时草稿渲染参数与之逐字段比对） */
function serializeSnapshot(planCard) {
  return {
    audience: planCard.audience,
    reach_count: planCard.reach_count,
    discount: {
      text: planCard.discount.text,
      code: planCard.discount.code || null,
      code_status: planCard.discount.code_status,
      percent_off: planCard.discount.percent_off || 0,
      ...(planCard.discount.default ? { default: true } : {})
    },
    estGmv: planCard.estGmv,
    frozen_at: Date.now()
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 快照 ↔ 草稿 的可比视图（等价键归一：code null↔'' 视为相等；无码 percent 归一 0） */
function snapshotView(s) {
  return {
    audience: String((s && s.audience) || ''),
    reach_count: Number((s && s.reach_count) || 0),
    discount_code: (s && s.discount && s.discount.code) || null,
    discount_percent: (s && s.discount && s.discount.percent_off) || 0,
    est_gmv: round2(s && s.estGmv && s.estGmv.amount)
  };
}
function draftView(d) {
  return {
    audience: String((d && d.audience) || ''),
    reach_count: Number((d && d.matchedCount) || 0),
    discount_code: (d && d.coupon) || null,
    discount_percent: (Number(d && d.discount) || 0) || 0,
    est_gmv: round2(d && d.estGmv)
  };
}
const DIFF_LABEL = {
  audience: '受众', reach_count: '触达人数', discount_code: '折扣码',
  discount_percent: '折扣力度', est_gmv: '预估 GMV'
};
/** D3 diff：草稿渲染参数 vs 快照逐字段比对；返回不等字段 key 数组（空 = diff=0） */
function diffSnapshot(snapshot, draft) {
  if (!snapshot) return { ok: false, fields: ['snapshot'], views: null };
  const a = snapshotView(snapshot);
  const b = draftView(draft);
  const fields = Object.keys(a).filter(k => a[k] !== b[k]);
  return { ok: fields.length === 0, fields, views: { snapshot: a, draft: b } };
}

/* --------------------------- D4② 72h 频控（窗口单处常量） --------------------------- */
/**
 * 频控：同收件人同活动（受众口径）72h 内不重发（PRD §3.4；窗口常量在 lib/config.js，
 * 「PRD 口径 7 天，挂起裁决先不动 72h」）。按商家（user_id）隔离。
 * retryAt：全员被触达时，最早解除频控的时刻（= 被触达收件人中最早上次触达 + 窗口），
 * 供闸门②「自动预约到未来时段发送」；未全员触达时为 null。
 */
function frequencyFilter(store, recipients, draft, opts = {}) {
  const windowMs = opts.windowMs || FREQUENCY_WINDOW_MS;
  const at = opts.clock ? opts.clock() : now();
  const cutoff = at - windowMs;
  const campaignKey = (draft.audience || '').toLowerCase();
  const emailedEvents = store.getEvents().filter(e => e.type === 'emailed' && e.ts >= cutoff);
  const draftsById = new Map(store.getDrafts().map(d => [d.id, d]));
  const lastTouch = new Map();   // audience_id -> 72h 内最后触达时刻
  for (const e of emailedEvents) {
    const d = draftsById.get(e.draft_id);
    const touch = e.touch_scope || d;
    if (!touch || (touch.audience || '').toLowerCase() !== campaignKey) continue;
    if ((touch.user_id || null) !== (draft.user_id || null)) continue;
    const prev = lastTouch.get(e.audience_id) || 0;
    if (e.ts > prev) lastTouch.set(e.audience_id, e.ts);
  }
  const allow = recipients.filter(r => !lastTouch.has(r.id));
  const skipped = recipients.length - allow.length;
  let retryAt = null;
  if (recipients.length > 0 && allow.length === 0 && skipped > 0) {
    let earliest = Infinity;
    for (const r of recipients) {
      const t = lastTouch.get(r.id);
      if (t && t < earliest) earliest = t;
    }
    if (earliest !== Infinity) retryAt = earliest + windowMs;
  }
  return { allow, skipped, retryAt };
}

/* --------------------------- holdout 对照组圈定（J3 前置子集） --------------------------- */
function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email || '').toLowerCase()).digest('hex');
}
/**
 * 从净值名单确定性圈定 10%（sha256(email) 排序取前 N；confirm 预览与 send 冻结两次调用结果一致）。
 * 名单 < 200 人不冻结（PRD：名单 < 200 人不冻）。
 */
function selectHoldout(recipients, ratio = HOLDOUT_RATIO) {
  const list = (recipients || []).filter(r => r && r.email).map(r => ({ email: String(r.email).toLowerCase(), id: r.id }));
  if (list.length < HOLDOUT_MIN_LIST) {
    return { frozen: false, count: 0, members: [], ratio, note: `名单 ${list.length} 人不足 ${HOLDOUT_MIN_LIST}，本轮不冻结对照组` };
  }
  const count = Math.max(1, Math.floor(list.length * ratio));
  const sorted = list.slice().sort((a, b) => (hashEmail(a.email).localeCompare(hashEmail(b.email)) || a.email.localeCompare(b.email)));
  const members = sorted.slice(0, count).map(m => m.email);
  return { frozen: true, count, members, ratio, note: null };
}

/* ------------------------------ D4 五道发送闸门 ------------------------------ */
/** 闸门 reason 里的时刻展示（MM-dd HH:mm，24h 制） */
function fmtGateTime(t) {
  if (!Number.isFinite(Number(t))) return '稍后';
  const d = new Date(Number(t));
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const GATE_LABELS = {
  window: '时段（收件人当地时间合理时段）',
  frequency: '频次（72 小时内未被触达）',
  whitelabel: '白标（署名为商家品牌）',
  unsubscribe: '退订（链接可解析 + List-Unsubscribe 头）',
  amount_code: '金额与码核对（草稿与方案卡 diff=0，码真实存在）'
};
const GATE_ORDER = ['window', 'frequency', 'whitelabel', 'unsubscribe', 'amount_code'];

/**
 * 五道闸门评估（confirm 预检与 send 重跑共用同一实现）。
 * @param {object} o
 *   act / draft / store / config / connector（可 null） / recipients（有效收件人名单）
 * @returns {{items, all_pass, net, skippedByFrequency, windowRetryAt, holdoutPlan}}
 *   items 恒 5 项 {gate,label,pass,reason?}；windowRetryAt 仅时段闸不过时有值（缓发目标时刻）
 */
async function evaluateChecklist(o = {}) {
  const { act, draft, store, config, connector } = o;
  const recipients = (o.recipients || []).filter(r => r && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || ''));
  const at = now();

  // ① 时段（E3）：名单主流时区当地时间须在合理窗口内；不过 → 缓发
  const tz = majorityTimezone(recipients.length ? recipients : [{ timezone: o.fallbackTz }]);
  const hour = localHourIn(tz, at);
  const windowPass = recipients.length > 0 && isReasonableHour(hour);
  const windowRetryAt = windowPass ? null : nextReasonableSendTime(tz, at);
  const items = [{
    gate: 'window', label: GATE_LABELS.window, pass: windowPass,
    ...(windowPass ? {} : { reason: `收件人主流时区（${tz}）当地时间 ${String(hour).padStart(2, '0')}:00 不在合理发送时段（${String(SEND_WINDOW_START_HOUR).padStart(2, '0')}:00–${String(SEND_WINDOW_END_HOUR).padStart(2, '0')}:00），将缓发到下一合理时段` })
  }];

  // ② 频次：72h 内未被触达（触达过的剔除出净值名单）。
  //    无触达记录不判「已被触达」（修 0 人名单误报）；全员被触达不再硬拒，
  //    改为自动预约：retryAt = 最早解除频控时刻，闸门语义与时段缓发一致。
  const freq = frequencyFilter(store, recipients, draft, { clock: now });
  const freqPass = freq.allow.length > 0 || freq.skipped === 0;
  const freqRetryAt = (!freqPass && freq.retryAt) ? freq.retryAt : null;
  items.push({
    gate: 'frequency', label: GATE_LABELS.frequency, pass: freqPass,
    ...(freqPass
      ? (freq.skipped ? { reason: `${freq.skipped} 名收件人 72 小时内已被触达，已剔除出本轮名单` } : {})
      : { reason: `这批收件人 72 小时内已被同场活动触达，将自动预约到 ${fmtGateTime(freq.retryAt)} 解除频控后发送`, retryAt: freq.retryAt })
  });

  // ③ 白标：署名 = 商家品牌（草稿创建时已解析固化；'CartBack' = 工具默认名 → 未白标）
  const brand = String((draft && draft.brand) || '').trim();
  const wlPass = Boolean(brand) && brand !== 'CartBack';
  items.push({
    gate: 'whitelabel', label: GATE_LABELS.whitelabel, pass: wlPass,
    ...(wlPass ? {} : { reason: '还未设置商家品牌，署名会显示工具默认名「CartBack」。去设置页填品牌名，或在对话里告诉我们品牌名' })
  });

  // ④ 退订：保留实际检测结果；按当前产品要求暂不作为发送阻断项。
  const unsubOk = Boolean(config && config.publicBaseUrl) && Boolean(draft && draft.id);
  items.push({
    gate: 'unsubscribe', label: GATE_LABELS.unsubscribe, pass: unsubOk, blocking: false,
    ...(unsubOk ? {} : { reason: '未配置对外公网基址（publicBaseUrl），退订链接无法解析、List-Unsubscribe 头不可用' })
  });

  // ⑤ 金额与码核对：草稿与快照 diff=0；code_status=created/reused 须店铺校验真实存在；none 只校验 diff
  const snapshot = act && act.execution_snapshot;
  const codeStatus = snapshot && snapshot.discount ? snapshot.discount.code_status : null;
  const code = snapshot && snapshot.discount ? snapshot.discount.code : null;
  let amountReason = null;
  let amountPass = true;
  if (!snapshot) {
    amountPass = false;
    amountReason = '方案快照缺失或已作废（配置可能已改动），请回到对话重新确认方案';
  } else {
    const diff = diffSnapshot(snapshot, draft);
    if (!diff.ok) {
      amountPass = false;
      amountReason = `草稿与方案卡快照不一致（${diff.fields.map(f => DIFF_LABEL[f] || f).join('、')}），已按 P0 事故拦截`;
    } else if (codeStatus === 'none') {
      amountReason = '本方案无折扣码'; // pass + 标注
    } else if (snapshot.discount && snapshot.discount.default) {
      // 默认码（店铺未连接时出的品牌+折扣+OFF 码）：不要求店铺校验，如实标注即可
      amountReason = `默认码 ${code}（店铺未连接）；连接店铺后建议替换为真实店铺券`; // pass + 标注
    } else if (!connector || !connector.supportsDiscountCodes || !connector.supportsDiscountCodes()) {
      amountPass = false;
      amountReason = '店铺未连接，无法校验折扣码真实存在（宁缓发不错发）';
    } else {
      try {
        const hit = await connector.verifyDiscountCode(code);
        if (!hit) {
          amountPass = false;
          amountReason = `折扣码 ${code} 未在你的店铺中找到，不能发送（宁缓发不错发）`;
        } else if (!Number.isFinite(Number(hit.percent_off)) || hit.percent_off == null || Number(hit.percent_off) !== Number(snapshot.discount.percent_off)) {
          amountPass = false;
          amountReason = '店铺券的优惠力度与已确认方案不一致或无法核实，请重新准备并核对优惠后再发送';
        }
      } catch (e) {
        amountPass = false; // 店铺 API 校验超时/失败 → 视为不过（宁缓发不错发）
        amountReason = '店铺校验折扣码失败或超时，为稳妥起见本轮不发（宁缓发不错发）';
      }
    }
  }
  items.push({ gate: 'amount_code', label: GATE_LABELS.amount_code, pass: amountPass, ...(amountReason ? { reason: amountReason } : {}) });

  const net = freq.allow;
  const holdoutPlan = selectHoldout(net, (config && config.holdoutRatio) || HOLDOUT_RATIO);
  return {
    items: GATE_ORDER.map(g => items.find(i => i.gate === g)), // 恒 5 项、固定顺序
    all_pass: items.every(i => i.pass || i.blocking === false),
    net,
    skippedByFrequency: freq.skipped,
    windowRetryAt,
    freqRetryAt,
    holdoutPlan,
    timezone: tz
  };
}

module.exports = {
  // 时钟
  setClock, now,
  // E3 时区/时段
  COUNTRY_TZ, DEFAULT_TZ, tzForRecipient, localHourIn, isReasonableHour,
  nextReasonableSendTime, majorityTimezone,
  // E2 建码
  parseOfferPercent, parseOfferCodeName,
  // D3 estGmv / planCard / 快照
  parseAov, computeEstGmv, resolveDiscountNum,
  buildPlanCard, serializeSnapshot, diffSnapshot, snapshotView, draftView,
  // 频控 / holdout / 闸门
  frequencyFilter, selectHoldout, evaluateChecklist,
  GATE_LABELS, GATE_ORDER,
  // 常量再出口（测试便利）
  HOLDOUT_RATIO, HOLDOUT_MIN_LIST, SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR, RECOVERY_RATE_REFERENCE
};
