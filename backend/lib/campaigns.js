'use strict';
/**
 * lib/campaigns.js — Wave 3 批次域唯一权威（I1 并列批次 / I2 全局停发日历+紧急全停 / I3 未发部分操作）。
 *
 * 产品口径（PRD）：
 *  - 批次 = campaign：每批独立 needs 快照、独立折扣码（E2 逐批建）；建批 ≠ 发送（每批独立走五道闸门）。
 *  - 批次生命周期长于对话（act closed 后批次照跑）。
 *  - 批次恒定二分：已发部分只读存档（sends 派生）+ 未发部分（pending）可操作；
 *    每次操作回复必含边界声明「已发 X 封不受影响，改的是未发的 Y 封」。
 *  - I2 停发日历：命中停发日的排程发送冻结（不删），结束后自动顺延恢复；紧急全停恢复必须用户明说。
 *  - I4 排除在出核对单之前完成（lib/exclusion），冻结晚于排除（holdout 按净值名单圈定）。
 *
 * 本模块零网络依赖：store / connector / matcher / config 以参数注入；时钟复用 execution.now()
 * （setClock + CARTBACK_FAKE_NOW 同源，测试缝一致）。
 */

const { uid } = require('./store');
const execution = require('./execution');
const exclusion = require('./exclusion');
const { FREQUENCY_WINDOW_MS, HOLDOUT_RATIO } = require('./config');

const LETTERS = 'ABCDEFGHIJ';
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'frozen', 'done'];
// E2 建码失败三出口（与单方案 confirm 失败口径一致）
const CODE_FAIL_OPTIONS = ['重试建码', '改用店内现成码', '改发无钩子提醒信'];
// 并行批次建议上限（超过给一句建议，不硬拦）
const PARALLEL_BATCH_ADVICE_LIMIT = 3;
const PARALLEL_BATCH_ADVICE = '批多了你自己也要看不过来，建议合并或排队。';

/* ------------------------------ 时钟/日历（I2） ------------------------------ */

