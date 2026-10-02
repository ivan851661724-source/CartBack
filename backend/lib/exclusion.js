'use strict';
/**
 * lib/exclusion.js — Wave 3 I4 自动排除的唯一权威（供「单方案」与「批次」两条链路共用）。
 *
 * 任何圈人动作（建批 / 重发 / 核对单生成前）默认排除三类：
 *   ① 已购买   —— 店铺订单已下单的邮箱（/api/store/pull 落 events type='purchased'，audience_id → 邮箱）
 *   ② 已触达   —— 频控窗口内已实发过的邮箱（读 sends 实发表；窗口 = lib/config.FREQUENCY_WINDOW_MS，
 *                 与 E3 频次闸同源单处常量，禁止此处再硬编码）
 *   ③ 已挽回   —— 近期被挽回成功（归因 conversion：events type='convert' 且未退款）
 *
 * 铁律：
 *   - 排除在出核对单之前完成：净值人数 = 圈定 − 排除；排除明细逐条（原因+人数）进核对单展示。
 *   - 冻结晚于排除：holdout 一律按净值名单圈定（调用方保证顺序）。
 *   - 用户可覆盖（「别排除，就要发」）→ 先提示风险 → 照发 + 审计留痕（events type='audit'）。
 *
 * 单方案链路：server.filterTargetable（30 天窗口 + 邮箱有效 + 未转化）重构为本模块 baseTargetable，
 * 语义保持不变（老测试不感知）；批次链路：excludeRecipients 在 baseTargetable 之上做三类排除。
 *
 * 本模块零网络依赖：store 注入；时钟经 opts.now 注入（默认 Date.now()）。
 */

const { FREQUENCY_WINDOW_MS } = require('./config');

// 与 server.js 原口径一致：挽回窗口 30 天（§1 过滤条件「说到做到」）
const RECOVERY_WINDOW_MS = 30 * 86400000;

// 排除原因（人话，进核对单/回复展示；断言关键词：已下单 / 已购买 / 已触达 / 已挽回）
const REASON = {
  purchased: '已购买（店铺已下单）',
  reached: '频控窗口内已触达',
  recovered: '已挽回（近期转化）',
  overlap: '与先发批次人群重叠'
};

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

/** 邮箱 → audience 行映射（events 只带 audience_id，需反查邮箱） */
function emailByAudienceId(store) {
  const map = new Map();
  for (const a of store.getAudience()) {
    if (a.id && a.email) map.set(a.id, normEmail(a.email));
  }
  return map;
}

/** ① 已购买邮箱集合：店铺订单事件（type='purchased'）→ audience 邮箱 */
function purchasedEmails(store) {
  const byId = emailByAudienceId(store);
  const out = new Set();
  for (const e of store.getEvents()) {
    if (e.type !== 'purchased' || !e.audience_id) continue;
    const em = byId.get(e.audience_id);
    if (em) out.add(em);
  }
  return out;
}

/** ③ 已挽回邮箱集合：归因 conversion（type='convert'，未退款）→ audience 邮箱 */
function recoveredEmails(store) {
  const byId = emailByAudienceId(store);
  const out = new Set();
  for (const e of store.getEvents()) {
    if (e.type !== 'convert' || e.refunded || !e.audience_id) continue;
    const em = byId.get(e.audience_id);
    if (em) out.add(em);
  }
  return out;
}

/** ② 已触达邮箱集合：sends 实发表（status='sent'）频控窗口内；与 E3 频次闸同窗口常量 */
function reachedEmails(store, { now, windowMs } = {}) {
  const at = Number(now) || Date.now();
  const win = Number(windowMs) || FREQUENCY_WINDOW_MS;
  const cutoff = at - win;
  const out = new Set();
  for (const s of store.getSends()) {
    if (s.status !== 'sent') continue;
    if (Number(s.at || 0) < cutoff) continue;
    if (s.recipient) out.add(normEmail(s.recipient));
  }
  return out;
}

