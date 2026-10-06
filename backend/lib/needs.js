'use strict';
/**
 * lib/needs.js — PRD v2 意图槽位（needs）数据契约的唯一权威。
 *
 * 四槽：audience（针对谁）> reason（为什么挽回，旧名 pain）> offer（给什么钩子）> goal（要什么结果）。
 * 槽位三态：null | { value: string, source: 'explicit'|'inferred', at: epoch_ms }
 *   - explicit：用户本轮原话明确说出 / 明确纠正
 *   - inferred：引擎或模型在依据不足（C6 兜底 / 默认建议）时代为拍板，回复必须带「不对请纠正」
 *
 * memory 扩展契约（B-1）：
 *   corrections: [{ slot, old, new, at, scope? }]  追加制（scope 缺省 = 四槽；scope='extras' 时 slot = extras key）
 *   extras:      [{ key, value, at }]              品牌名/品类/客单价/兴趣/特色/时段/频率等长期事实
 *   prefs:       {}                                商家偏好（本波占位）
 *   ask_count:   { audience, reason, offer, goal } 每槽被追问次数（B4 不得连问的依据）
 *   facts/decisions 保留兼容（旧 memory_patch 路径），新代码不再写入
 *
 * 本模块零依赖：store.js / igde.js / server.js 共用，禁止反向 require 业务模块。
 */

const SLOTS = ['audience', 'reason', 'offer', 'goal'];
const SLOT_LABEL = { audience: '针对谁', reason: '为什么挽回', goal: '要什么结果', offer: '给什么钩子' };

/** 槽位快捷选项（后端下发，PRD 固定口径；goal 4 项属槽位级例外） */
const SLOT_CHIPS = {
  audience: ['加购未付', '浏览未买', '老客'],
  reason: ['忘记结账', '在对比价格', '我来说原因'],
  offer: ['折扣', '免邮', '小赠品'],
  goal: ['挽回订单', '具体金额', '跑通流程', '我自己定']
};

/** 冲突澄清轮 chips（C6）：audience 冲突场景固定三项；其余槽回落常规 chips */
const CONFLICT_CHIPS = {
  audience: ['18-24', '25-34', '维持当前年龄定位']
};

function conflictChips(slot) {
  return CONFLICT_CHIPS[slot] || SLOT_CHIPS[slot] || [];
}

function emptyNeeds() {
  return { audience: null, reason: null, offer: null, goal: null };
}

function emptyAskCount() {
  return { audience: 0, reason: 0, offer: 0, goal: 0 };
}

/**
 * 任意历史形态 → 三态槽位对象。
 * 接受：null / '' / 纯字符串（旧契约）/ { value, source?, at? }（新契约）。
 */
function normalizeSlot(raw, { source = 'explicit', at = Date.now() } = {}) {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const value = String(raw.value || '').trim();
    if (!value) return null;
    return {
      value,
      source: raw.source === 'inferred' ? 'inferred' : (raw.source === 'explicit' ? 'explicit' : source),
      at: Number(raw.at) || at
    };
  }
  const value = String(raw).trim();
  return value ? { value, source, at } : null;
}

/**
 * 旧 needs → 新契约（惰性迁移，读/写前调用）：
 *  - 纯字符串槽 → { value, source:'explicit', at: now }
 *  - pain → reason 改名
 *  - 缺失槽补 null（保证四槽键齐全，引擎/前端不用再做键存在性判断）
 */
function migrateNeeds(raw, now = Date.now()) {
  const out = emptyNeeds();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const slot of SLOTS) {
    let v = src[slot];
    if ((v == null || v === '') && slot === 'reason' && src.pain != null) v = src.pain; // pain → reason
    out[slot] = normalizeSlot(v, { source: 'explicit', at: now });
  }
  return out;
}

/** 新契约 → 旧式纯字符串 map（prompt 注入 / variants / planCard 等消费方用） */
function plainNeeds(needs) {
  const src = needs && typeof needs === 'object' ? needs : {};
  const out = {};
  for (const slot of SLOTS) {
    const s = src[slot];
    out[slot] = s && typeof s === 'object' ? String(s.value || '') : String(s || '');
  }
  return out;
}

function slotText(needs, slot) {
  const s = needs && needs[slot];
  if (!s) return '';
  return typeof s === 'object' ? String(s.value || '') : String(s);
}

/** 四槽 value 非空数（filled_count 的唯一计算口径） */
function countFilled(needs) {
  const src = needs && typeof needs === 'object' ? needs : {};
  return SLOTS.filter(s => {
    const v = src[s];
    return v && (typeof v !== 'object' || String(v.value || '').trim());
  }).length;
}

function missingSlots(needs) {
  const src = needs && typeof needs === 'object' ? needs : {};
  return SLOTS.filter(s => {
    const v = src[s];
    return !v || (typeof v === 'object' && !String(v.value || '').trim());
  });
}

