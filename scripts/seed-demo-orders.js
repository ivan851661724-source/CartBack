'use strict';
/**
 * 演示数据种子：给指定账号造一批「已发送 → 打开/点击 → 转化/退款」事件，
 * 让数据看板呈现非零漏斗与两类订单状态（有效转化 / 已退款扣减）。
 *
 * 用法：node scripts/seed-demo-orders.js [userId]
 *   userId 缺省 = 本地管理员（admin@local，本地免登录会话的归属锚点）。
 *
 * 口径对齐（store.getKpis / getEvents 的可见性规则）：
 *  - drafts.user_id / events.user_id = 目标账号（跨用户/无归属事件对方不可见）；
 *  - esp_message_id 留空 —— 以 sim_ 开头的草稿其事件会被 getEvents() 过滤；
 *  - convert.ts 落在 sent_at 后 7 天归因窗口内，且 sent_at 分布在近 6 天（近 7 日趋势可见）；
 *  - 已退款单 = convert 事件 value 清零 + refunded=1（与 orders/update 退款路径一致）。
 */
const path = require('path');
const crypto = require('crypto');

process.chdir(path.join(__dirname, '..', 'backend'));
const { Store } = require('../backend/lib/store');

const store = new Store();
store.init();

const TARGET_USER = process.argv[2] || (() => {
  const admin = store.getUserByEmail('admin@local');
  if (!admin) throw new Error('找不到 admin@local，请先启动一次后端完成初始化');
  return admin.id;
})();

const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const now = Date.now();
const DAY = 86400000;
const at = (daysAgo, hoursLater) => now - daysAgo * DAY + (hoursLater || 0) * 3600000;

// 假种子受众（source='seed'）不进 getAudience() 真实名单，但作为事件归属参考仍可用
const audienceIds = store._read('audience').map(a => a.id);
if (!audienceIds.length) throw new Error('受众表为空，请先重置/生成种子受众');
const pickAud = (i) => audienceIds[i % audienceIds.length];

function emailHtml(subject, code) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${subject}</title></head>` +
    `<body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f5f5f5;padding:24px;">` +
    `<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">` +
    `<h2 style="margin:0 0 16px;">${subject}</h2>` +
    `<p>We saved your picks — complete checkout with code <b>${code}</b>.</p>` +
    `<p style="color:#888;font-size:12px;">Unsubscribe anytime.</p></div></body></html>`;
}

// 6 封发送：D1-D4、D5 已出转化（D2 含 1 笔退款）；D5 未被打开、D6 今刚发 —— 撑起真实的开/点比率
const SENDS = [
  { d: 6, subject: 'Your cart is waiting — a welcome-back gift inside', audience: '加购未付客户', recipients: 9,  code: 'COMEBACK-SEED41', discount: 'a welcome-back gift', opens: 6, clicks: 3, orders: [86.66, 132.40] },
  { d: 5, subject: 'Still thinking it over? Here is 10% off',            audience: '浏览未买客户', recipients: 12, code: 'COMEBACK-SEED52', discount: '10% off',              opens: 7, clicks: 4, orders: [58.90, 210.35], refunds: [74.50] },
  { d: 4, subject: 'Checkout almost done — finish in one click',         audience: '下单未付客户', recipients: 8,  code: 'COMEBACK-SEED63', discount: 'free shipping',        opens: 5, clicks: 2, orders: [399.00] },
  { d: 3, subject: 'Long time no see — a little something for you',      audience: '老客召回',    recipients: 15, code: 'COMEBACK-SEED74', discount: 'a loyalty gift',       opens: 9, clicks: 5, orders: [45.60, 128.00, 86.40] },
  { d: 2, subject: 'Last chance: your saved items sell out fast',        audience: '弃购客户',    recipients: 10, code: 'COMEBACK-SEED85', discount: '15% off',              opens: 0, clicks: 0, orders: [158.20] },
  { d: 0, subject: 'Fresh picks for you — have a look',                  audience: '价格敏感客户', recipients: 7,  code: 'COMEBACK-SEED96', discount: 'a small thank-you',    opens: 3, clicks: 0, orders: [] },
];

// 幂等：先清掉上一轮种子（凭草稿优惠码 COMEBACK-SEED* 识别），再写入
const prevIds = new Set(store._read('drafts').filter(d => /^COMEBACK-SEED/.test(d.coupon || '')).map(d => d.id));
if (prevIds.size) {
  store._write('drafts', store._read('drafts').filter(d => !prevIds.has(d.id)));
  store._write('events', store._read('events').filter(e => !prevIds.has(e.draft_id)));
}