/**
 * 基础可发送名单（与单方案 filterTargetable 同口径，重构收敛于此）：
 * 邮箱格式有效 + 挽回窗口 30 天内 + 未转化（convert 事件）。
 */
function baseTargetable(store, list, { now, recoveryWindowMs } = {}) {
  const at = Number(now) || Date.now();
  const win = Number(recoveryWindowMs) || RECOVERY_WINDOW_MS;
  const byId = new Map(store.getAudience().map(a => [a.id, a]));
  const converted = new Set();
  for (const e of store.getEvents()) {
    if (e.type !== 'convert' || !e.audience_id) continue;
    const a = byId.get(e.audience_id);
    if (a && a.email) converted.add(normEmail(a.email));
  }
  const cutoff = at - win;
  return (list || [])
    .filter(a => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email || ''))
    .filter(a => (a.at_risk_at || a.created_at || 0) >= cutoff)
    .filter(a => !converted.has(normEmail(a.email)));
}

/**
 * I4 主入口：三类排除（+ 可选的重叠排除）。
 * @param {object} opts
 *   now / windowMs          —— 时钟与频控窗口（默认 Date.now() / config.FREQUENCY_WINDOW_MS）
 *   skip                    —— Set<email>：已被更早批次认领（重叠排除），skipReason 为其展示原因
 *   skipReason              —— 重叠排除的展示原因（如「与批次「A」人群重叠」）
 *   disabled                —— {purchased,reached,recovered} 置 true 关闭对应类（用户覆盖「别排除」时由调用方全关）
 * @returns {{allow, excluded:[{reason,count}], byReasonEmails}}
 *   allow：净值名单（保持入参顺序）；excluded：核对单逐条明细（原因+人数，仅列非零项）
 */
function excludeRecipients(store, recipients, opts = {}) {
  const disabled = opts.disabled || {};
  const skip = opts.skip instanceof Set ? opts.skip : null;
  const excluded = [];
  const byReasonEmails = {};
  const seen = new Set(); // 已被某类排除的人不再计入其它类（一人一原因，净值算术不重复扣减）
  const take = (reason, emailSet) => {
    let n = 0; const emails = [];
    for (const r of (recipients || [])) {
      const em = normEmail(r && r.email);
      if (!em || seen.has(em)) continue;
      if (emailSet.has(em)) { seen.add(em); n++; emails.push(em); }
    }
    if (n > 0) { excluded.push({ reason, count: n }); byReasonEmails[reason] = emails; }
  };

  if (!disabled.purchased) take(REASON.purchased, purchasedEmails(store));
  if (!disabled.reached) take(REASON.reached, reachedEmails(store, { now: opts.now, windowMs: opts.windowMs }));
  if (!disabled.recovered) take(REASON.recovered, recoveredEmails(store));
  if (skip && skip.size) take(opts.skipReason || REASON.overlap, skip);

  const allow = (recipients || []).filter(r => {
    const em = normEmail(r && r.email);
    return em && !seen.has(em) && !(skip && skip.has(em));
  });
  return { allow, excluded, byReasonEmails };
}

/**
 * I4 覆盖留痕：用户「别排除，就要发」→ 照发 + 审计事件（events type='audit'）。
 * 事件行记「发生了覆盖」+ 被覆盖总人数（value）；逐条明细由调用方写入 campaign.excluded（含 emails），
 * 跨批次可回溯。返回写入的审计事件。
 */
function auditExclusionOverride(store, { campaignId, excluded, note } = {}) {
  return store.addEvent({
    type: 'audit',
    draft_id: campaignId || null,
    audience_id: null,
    value: (excluded || []).reduce((s, x) => s + (Number(x.count) || 0), 0),
    order_id: note ? `override:${String(note).slice(0, 120)}` : 'override',
    ts: Date.now()
  });
}

module.exports = {
  REASON,
  RECOVERY_WINDOW_MS,
  normEmail,
  purchasedEmails,
  reachedEmails,
  recoveredEmails,
  baseTargetable,
  excludeRecipients,
  auditExclusionOverride
};