/** 'YYYY-MM-DD'（或 epoch 数字）→ 当日 00:00 UTC epoch ms；解析失败 null */
function dayStartMs(s) {
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

/** 挂日历：from/to 为日期（闭区间语义），内部存 [from 00:00, 次日 00:00) 闭开区间 */
function parseBlackoutRange({ from, to, label } = {}) {
  const f = dayStartMs(from);
  const t = dayStartMs(to);
  if (f == null || t == null) return { ok: false, error: '日期格式应为 YYYY-MM-DD（如 2026-11-27）' };
  const end = t + 86400000; // 结束日全天含内
  if (end <= f) return { ok: false, error: '停发结束日不能早于起始日' };
  return { ok: true, range: { from: f, to: end, label: String(label || '停发').slice(0, 40) } };
}

function activeBlackoutRange(store, now) {
  const at = Number(now) || execution.now();
  return store.getBlackouts().find(r => at >= Number(r.from) && at < Number(r.to)) || null;
}

/** 区间并集（重叠取并集；返回排序后的 [{from,to}]） */
function unionRanges(ranges) {
  const sorted = (ranges || [])
    .map(r => ({ from: Number(r.from), to: Number(r.to) }))
    .filter(r => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** ts 是否命中任一停发区间；命中返回覆盖它的并集区间 */
function hitRange(unioned, ts) {
  return (unioned || []).find(r => ts >= r.from && ts < r.to) || null;
}

/** ts 落在停发窗口内 → 窗口结束时刻（顺延目标）；否则原样返回 */
function nextFreeMoment(store, ts) {
  const u = unionRanges(store.getBlackouts());
  let cur = ts;
  for (let i = 0; i < 5; i++) {
    const hit = hitRange(u, cur);
    if (!hit) break;
    cur = hit.to;
  }
  return cur;
}

function isoDay(ms) { return new Date(Number(ms)).toISOString().slice(0, 10); }

/* ------------------------------ 派生计数/形状 ------------------------------ */

/** 批次二分派生计数：sent/pending 一律从 sends/holdouts 派生（归因只认实发，不做双记账） */
function deriveCounts(store, camp) {
  const sends = store.getSends({ campaign_id: camp.id });
  const sent = sends.filter(s => s.status === 'sent').length;
  const holdout = store.getHoldouts({ campaign_id: camp.id }).length;
  const reach = Array.isArray(camp.recipients) ? camp.recipients.length : 0;
  return { reach, sent, holdout, pending: Math.max(0, reach - sent - holdout) };
}

/** I3 灵魂句：边界声明（每次未发部分操作回复必含） */
function boundaryOf(camp, store) {
  const c = deriveCounts(store, camp);
  return `已发 ${c.sent} 封不受影响，改的是未发的 ${c.pending} 封`;
}

/** 前端契约①形状（不回传完整 recipients 名单） */
function publicCampaign(store, camp) {
  const c = deriveCounts(store, camp);
  const out = {
    id: camp.id,
    act_id: camp.act_id || null,
    name: camp.name,
    audience_desc: camp.audience_desc,
    status: camp.status,
    discount: camp.discount || { text: '', code: null, code_status: 'none' },
    reach_count: c.reach,
    sent_count: c.sent,
    pending_count: c.pending,
    holdout_count: c.holdout,
    excluded: Array.isArray(camp.excluded) ? camp.excluded : [],
    stats: { opened: 0, clicked: 0, recovered: 0, net: 0 },   // 本波占位（Wave 4 F3 回执读 sends 后回填）
    created_at: camp.created_at
  };
  if (camp.scheduled_at) out.scheduled_at = camp.scheduled_at;
  if (camp.resume_note) out.resume_note = camp.resume_note;
  return out;
}

/** 批次指代解析：「批次 A」/「加购未付那批」/「第一封」→ 同一 campaign（agent 引用人话名）。
 *  ref 支持字符串或结构化对象 {letter:'A'} / {ordinal:'二'} / {keyword:'加购'} / {campaign_id}（降级词表产出）。 */
function resolveCampaignRef(store, ref, userId) {
  const list = store.getCampaignsByUser(userId);
  if (!ref || !list.length) return null;
  if (typeof ref === 'object') {
    if (ref.campaign_id) {
      const byCid = list.find(c => c.id === ref.campaign_id);
      if (byCid) return byCid;
    }
    if (ref.letter) return resolveCampaignRef(store, `批次 ${String(ref.letter)}`, userId);
    if (ref.ordinal != null) return resolveCampaignRef(store, `第${String(ref.ordinal)}批`, userId);
    if (ref.keyword) return resolveCampaignRef(store, `${String(ref.keyword)}那批`, userId);
    return null;
  }
  const t = String(ref).trim();
  const byId = list.find(c => c.id === t);
  if (byId) return byId;
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const byName = list.find(c => norm(c.name) === norm(t));
  if (byName) return byName;
  // 序数：第一封 / 第 1 批 / 第三个
  const ordM = t.match(/第\s*([一二三四五六七八九十]|\d{1,2})\s*(?:个|批|批次|封)/);
  if (ordM) {
    const zh = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const idx = zh[ordM[1]] || parseInt(ordM[1], 10);
    if (idx >= 1 && idx <= list.length) return list[idx - 1];   // 建批顺序（created_at 升序）
  }
  // 字母：批次 A / A 批 / A（campaign.name 以字母前缀开头）
  const letterM = t.match(/(?:批次|批)?\s*([A-Ja-j])\s*(?:批|批次|的那批|那批)?\s*$/);
  if (letterM) {
    const L = letterM[1].toUpperCase();
    const byLetter = list.find(c => norm(c.name).startsWith(L.toLowerCase()) || (c.name || '').trim().toUpperCase().startsWith(L));
    if (byLetter) return byLetter;
  }
  // 关键词：「加购未付那批」→ 名字/受众描述包含关键词
  const kw = t.replace(/那批|这批|那個|那个批次|批次|的那批|批/g, '').trim();
  if (kw) {
    const byKw = list.find(c => norm(c.name).includes(norm(kw)) || norm(c.audience_desc).includes(norm(kw)));
    if (byKw) return byKw;
  }
  return null;
}

/* ------------------------------ 建批（I1） ------------------------------ */

/**
 * 批次计划（建批与预览共用；previewBatches 与 createCampaigns 同源，杜绝两处口径漂移）：
 * 逐批圈人 → I4 三类排除 → 与更早批次重叠排除（重叠者归先发批）→ 净值名单。
 * @param {Function} matcher (audienceDesc) => audience 行数组（调用方注入圈人口径）
 */
function planBatches(store, batches, { matcher, now, windowMs, userId, exclusionOverride = false } = {}) {
  const plans = [];
  const claimed = new Set();   // 更早批次已认领的邮箱（重叠排除）
  const list = Array.isArray(batches) ? batches.slice(0, 10) : [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i] || {};
    const audienceDesc = String(b.audience_desc || b.audience || '').trim();
    const gross = matcher ? (matcher(audienceDesc) || []) : [];
    let ex;
    if (exclusionOverride) {
      // I4 覆盖（「别排除，就要发」）：三类人员全部放行（照发），但「本应排除」的明细照算——
      // 进核对单展示 + 审计留痕；重叠归属仍生效（那是批次间语义，不是打扰豁免）。
      const full = exclusion.excludeRecipients(store, gross, { now, windowMs });
      const allow = gross.filter(r => !claimed.has(exclusion.normEmail(r.email)));
      ex = {
        allow,
        excluded: full.excluded.map(x => ({ ...x, overridden: true })),
        byReasonEmails: full.byReasonEmails
      };
    } else {
      ex = exclusion.excludeRecipients(store, gross, {
        now, windowMs,
        skip: claimed.size ? claimed : null,
        skipReason: plans.length ? `与批次「${plans[plans.length - 1].name}」人群重叠` : exclusion.REASON.overlap
      });
    }
    const offerText = String(b.offer_text || b.offer || '').trim();
    const percent = Number.isFinite(Number(b.percent_off)) && Number(b.percent_off) > 0
      ? Number(b.percent_off)
      : (execution.parseOfferPercent(offerText) != null ? execution.parseOfferPercent(offerText) : 0);
    const letter = LETTERS[i] || String(i + 1);
    const name = String(b.name || '').trim().slice(0, 40) || `${letter} ${audienceDesc.slice(0, 12) || '批次'}`;
    const scheduledAt = Number(b.scheduled_at) || 0;
    for (const r of ex.allow) claimed.add(exclusion.normEmail(r.email));
    plans.push({
      index: i, letter, name,
      audience_desc: audienceDesc,
      offer_text: offerText,
      percent_off: percent,
      scheduled_at: scheduledAt,
      gross_count: gross.length,
      recipients: ex.allow,        // 净值名单（I4 + 重叠之后）
      excluded: ex.excluded,       // 核对单逐条明细
      reach_count: ex.allow.length
    });
  }
  return { plans, advice: list.length > PARALLEL_BATCH_ADVICE_LIMIT ? PARALLEL_BATCH_ADVICE : null };
}

/**
 * 逐批建批（POST /api/campaigns 语义）。每批独立 E2 建码：
 * 某批建码失败 → 该批 status=draft + code_status=failed（进 failures），其余照建。
 * 建批 ≠ 发送：无 scheduled_at → draft；有 → scheduled（发送 job 由调用方入队）。
 */
async function createCampaigns(store, {
  batches, userId = null, actId = null, matcher, connector = null,
  brand = '', subject = '', exclusionOverride = false, now, windowMs
} = {}) {
  const at = Number(now) || execution.now();
  const { plans, advice } = planBatches(store, batches, { matcher, now: at, windowMs, userId, exclusionOverride });
  const campaigns = [];
  const failures = [];

  for (const plan of plans) {
    let percent = plan.percent_off;
    let code = null;
    let codeStatus = 'none';
    let discountText = plan.offer_text || (percent > 0 ? `${percent}% off` : '本批次无折扣码');
    let failReason = null;

    if (percent > 0 && connector && connector.supportsDiscountCodes && connector.supportsDiscountCodes()) {
      // E2 逐批建码：每批独立新码，绝不复用历史码；code 一律取店铺真实回执
      const named = execution.parseOfferCodeName(plan.offer_text);
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !code; attempt++) {
        const candidate = (named && attempt === 0) ? named : 'COMEBACK-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        try {
          const receipt = await connector.createDiscountCode({ code: candidate, percent_off: percent });
          codeStatus = 'created';
          code = String(receipt.code).toUpperCase();
          percent && (percent = Number(receipt.percent_off) || percent);
        } catch (e) {
          lastErr = e;
          if (!(named && attempt === 0)) break;   // 指定码名失败换随机码再试一次，仍败走失败出口
        }
      }
      if (!code) failReason = '店铺建码失败：' + String(lastErr && lastErr.message || lastErr || '未知原因').slice(0, 160);
      else discountText = `折扣码 ${code}（已在你的店铺创建 ✅）`;
    } else if (percent > 0) {
      discountText = `${plan.offer_text || percent + '% off'}（折扣码将在发送前创建）`;
    }

    const ts = Date.now();
    const camp = {
      id: uid('cmp_'),
      act_id: actId || null,
      user_id: userId || null,
      name: plan.name,
      audience_desc: plan.audience_desc,
      status: failReason ? 'draft' : (plan.scheduled_at > at ? 'scheduled' : 'draft'),
      offer_text: plan.offer_text,
      percent_off: failReason ? 0 : percent,
      discount: { text: discountText, code, code_status: failReason ? 'failed' : codeStatus },
      // 净值名单 JSON 列（I4 排除 + 重叠排除之后）；只存发送链路需要的最小字段
      recipients: plan.recipients.map(r => ({
        id: r.id || null, email: r.email, name: r.name || '', locale: r.locale || null,
        country: r.country || null, timezone: r.timezone || null, intent: r.intent || null
      })),
      excluded: plan.excluded.map(x => ({ ...x, at: ts })),
      scheduled_at: plan.scheduled_at > at ? plan.scheduled_at : 0,
      prev_status: null, resume_note: null, pause_scope: null, freeze_scope: null, frozen_reason: null,
      brand: brand || '', subject: subject || '',
      exclusion_override: exclusionOverride ? 1 : 0,
      gate_note: null,
      created_at: ts, updated_at: ts
    };
    store.upsertCampaign(camp);
    campaigns.push(camp);
    if (failReason) failures.push({ name: plan.name, reason: failReason, options: CODE_FAIL_OPTIONS });
    if (exclusionOverride && plan.excluded.length) {
      exclusion.auditExclusionOverride(store, { campaignId: camp.id, excluded: plan.excluded, note: '建批时「别排除，就要发」' });
    }
  }
  return { campaigns, failures, advice, plans };
}