const drafts = store._read('drafts');
const events = store._read('events');

for (const s of SENDS) {
  const sentAt = at(s.d, s.d === 0 ? -2 : 10);          // 当天 = 2 小时前；其余 = 当日 10 点档
  const created = sentAt - 40 * 60000;
  const id = uid('dr');
  const hasConvert = (s.orders || []).length > 0;
  drafts.push({
    id, act_id: null,
    subject: s.subject,
    body: `${s.subject}\nComplete checkout with code ${s.code}. Unsubscribe anytime.`,
    audience: JSON.stringify(s.audience),
    discount: s.discount, coupon: s.code, posters: null,
    status: hasConvert ? 'recovering' : 'sent',
    estGmv: Math.round(s.recipients * 38.5), matchedCount: s.recipients,
    sendTiming: 'Send within 24h', created_at: created, sent_at: sentAt,
    esp_message_id: null,
    // 演示口径：每封全成本 ¥6（AI 文案 + 产图 + 发送 + 折扣/赠品摊销）——
    // 若按生产发送流的 ¥0.0004/封，ROI 会跑到几千倍；压到 ¥6/封让 ROI 落回 2-5 的正常业务区间
    cost: +(s.recipients * 6).toFixed(2),
    user_id: TARGET_USER, locale: 'en',
    html: emailHtml(s.subject, s.code),
    image_path: null, image_prompt: null, brand: null, product: null,
    mailgen_meta: null, tag_distribution: null, variants: null, variants_provider: null,
    fail_reason: null, gate_checklist: null, scheduled_at: null,
  });
  const openSet = new Set();
  for (let i = 0; i < s.opens; i++) {
    const aud = pickAud(i + s.recipients);
    openSet.add(aud);
    events.push({ id: uid('ev'), type: 'open', draft_id: id, audience_id: aud, user_id: TARGET_USER,
      value: 0, ts: sentAt + (30 + i * 47) * 60000, touch_scope: null, order_id: null, refunded: null, esp_id: null });
  }
  for (let i = 0; i < s.clicks; i++) {
    const aud = pickAud(i + s.recipients + 3);
    if (!openSet.has(aud)) {  // 点击者必然先打开过（口径与 UI 分子去重一致）
      openSet.add(aud);
      events.push({ id: uid('ev'), type: 'open', draft_id: id, audience_id: aud, user_id: TARGET_USER,
        value: 0, ts: sentAt + (20 + i * 31) * 60000, touch_scope: null, order_id: null, refunded: null, esp_id: null });
    }
    events.push({ id: uid('ev'), type: 'click', draft_id: id, audience_id: aud, user_id: TARGET_USER,
      value: 0, ts: sentAt + (90 + i * 53) * 60000, touch_scope: null, order_id: null, refunded: null, esp_id: null });
  }
  (s.orders || []).forEach((v, i) => {
    events.push({ id: uid('ev'), type: 'convert', draft_id: id, audience_id: pickAud(i * 2 + 1), user_id: TARGET_USER,
      value: v, ts: sentAt + (3 + i * 5) * 3600000, touch_scope: null,
      order_id: 'ord_seed_' + crypto.randomBytes(5).toString('hex'), refunded: null, esp_id: null });
  });
  (s.refunds || []).forEach((v, i) => {   // 退款单：value 清零 + refunded=1（orders/update 退款口径）
    events.push({ id: uid('ev'), type: 'convert', draft_id: id, audience_id: pickAud(i * 2 + 2), user_id: TARGET_USER,
      value: 0, ts: sentAt + 26 * 3600000, touch_scope: null,
      order_id: 'ord_seed_' + crypto.randomBytes(5).toString('hex'), refunded: 1, esp_id: null });
  });
}

store._write('drafts', drafts);
store._write('events', events);
store.close();

const valid = SENDS.reduce((n, s) => n + (s.orders || []).length, 0);
const refunded = SENDS.reduce((n, s) => n + (s.refunds || []).length, 0);
const gmv = SENDS.reduce((n, s) => n + (s.orders || []).reduce((a, b) => a + b, 0), 0);
console.log(`[seed] 账号 ${TARGET_USER} 新增 ${SENDS.length} 封已发送草稿；` +
  `有效转化 ${valid} 单 / 已退款 ${refunded} 单，GMV ¥${gmv.toFixed(2)}。刷新数据看板即可见。`);