/** source 为 inferred 的槽位列表（planCard.inferred_slots 口径） */
function inferredSlots(needs) {
  const src = needs && typeof needs === 'object' ? needs : {};
  return SLOTS.filter(s => src[s] && typeof src[s] === 'object' && src[s].source === 'inferred');
}

/** memory 补齐新契约字段（extras/prefs/ask_count），facts/decisions/corrections 保留 */
function ensureMemory(memory, now = Date.now()) {
  const m = memory && typeof memory === 'object' ? memory : {};
  if (!Array.isArray(m.facts)) m.facts = [];
  if (!Array.isArray(m.decisions)) m.decisions = [];
  if (!Array.isArray(m.corrections)) m.corrections = [];
  if (!Array.isArray(m.extras)) m.extras = Array.isArray(m.extras_) ? m.extras_ : [];
  if (!m.prefs || typeof m.prefs !== 'object' || Array.isArray(m.prefs)) m.prefs = {};
  const ac = emptyAskCount();
  if (m.ask_count && typeof m.ask_count === 'object') {
    for (const s of SLOTS) ac[s] = Math.max(0, Number(m.ask_count[s]) || 0);
  }
  m.ask_count = ac;
  for (const s of SLOTS) if (!Number.isFinite(Number(m.ask_count[s]))) m.ask_count[s] = 0;
  // C6.5 拉锯保护计数（2026-10-03 裁决）：同槽澄清 ≤1 次（含 S2），第二次改口直接按 correction 处理
  const cc = emptyAskCount();
  if (m.clarif_count && typeof m.clarif_count === 'object') {
    for (const s of SLOTS) cc[s] = Math.max(0, Number(m.clarif_count[s]) || 0);
  }
  m.clarif_count = cc;
  // 防呆计数（2026-10-05）：S1 采集轮数 / 循环熔断次数 / goal 裸类目点击数
  m.s1_turns = Math.max(0, Math.trunc(Number(m.s1_turns) || 0));
  m.loop_breaks = Math.max(0, Math.trunc(Number(m.loop_breaks) || 0));
  m.goal_bare = Math.max(0, Math.trunc(Number(m.goal_bare) || 0));
  if (!Array.isArray(m.conflicts)) m.conflicts = []; // 未消解的冲突候选（B2 产出 → B4 追问 → C6 兜底）
  return m;
}

/**
 * 落库前的 act 迁移 + filled_count 单调不减（B-1）。
 * old 存在时：新值缺失但旧值已填的槽回填旧值（correction 场景新值必非空，不受影响），
 * filled_count 取 max —— 保证任何路径下都不会回退。
 */
function migrateAct(act, now = Date.now()) {
  if (!act || typeof act !== 'object') return act;
  act.needs = migrateNeeds(act.needs, now);
  act.memory = ensureMemory(act.memory, now);
  if (act.code_status == null) act.code_status = 'none';
  if (!['none', 'pending', 'created', 'reused', 'failed'].includes(act.code_status)) act.code_status = 'none';
  if (!Number.isFinite(Number(act.filled_count))) act.filled_count = countFilled(act.needs);
  return act;
}

/** filled_count 单调不减合并：返回落库用的 act（就地修改）。
 *  例外（Wave 4 A3③）：商家否认复用（「别用上次的」）对预填槽的显式清空不是降级——
 *  memory.prefs.reuse_cleared 列出的槽允许清空（引擎清空同轮打标，落库后旧值被覆盖为空）。 */
function mergeMonotonicAct(act, old, now = Date.now()) {
  migrateAct(act, now);
  if (act.flow_version === 6) {
    act.filled_count = countFilled(act.needs);
    return act;
  }
  if (!old || typeof old !== 'object') {
    act.filled_count = countFilled(act.needs);
    return act;
  }
  migrateAct(old, now);
  const cleared = act.memory && act.memory.prefs && typeof act.memory.prefs.reuse_cleared === 'string'
    ? act.memory.prefs.reuse_cleared.split(',').filter(Boolean)
    : [];
  for (const slot of SLOTS) {
    const cur = act.needs[slot];
    const prev = old.needs[slot];
    const curFilled = cur && String(cur.value || '').trim();
    const prevFilled = prev && String(prev.value || '').trim();
    if (!curFilled && prevFilled && !cleared.includes(slot)) act.needs[slot] = prev; // 拒绝降级：保留旧值
  }
  if (cleared.length && act.memory && act.memory.prefs) delete act.memory.prefs.reuse_cleared;   // 一次性标记：合并即消费
  act.filled_count = Math.max(countFilled(act.needs), Number(old.filled_count) || 0);
  return act;
}

module.exports = {
  SLOTS,
  SLOT_LABEL,
  SLOT_CHIPS,
  CONFLICT_CHIPS,
  conflictChips,
  emptyNeeds,
  emptyAskCount,
  normalizeSlot,
  migrateNeeds,
  plainNeeds,
  slotText,
  countFilled,
  missingSlots,
  inferredSlots,
  ensureMemory,
  migrateAct,
  mergeMonotonicAct
};