/* ------------------------------ 状态机与操作（I3） ------------------------------ */

function getGlobalPaused(store) { return store.getMeta('global_paused') === '1'; }
function setGlobalPaused(store, flag) { store.setMeta('global_paused', flag ? '1' : '0'); }

function touch(store, camp) { camp.updated_at = Date.now(); store.upsertCampaign(camp); return camp; }

/**
 * 暂停（I3：暂停/恢复成对；恢复必须用户明说）。空批也照常返回（边界照给）。
 * pause_scope：user（用户手动）| global（紧急全停）。
 */
function pauseCampaign(store, camp, { scope = 'user', reason = null } = {}) {
  if (camp.status === 'done') return { ok: false, reason: '批次已全部发完，没有可暂停的未发部分' };
  if (camp.status === 'paused' && camp.pause_scope === 'user') return { ok: true, camp, already: true };
  if (camp.status !== 'paused' && camp.status !== 'frozen') {
    // running 无活跃 job 语义：回滚目标统一归一为 scheduled（恢复后重触发发送即可续跑）
    camp.prev_status = camp.status === 'running' ? 'scheduled' : camp.status;
  }
  camp.status = 'paused';
  camp.pause_scope = scope;
  if (reason) camp.frozen_reason = reason;
  return { ok: true, camp: touch(store, camp) };
}

/**
 * 恢复（仅用户明说；global_paused 期间拒绝单批恢复 —— 全停高于一切单批操作）。
 * 回滚目标 = prev_status（draft/scheduled/running 之一），缺失时按 scheduled_at 兜底。
 */
function resumeCampaign(store, camp, { globalPaused = null } = {}) {
  const gp = globalPaused == null ? getGlobalPaused(store) : Boolean(globalPaused);
  if (gp) return { ok: false, reason: '现在是全店紧急停发状态，单批恢复先等等——明说「恢复吧」解除全停后再操作' };
  if (camp.status !== 'paused' && camp.status !== 'frozen') return { ok: true, camp, already: true };
  const target = ['draft', 'scheduled', 'running'].includes(camp.prev_status)
    ? camp.prev_status
    : (camp.scheduled_at ? 'scheduled' : 'draft');
  camp.status = target;
  camp.pause_scope = null;
  camp.freeze_scope = null;
  camp.frozen_reason = null;
  return { ok: true, camp: touch(store, camp) };
}

/**
 * 改折扣（I3）：只改未发部分 —— 力度变化 → 建新码（E2 逐批建），
 * 旧码仅对已发邮件继续有效（已发 sends 行不动），核对单/批次数据同步更新。
 */
async function changeDiscount(store, camp, { percentOff, connector = null } = {}) {
  const pct = Number(percentOff);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 90) return { ok: false, reason: '折扣力度要在 1–90 之间（% off）' };
  const c = deriveCounts(store, camp);
  if (c.pending === 0) return { ok: false, reason: `这批没有未发部分了（已发 ${c.sent} 封，存档只读）——已发 ${c.sent} 封不受影响，改的是未发的 0 封` };
  if (!(connector && connector.supportsDiscountCodes && connector.supportsDiscountCodes())) {
    return { ok: false, reason: '店铺未连接，改折扣要先真实建新码（宁缓发不错发）' };
  }
  let code = null, lastErr = null;
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    try {
      const receipt = await connector.createDiscountCode({
        code: 'COMEBACK-' + Math.random().toString(36).slice(2, 8).toUpperCase(), percent_off: pct
      });
      code = String(receipt.code).toUpperCase();
    } catch (e) { lastErr = e; }
  }
  if (!code) return { ok: false, reason: '店铺建新码失败：' + String(lastErr && lastErr.message || lastErr || '未知原因').slice(0, 160) };
  const oldCode = camp.discount && camp.discount.code;
  camp.percent_off = pct;
  camp.offer_text = `${pct}% off`;
  camp.discount = { text: `折扣码 ${code}（未发部分新码，力度 ${pct}% off）`, code, code_status: 'created', percent_off: pct, previous_code: oldCode || null };
  camp.gate_note = null;
  touch(store, camp);
  store.addEvent({ type: 'audit', draft_id: camp.id, value: c.pending, order_id: `discount:${oldCode || 'none'}->${code}`, ts: Date.now() });
  return { ok: true, camp, code, oldCode: oldCode || null, changed: [`折扣改为 ${pct}%`] };
}

/**
 * 排除（I3）：从未发名单即时移除、逐条留痕。操作对象是已发部分 → 拒绝并解释。
 * @param {object} p emails?: string[]；allOpened?: bool（尽力口径：排除有打开回执的待发人群）
 */
function excludeFromCampaign(store, camp, { emails, allOpened = false } = {}) {
  const want = new Set((Array.isArray(emails) ? emails : []).map(e => exclusion.normEmail(e)).filter(Boolean));
  if (allOpened) {
    const opened = new Set(store.getEvents().filter(e => e.type === 'open' && e.audience_id).map(e => e.audience_id));
    for (const r of camp.recipients || []) if (r.id && opened.has(r.id)) want.add(exclusion.normEmail(r.email));
  }
  if (!want.size) return { ok: false, reason: '要排除谁？给邮箱列表（emails），或 all_opened:true' };
  const sentSet = new Set(store.getSends({ campaign_id: camp.id }).filter(s => s.status === 'sent').map(s => exclusion.normEmail(s.recipient)));
  const removed = [];
  const rejectedSent = [];
  camp.recipients = (camp.recipients || []).filter(r => {
    const em = exclusion.normEmail(r.email);
    if (!want.has(em)) return true;
    if (sentSet.has(em)) { rejectedSent.push({ email: em, reason: '已发送，存档只读（已发部分不可操作）' }); return true; }
    removed.push(em);
    return false;
  });
  const c = deriveCounts(store, camp);
  if (!removed.length && rejectedSent.length) {
    return { ok: false, reason: `这些人都已收到邮件，已发部分只读存档、不能排除（已发 ${c.sent} 封不受影响）`, rejected: rejectedSent };
  }
  if (removed.length) {
    camp.excluded = [...(camp.excluded || []), { reason: '手动排除', count: removed.length, at: Date.now(), emails: removed }];
    store.addEvent({ type: 'audit', draft_id: camp.id, value: removed.length, order_id: `exclude:${removed.join('|').slice(0, 120)}`, ts: Date.now() });
  }
  touch(store, camp);
  return { ok: true, camp, excluded_count: removed.length, rejected: rejectedSent };
}

/**
 * 重发（I3）：「给没打开的再打一轮」→ 生成新批次（新码、可换主题行）。
 * 频次护栏：未明确确认 → { needs_confirm, risk }；确认后照发并留痕（审计事件）。
 * 本波打开回执未接（stats 占位 0）：「没打开的」暂以「已发送名单」为底、剔除已有打开事件者；
 * Wave 4 F3 回执读 sends 后自动收窄（口径注释，勿删）。
 */
async function resendCampaign(store, camp, { subject = '', confirmFrequency = false, connector = null, userId = null, brand = '' } = {}) {
  if (confirmFrequency !== true) {
    const riskN = countFrequencyRisk(store, camp);
    return {
      ok: false, needs_confirm: true,
      risk: `72 小时内已触达 ${riskN} 人`,
      risk_count: riskN,
      hint: '重复打扰会伤名单，确认要再打一轮就带 confirm_frequency:true'
    };
  }
  const sentRows = store.getSends({ campaign_id: camp.id }).filter(s => s.status === 'sent');
  const openedAudIds = new Set(store.getEvents().filter(e => e.type === 'open' && e.audience_id).map(e => e.audience_id));
  const byEmail = new Map((camp.recipients || []).map(r => [exclusion.normEmail(r.email), r]));
  // 重发对象 = 已发但未打开（有打开回执的剔除）
  const targets = sentRows
    .map(s => byEmail.get(exclusion.normEmail(s.recipient)))
    .filter(r => r && !(r.id && openedAudIds.has(r.id)));
  if (!targets.length) return { ok: false, reason: '没有可重发的人（已发名单为空或都已打开）' };
  const created = await createCampaigns(store, {
    batches: [{
      name: `${camp.name} 重发`,
      audience_desc: camp.audience_desc,
      offer_text: camp.offer_text,
      percent_off: camp.percent_off || undefined,
      // 重发不走默认三类排除？—— 走。刚发过 → 频控必命中 → 覆盖语义由 confirmFrequency 承接：
      // 这里直接以 targets 为准，不经 matcher 圈人（重发对象就是这批已发未打开者）
    }],
    userId, actId: camp.act_id, matcher: null, connector, brand: brand || camp.brand,
    subject: subject || camp.subject || '', exclusionOverride: true,
  });
  const newCamp = created.campaigns[0];
  if (newCamp) {
    // 重发名单 = 指定 targets（不用 matcher 圈人）；I4 常规排除不适用（对已发者频控必命中，confirmFrequency 即覆盖确认）
    newCamp.recipients = targets.map(r => ({
      id: r.id || null, email: r.email, name: r.name || '', locale: r.locale || null,
      country: r.country || null, timezone: r.timezone || null, intent: r.intent || null
    }));
    newCamp.excluded = [...(newCamp.excluded || []), { reason: '重发确认（频次护栏已明示）', count: 0, at: Date.now() }];
    touch(store, newCamp);
    store.addEvent({ type: 'audit', draft_id: camp.id, value: targets.length, order_id: `resend:${newCamp.id}`, ts: Date.now() });
  }
  return { ok: true, camp: newCamp, source: camp };
}

/** 重发风险计数：重发对象中落在频控窗口内已触达的人数 */
function countFrequencyRisk(store, camp) {
  const reached = exclusion.reachedEmails(store, {});
  const sentRows = store.getSends({ campaign_id: camp.id }).filter(s => s.status === 'sent');
  return sentRows.filter(s => reached.has(exclusion.normEmail(s.recipient))).length;
}

/* --------------------------- 全局停发 / 日历编排（I2） --------------------------- */

/**
 * 紧急全停：立即暂停一切 —— running 批次转 paused、scheduled/frozen 全冻结；
 * 恢复必须用户明说（resume-all），绝不自动恢复。
 */
function applyPauseAll(store, { now } = {}) {
  setGlobalPaused(store, true);
  const at = Number(now) || execution.now();
  let paused = 0, frozen = 0;
  for (const camp of allCampaigns(store)) {
    if (camp.status === 'running' || camp.status === 'paused') {
      if (camp.status === 'running' || camp.pause_scope !== 'user') {
        if (camp.status !== 'paused') {
          // running 无活跃 job 语义：回滚目标归一 scheduled（恢复后重触发即续跑）
          camp.prev_status = camp.status === 'running' ? 'scheduled' : camp.status;
        }
        camp.status = 'paused';
        camp.pause_scope = 'global';
        camp.updated_at = at; store.upsertCampaign(camp); paused++;
      }
    } else if (camp.status === 'scheduled' || (camp.status === 'frozen' && camp.freeze_scope !== 'calendar')) {
      // 日历冻结的批次保持原冻结（freeze_scope=calendar 归 reconcile 顺延恢复，不被全停改写归属）
      if (camp.status !== 'frozen') camp.prev_status = camp.status;
      camp.status = 'frozen';
      camp.freeze_scope = 'global';
      camp.frozen_reason = '紧急全停生效中';
      camp.updated_at = at; store.upsertCampaign(camp); frozen++;
    }
  }
  return { ok: true, paused, frozen };
}

/**
 * 紧急全停解除（必须用户明说「恢复吧」触发，绝无自动路径）：
 * global_paused 清除 + 因全停而 paused/frozen 的批次回到原状态；用户手动暂停（scope=user）的保持暂停。
 */
function resumeAll(store, { now } = {}) {
  setGlobalPaused(store, false);
  const at = Number(now) || execution.now();
  const resumed = [];
  for (const camp of allCampaigns(store)) {
    if (camp.status === 'paused' && camp.pause_scope === 'global') {
      const r = resumeCampaign(store, camp, { globalPaused: false });
      if (r.ok) { camp.resume_note = '全停解除，批次恢复'; resumed.push(camp.name); camp.updated_at = at; store.upsertCampaign(camp); }
    } else if (camp.status === 'frozen' && camp.freeze_scope === 'global') {
      const r = resumeCampaign(store, camp, { globalPaused: false });
      if (r.ok) { camp.resume_note = '全停解除，批次恢复'; resumed.push(camp.name); camp.updated_at = at; store.upsertCampaign(camp); }
    }
  }
  return { ok: true, resumed, resumed_count: resumed.length };
}

function allCampaigns(store) { return store._read('campaigns'); }

/**
 * 停发日历对账（在 state/campaigns 读点与发送执行点调用）：
 *  - 日历仍生效 → 不动；
 *  - 日历结束 → freeze_scope='calendar' 的批次自动顺延恢复（这是日历冻结的唯一自动恢复路径；
 *    紧急全停 freeze_scope='global' 绝不在此恢复），排程时刻落在窗口内的顺延到窗口结束并提示。
 * 返回恢复的批次（调用方据此重排队列 job）。
 */
function reconcileBlackout(store, { now } = {}) {
  const at = Number(now) || execution.now();
  if (activeBlackoutRange(store, at)) return [];
  const restored = [];
  for (const camp of allCampaigns(store)) {
    if (camp.status !== 'frozen' || camp.freeze_scope !== 'calendar') continue;
    const r = resumeCampaign(store, camp, { globalPaused: getGlobalPaused(store) });
    if (!r.ok) continue;
    let note = '停发窗口已过，批次恢复';
    if (camp.scheduled_at) {
      const free = nextFreeMoment(store, camp.scheduled_at);
      if (free > camp.scheduled_at) {
        camp.scheduled_at = free;
        note += `，排程顺延到 ${isoDay(free)}`;
      }
      if (camp.scheduled_at <= at) { camp.scheduled_at = 0; camp.status = camp.prev_status === 'running' ? 'draft' : (camp.prev_status || 'draft'); }
    }
    camp.resume_note = note;
    camp.updated_at = at;
    store.upsertCampaign(camp);
    restored.push(camp);
  }
  return restored;
}

/**
 * 发送执行点统一停发检查（queue tick + send 入口共用；高于一切单批操作）：
 * 返回 null = 放行；否则 { kind:'global'|'calendar', reason, retryAt? }。
 */
function sendBlocker(store, { now } = {}) {
  const at = Number(now) || execution.now();
  if (getGlobalPaused(store)) {
    return { kind: 'global', reason: '已全店紧急停发：所有批次暂停/冻结，恢复须明说「恢复吧」' };
  }
  const bk = activeBlackoutRange(store, at);
  if (bk) {
    return {
      kind: 'calendar',
      reason: `停发日历生效中（${bk.label}，${isoDay(bk.from)}–${isoDay(bk.to - 1)}）：命中停发日的发送冻结不删，窗口过后自动顺延`,
      retryAt: nextFreeMoment(store, at)
    };
  }
  return null;
}

/* ------------------------------ 批次五道闸门 ------------------------------ */

const CAMPAIGN_GATE_LABELS = {
  window: '时段（收件人当地时间合理时段）',
  frequency: '频次（频控窗口内未被触达）',
  whitelabel: '白标（署名为商家品牌）',
  unsubscribe: '退订（链接可解析 + List-Unsubscribe 头）',
  amount_code: '金额与码核对（码真实存在）'
};
const CAMPAIGN_GATE_ORDER = ['window', 'frequency', 'whitelabel', 'unsubscribe', 'amount_code'];

/**
 * 批次独立五道闸门（与单方案 evaluateChecklist 同一套 execution 原语；批次无 draft 快照，
 * 闸门⑤ = 码真实存在校验，无 diff 语义）。返回形状与 evaluateChecklist 对齐。
 */
async function evaluateCampaignGates(store, camp, { connector = null, publicBaseUrl = '', windowMs } = {}) {
  const all = (camp.recipients || []).slice();
  const sentSet = new Set(store.getSends({ campaign_id: camp.id }).filter(s => s.status === 'sent').map(s => exclusion.normEmail(s.recipient)));
  const holdSet = new Set(store.getHoldouts({ campaign_id: camp.id }).map(h => exclusion.normEmail(h.recipient)));
  const pending = all.filter(r => !sentSet.has(exclusion.normEmail(r.email)) && !holdSet.has(exclusion.normEmail(r.email)));
  const at = execution.now();

  // ① 时段（E3 原语同源）
  const tz = execution.majorityTimezone(pending.length ? pending : [{ timezone: null }]);
  const hour = execution.localHourIn(tz, at);
  const windowPass = pending.length > 0 && execution.isReasonableHour(hour);
  const windowRetryAt = windowPass ? null : execution.nextReasonableSendTime(tz, at);
  const items = [{
    gate: 'window', label: CAMPAIGN_GATE_LABELS.window, pass: windowPass,
    ...(windowPass ? {} : { reason: `收件人主流时区（${tz}）当地时间 ${String(hour).padStart(2, '0')}:00 不在合理发送时段，将缓发到下一合理时段` })
  }];

  // ② 频次（读 sends 实发表，窗口 = config 单处常量）
  const reached = exclusion.reachedEmails(store, { now: at, windowMs });
  const allow = pending.filter(r => !reached.has(exclusion.normEmail(r.email)));
  const freqPass = allow.length > 0;
  const freqReason = pending.length === 0
    ? '没有未发收件人（已发部分只读存档，holdout 不收信）'
    : '这批未发收件人在频控窗口内都已被触达，先别打扰了';
  items.push({
    gate: 'frequency', label: CAMPAIGN_GATE_LABELS.frequency, pass: freqPass,
    ...(freqPass
      ? (pending.length - allow.length ? { reason: `${pending.length - allow.length} 名收件人频控窗口内已触达，本轮剔除` } : {})
      : { reason: freqReason })
  });

  // ③ 白标
  const brand = String(camp.brand || '').trim();
  const wlPass = Boolean(brand) && brand !== 'CartBack';
  items.push({
    gate: 'whitelabel', label: CAMPAIGN_GATE_LABELS.whitelabel, pass: wlPass,
    ...(wlPass ? {} : { reason: '还未设置商家品牌，署名会显示工具默认名「CartBack」。去设置页填品牌名' })
  });

  // ④ 退订
  const unsubOk = Boolean(publicBaseUrl);
  items.push({
    gate: 'unsubscribe', label: CAMPAIGN_GATE_LABELS.unsubscribe, pass: unsubOk,
    ...(unsubOk ? {} : { reason: '未配置对外公网基址（publicBaseUrl），退订链接无法解析' })
  });

  // ⑤ 金额与码核对：批次无草稿 diff，校验码真实存在（宁缓发不错发）
  const code = camp.discount && camp.discount.code;
  const codeStatus = camp.discount && camp.discount.code_status;
  let amountReason = null;
  let amountPass = true;
  if (codeStatus === 'none') amountReason = '本批次无折扣码';
  else if (!code) { amountPass = false; amountReason = '批次还没有真实折扣码（建码失败或未建），不能发送'; }
  else if (!connector || !connector.supportsDiscountCodes || !connector.supportsDiscountCodes()) {
    amountPass = false; amountReason = '店铺未连接，无法校验折扣码真实存在（宁缓发不错发）';
  } else {
    try {
      const hit = await connector.verifyDiscountCode(code);
      if (!hit) { amountPass = false; amountReason = `折扣码 ${code} 未在你的店铺中找到，不能发送（宁缓发不错发）`; }
    } catch (e) {
      amountPass = false; amountReason = '店铺校验折扣码失败或超时，为稳妥起见本轮不发（宁缓发不错发）';
    }
  }
  items.push({ gate: 'amount_code', label: CAMPAIGN_GATE_LABELS.amount_code, pass: amountPass, ...(amountReason ? { reason: amountReason } : {}) });

  return {
    items: CAMPAIGN_GATE_ORDER.map(g => items.find(i => i.gate === g)),
    all_pass: items.every(i => i.pass),
    pending,
    allow,
    skippedByFrequency: pending.length - allow.length,
    windowRetryAt,
    timezone: tz
  };
}

/** 发送放行时刻：holdout 冻结晚于排除（按净值 pending 圈定，Wave 2 已是此序，保持） */
function freezeCampaignHoldouts(store, camp, pending, { ratio = HOLDOUT_RATIO } = {}) {
  const plan = execution.selectHoldout(pending, ratio);
  if (plan.frozen) {
    store.freezeHoldouts({ act_id: camp.act_id, campaign_id: camp.id, recipients: plan.members, ratio: plan.ratio, source: 'campaign' });
  }
  return plan;
}

module.exports = {
  LETTERS, CAMPAIGN_STATUSES, CODE_FAIL_OPTIONS,
  PARALLEL_BATCH_ADVICE_LIMIT, PARALLEL_BATCH_ADVICE,
  // 时钟/日历
  dayStartMs, parseBlackoutRange, activeBlackoutRange, unionRanges, hitRange, nextFreeMoment, isoDay,
  // 形状/指代
  deriveCounts, boundaryOf, publicCampaign, resolveCampaignRef,
  // 建批
  planBatches, createCampaigns,
  // 状态机/I3 操作
  pauseCampaign, resumeCampaign, changeDiscount, excludeFromCampaign, resendCampaign, countFrequencyRisk,
  // 全局停发
  getGlobalPaused, setGlobalPaused, pauseAll: applyPauseAll, resumeAll, reconcileBlackout, sendBlocker, allCampaigns,
  // 闸门
  evaluateCampaignGates, freezeCampaignHoldouts, CAMPAIGN_GATE_LABELS, CAMPAIGN_GATE_ORDER
};
