'use strict';

/**
 * Agent context manager.
 *
 * Keeps model input inside a token budget while preserving, in order:
 * system rules, durable user-grounded memory, an earlier-turn digest, recent
 * verbatim turns, and the current user message. It intentionally uses a
 * dependency-free conservative estimator because CartBack's backend is zero-dependency.
 */

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32768;
const DEFAULT_MAX_OUTPUT_TOKENS = 512;
const DEFAULT_SAFETY_MARGIN = 1024;
const DEFAULT_RECENT_TURNS = 24;
const DEFAULT_SUMMARY_TRIGGER_RATIO = 0.72;
const MAX_MEMORY_ITEMS = 40;
const MAX_SUMMARY_NOTES = 10;
const PROFILE_SCALAR_FIELDS = ['product', 'market', 'currency', 'brand_tone', 'default_offer'];
const PROFILE_FIELDS = [...PROFILE_SCALAR_FIELDS, 'constraints'];
const DURABLE_SIGNAL_RE = /(以后|今后|永远|一直|默认|通常|每次|长期|一律|任何时候|绝不|所有(?:客户)?邮件|from now|always|default|normally|every time)/i;
const TEMPORARY_SIGNAL_RE = /(这次|本次|这一封|这封|这轮|当前活动|this time|this campaign)/i;
const CORRECTION_SIGNAL_RE = /(不是|不对|改成|改为|纠正|更新|换成|其实|之前说错|rather|instead|actually|correction)/i;
const PII_RE = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+?86[- ]?)?1[3-9]\d{9}/i;

// 引文存在不等于值有依据。只接受原文值或明确的同义归一化，拒绝自由编造。
function memoryValueText(value) {
  return String(value || '').toLowerCase().replace(/免邮|包邮|free shipping/gi, '免邮')
    .replace(/[\s，,。；;：:！!？?、"'“”‘’]|都/g, '');
}

function valueIsGrounded(value, evidence) {
  const val = memoryValueText(value), quote = memoryValueText(evidence);
  const at = quote.lastIndexOf(val);
  if (!val || at < 0) return false;
  // 不把否定句里的正向词误记成肯定事实。
  return !/(?:不允许|不可以|不得|不许|不|不要|不能|禁止|不是|not|no)(?:提供|使用|采用|默认|给|用)?$/.test(quote.slice(0, at));
}

function temporaryEvidence(userText, evidence) {
  // 使用引文所属完整分句，防止模型截掉“这次”；其他分句的长期事实仍可入库。
  return String(userText || '').split(/[，,。；;\n]/).some(clause =>
    clause.includes(evidence) && TEMPORARY_SIGNAL_RE.test(clause));
}

function samePolicySubject(a, b) {
  const subject = value => memoryValueText(value).replace(/^(?:不允许|不可以|不要|不能|禁止|允许|可以|不)/, '');
  return subject(a) && subject(a) === subject(b);
}

function replacesReferencedPolicy(old, evidence) {
  const quote = memoryValueText(evidence);
  const correction = /改成|改为|换成|纠正|更新|instead|rather/.exec(quote);
  return Boolean(correction && quote.slice(0, correction.index).includes(memoryValueText(old)));
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampRatio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.25, Math.min(0.95, n));
}

/** Conservative approximation: CJK is close to one token per character. */
function estimateTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const remainder = Math.max(0, text.length - cjk);
  return Math.ceil(cjk + remainder / 4);
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => {
    if (!message) return sum;
    return sum + 4 + estimateTokens(message.role) + estimateTokens(message.content);
  }, 2);
}

function contextOptions(options = {}) {
  return {
    contextWindowTokens: clampInt(
      options.contextWindowTokens,
      DEFAULT_CONTEXT_WINDOW_TOKENS,
      2048,
      1000000
    ),
    maxOutputTokens: clampInt(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 64, 32768),
    safetyMargin: clampInt(options.safetyMargin, DEFAULT_SAFETY_MARGIN, 128, 65536),
    recentTurns: clampInt(options.recentTurns, DEFAULT_RECENT_TURNS, 2, 100),
    summaryTriggerRatio: clampRatio(options.summaryTriggerRatio, DEFAULT_SUMMARY_TRIGGER_RATIO)
  };
}

function inputBudget(options = {}) {
  const opts = contextOptions(options);
  return Math.max(512, opts.contextWindowTokens - opts.maxOutputTokens - opts.safetyMargin);
}

function fitMessagesToBudget(messages, options = {}) {
  const opts = contextOptions(options);
  const budget = inputBudget(opts);
  const fitted = (Array.isArray(messages) ? messages : [])
    .filter(message => message && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content }));
  const originalCount = fitted.length;
  const minRecentMessages = clampInt(options.minRecentMessages, 4, 1, 20);

  let estimated = estimateMessagesTokens(fitted);
  while (estimated > budget) {
    const protectedStart = Math.max(0, fitted.length - minRecentMessages);
    const dropIndex = fitted.findIndex((message, index) => (
      message.role !== 'system' && index < protectedStart
    ));
    if (dropIndex < 0) break;
    const next = fitted[dropIndex + 1];
    const dropCount = fitted[dropIndex].role === 'user' && next && next.role === 'assistant'
      ? 2
      : 1;
    fitted.splice(dropIndex, dropCount);
    estimated = estimateMessagesTokens(fitted);
  }

  // Some providers reject/blank JSON mode when the first conversational role is assistant.
  let firstConversationIndex = fitted.findIndex(message => message.role !== 'system');
  while (firstConversationIndex >= 0 && fitted[firstConversationIndex].role === 'assistant') {
    fitted.splice(firstConversationIndex, 1);
    firstConversationIndex = fitted.findIndex(message => message.role !== 'system');
  }
  estimated = estimateMessagesTokens(fitted);

  return {
    messages: fitted,
    meta: {
      contextWindowTokens: opts.contextWindowTokens,
      inputBudgetTokens: budget,
      estimatedInputTokens: estimated,
      originalMessages: originalCount,
      keptMessages: fitted.length,
      droppedMessages: originalCount - fitted.length,
      overBudget: estimated > budget
    }
  };
}

function createEmptyMemory() {
  // PRD v2 契约：extras/prefs/ask_count/conflicts 为新代码的唯一写入面；
  // facts/decisions 保留兼容（旧 memory_patch 路径），corrections 追加制。
  return {
    facts: [],
    decisions: [],
    corrections: [],
    extras: [],
    prefs: {},
    ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 },
    clarif_count: { audience: 0, reason: 0, offer: 0, goal: 0 },
    s1_turns: 0,        // 防呆：S1 采集已用轮数（超阈值 → 推断补满强制弹确认卡）
    loop_breaks: 0,     // 防呆：循环熔断触发次数（≥2 → 强制弹确认卡）
    goal_bare: 0,       // 防呆：goal 裸类目 chip 点击次数（≥2 → 收窄后仍无数值 → 强制弹确认卡）
    conflicts: []
  };
}

function normalizeAgentProfile(profile) {
  const out = {};
  const source = profile && typeof profile === 'object' ? profile : {};
  for (const field of PROFILE_SCALAR_FIELDS) {
    const value = String(source[field] || '').trim().slice(0, 120);
    if (value && !PII_RE.test(value)) out[field] = value;
  }
  const constraints = Array.isArray(source.constraints) ? source.constraints : [];
  const cleanConstraints = constraints
    .map(value => String(value || '').trim().slice(0, 160))
    .filter(value => value && !PII_RE.test(value));
  if (cleanConstraints.length) out.constraints = [...new Set(cleanConstraints)].slice(0, 5);
  return out;
}

function applyAgentProfilePatch(profile, patch, options = {}) {
  const next = normalizeAgentProfile(profile);
  const userText = String(options.userText || '');
  const stats = { accepted: 0, rejected: 0 };
  const source = patch && typeof patch === 'object' ? patch : {};

  function admit(field, raw) {
    const value = String(raw && raw.value || '').trim().slice(0, field === 'constraints' ? 160 : 120);
    const evidence = String(raw && raw.evidence || '').trim();
    if (!PROFILE_FIELDS.includes(field) || !value || PII_RE.test(value) || !evidenceIsGrounded(userText, evidence) || !valueIsGrounded(value, evidence)) {
      stats.rejected++;
      return;
    }
    if (TEMPORARY_SIGNAL_RE.test(evidence) || temporaryEvidence(userText, evidence)) { stats.rejected++; return; }
    if ((field === 'default_offer' || field === 'constraints') && !DURABLE_SIGNAL_RE.test(userText)) {
      stats.rejected++;
      return;
    }
    if (field === 'constraints') {
      let values = Array.isArray(next.constraints) ? next.constraints : [];
      if (CORRECTION_SIGNAL_RE.test(evidence)) {
        values = values.filter(old => !replacesReferencedPolicy(old, evidence) && !samePolicySubject(old, value));
      }
      if (!values.includes(value)) values.push(value);
      next.constraints = values.slice(-5);
      stats.accepted++;
      return;
    }
    if (next[field] && next[field] !== value && !CORRECTION_SIGNAL_RE.test(evidence)) {
      stats.rejected++;
      return;
    }
    next[field] = value;
    stats.accepted++;
  }

  for (const [field, raw] of Object.entries(source)) {
    if (!PROFILE_FIELDS.includes(field)) { stats.rejected++; continue; }
    const candidates = field === 'constraints' && Array.isArray(raw) ? raw : [raw];
    for (const candidate of candidates.slice(0, 5)) admit(field, candidate);
  }
  return { profile: normalizeAgentProfile(next), stats };
}

function cleanMemoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const key = String(item.key || '').trim().slice(0, 48);
  const value = String(item.value || '').trim().slice(0, 240);
  if (!key || !value || !/^[\w\u3400-\u9fff.-]+$/u.test(key)) return null;
  return {
    key,
    value,
    sourceMessageIndex: Number.isInteger(item.sourceMessageIndex) ? item.sourceMessageIndex : null,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null
  };
}

/** corrections 双形态兼容：旧 {key,value} / 新 {slot,old,new,at,scope?}（B-1 契约，追加制） */
function cleanCorrectionItem(item) {
  if (!item || typeof item !== 'object') return null;
  const slot = String(item.slot != null ? item.slot : item.key || '').trim().slice(0, 48);
  if (!slot) return null;
  const hasNewShape = item.old != null || item.new != null;
  if (hasNewShape) {
    const old = String(item.old == null ? '' : item.old).trim().slice(0, 240);
    const nw = String(item.new == null ? '' : item.new).trim().slice(0, 240);
    if (!nw) return null;
    return {
      slot,
      old,
      new: nw,
      at: Number.isFinite(item.at) ? item.at : null,
      scope: item.scope === 'extras' ? 'extras' : undefined
    };
  }
  const value = String(item.value || '').trim().slice(0, 240);
  if (!value) return null;
  return { slot, key: slot, value, old: '', new: value, at: Number.isFinite(item.at) ? item.at : null };
}

function cleanExtraItem(item) {
  if (!item || typeof item !== 'object') return null;
  const key = String(item.key || '').trim().slice(0, 48);
  const value = String(item.value || '').trim().slice(0, 240);
  if (!key || !value) return null;
  return { key, value, at: Number.isFinite(item.at) ? item.at : null };
}

function normalizeMemory(memory) {
  const out = createEmptyMemory();
  if (!memory || typeof memory !== 'object') return out;
  for (const section of ['facts', 'decisions']) {
    const list = Array.isArray(memory[section]) ? memory[section] : [];
    out[section] = list.map(cleanMemoryItem).filter(Boolean).slice(-MAX_MEMORY_ITEMS);
  }
  const corrections = Array.isArray(memory.corrections) ? memory.corrections : [];
  out.corrections = corrections.map(cleanCorrectionItem).filter(Boolean).slice(-MAX_MEMORY_ITEMS);
  const extras = Array.isArray(memory.extras) ? memory.extras : [];
  out.extras = extras.map(cleanExtraItem).filter(Boolean).slice(-MAX_MEMORY_ITEMS);
  // B2 冲突候选（跨轮存活：本轮追问 → 下轮未回应则 C6 兜底）
  const conflicts = Array.isArray(memory.conflicts) ? memory.conflicts : [];
  out.conflicts = conflicts
    .filter(c => c && typeof c === 'object' && c.slot && c.new != null)
    .map(c => ({
      slot: String(c.slot).slice(0, 48),
      old: String(c.old == null ? '' : c.old).slice(0, 240),
      new: String(c.new).slice(0, 240),
      at: Number.isFinite(c.at) ? c.at : null,
      asked: c.asked === true
    }))
    .slice(-4);
  if (memory.prefs && typeof memory.prefs === 'object' && !Array.isArray(memory.prefs)) {
    for (const [k, v] of Object.entries(memory.prefs).slice(0, 32)) {
      const value = String(v || '').trim().slice(0, 120);
      if (k && value) out.prefs[k.slice(0, 48)] = value;
    }
  }
  if (memory.ask_count && typeof memory.ask_count === 'object') {
    for (const slot of ['audience', 'reason', 'offer', 'goal']) {
      out.ask_count[slot] = Math.max(0, Math.trunc(Number(memory.ask_count[slot]) || 0));
    }
  }
  // C6.5 拉锯保护计数（2026-10-03 裁决）：同槽澄清 ≤1 次（含 S2）
  if (memory.clarif_count && typeof memory.clarif_count === 'object') {
    for (const slot of ['audience', 'reason', 'offer', 'goal']) {
      out.clarif_count[slot] = Math.max(0, Math.trunc(Number(memory.clarif_count[slot]) || 0));
    }
  }
  // 防呆计数透传（2026-10-05）：S1 轮数 / 循环熔断次数 / goal 裸类目点击数
  out.s1_turns = Math.max(0, Math.trunc(Number(memory.s1_turns) || 0));
  out.loop_breaks = Math.max(0, Math.trunc(Number(memory.loop_breaks) || 0));
  out.goal_bare = Math.max(0, Math.trunc(Number(memory.goal_bare) || 0));
  return out;
}

function evidenceIsGrounded(userText, evidence) {
  const source = String(userText || '').replace(/\s+/g, ' ').trim();
  const quote = String(evidence || '').replace(/\s+/g, ' ').trim();
  // 长度校验 + 子串存在性 + 词边界约束（避免前缀截断：如"卖鞋"误匹配"卖鞋子"）
  if (quote.length < 2 || quote.length > 160) return false;
  const idx = source.indexOf(quote);
  if (idx === -1) return false;
  // 若引证内容结尾后紧跟 CJK 字符，需判断是否截断更长词：
  // - 若下一字符是 "的" 等结构助词，引证内容通常是完整语义单元，放行
  // - 若下一字符是其他 CJK（名词/动词），则可能是更长词的前缀，拒绝
  const afterIdx = idx + quote.length;
  if (afterIdx < source.length) {
    const next = source[afterIdx];
    if (/[㐀-鿿豈-﫿]/.test(next) && next !== '的') {
      return false;
    }
  }
  return true;
}

function applyMemoryPatch(act, patch, options = {}) {
  act.memory = normalizeMemory(act.memory);
  const userText = String(options.userText || '');
  const sourceMessageIndex = Number.isInteger(options.sourceMessageIndex)
    ? options.sourceMessageIndex
    : null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const stats = { accepted: 0, rejected: 0 };

  function admit(raw, section) {
    if (!raw || typeof raw !== 'object') { stats.rejected++; return; }
    const key = String(raw.key || '').trim().slice(0, 48);
    const value = String(raw.value || '').trim().slice(0, 240);
    const evidence = String(raw.evidence || '').trim();
    if (!key || !value || !/^[\w\u3400-\u9fff.-]+$/u.test(key) || !evidenceIsGrounded(userText, evidence) || !valueIsGrounded(value, evidence)) {
      stats.rejected++;
      return;
    }

    const isCorrection = section === 'corrections';
    let targetSection = section === 'decisions' ? 'decisions' : 'facts';
    if (isCorrection && act.memory.decisions.some(item => item.key === key)) targetSection = 'decisions';
    const target = act.memory[targetSection];
    const existingIndex = target.findIndex(item => item.key === key);
    if (isCorrection && !/(不是|改成|改为|纠正|更新|换成|其实|之前说错|rather|instead|actually|correction)/i.test(userText)) {
      stats.rejected++;
      return;
    }
    if (!isCorrection && existingIndex >= 0 && target[existingIndex].value !== value) {
      stats.rejected++;
      return;
    }

    const stored = { key, value, sourceMessageIndex, updatedAt: now };
    if (existingIndex >= 0) target[existingIndex] = stored;
    else target.push(stored);
    act.memory[targetSection] = target.slice(-MAX_MEMORY_ITEMS);

    if (isCorrection) {
      act.memory.corrections.push(stored);
      act.memory.corrections = act.memory.corrections.slice(-MAX_MEMORY_ITEMS);
    }
    stats.accepted++;
  }

  const safePatch = patch && typeof patch === 'object' ? patch : {};
  for (const fact of (Array.isArray(safePatch.facts) ? safePatch.facts : []).slice(0, 8)) admit(fact, 'facts');
  for (const decision of (Array.isArray(safePatch.decisions) ? safePatch.decisions : []).slice(0, 8)) {
    admit(decision, 'decisions');
  }
  for (const correction of (Array.isArray(safePatch.corrections) ? safePatch.corrections : []).slice(0, 8)) {
    admit(correction, 'corrections');
  }
  return stats;
}

function compactSnippet(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function updateSummary(act, cutoff) {
  const previous = act.context_summary && typeof act.context_summary === 'object'
    ? act.context_summary
    : { version: 1, through: 0, userNotes: [], summarizedMessages: 0 };
  const start = Math.max(0, Number(previous.through) || Number(act.summary_cursor) || 0);
  if (cutoff <= start) return previous;
  const source = Array.isArray(act.messages) ? act.messages.slice(start, cutoff) : [];
  const newNotes = source
    .filter(message => message && message.role === 'user')
    .map(message => compactSnippet(message.content))
    .filter(Boolean);
  return {
    version: 1,
    through: cutoff,
    summarizedMessages: (Number(previous.summarizedMessages) || 0) + source.length,
    userNotes: [...(Array.isArray(previous.userNotes) ? previous.userNotes : []), ...newNotes]
      .slice(-MAX_SUMMARY_NOTES)
  };
}

function memorySystemMessage(memory) {
  const normalized = normalizeMemory(memory);
  const hasCorrections = normalized.facts.length || normalized.decisions.length ||
    normalized.corrections.length || normalized.extras.length;
  if (!hasCorrections) return null;
  const semanticMemory = {};
  for (const section of ['facts', 'decisions']) {
    semanticMemory[section] = normalized[section].map(item => ({ key: item.key, value: item.value }));
  }
  // extras 是 PRD v2 的长期事实主写入面（品牌/品类/客单价/兴趣/时段…），模型据此呼应与回答 recall
  semanticMemory.extras = normalized.extras.map(item => ({ key: item.key, value: item.value }));
  if (normalized.corrections.length) {
    // 双形态：新 {slot,old,new} → 人话；旧 {key,value} → 键值
    semanticMemory.corrections = normalized.corrections.map(c => (
      c.new != null && (c.old != null || c.value == null)
        ? `${c.slot}: ${c.old || '(空)'} → ${c.new}`
        : { key: c.slot, value: c.value }
    ));
  }
  return {
    role: 'system',
    content: '【持久会话记忆】以下仅是用户明确说过且已通过来源校验的事实；用户纠错优先：\n' + JSON.stringify(semanticMemory)
  };
}

function agentProfileSystemMessage(profile) {
  const normalized = normalizeAgentProfile(profile);
  if (!Object.keys(normalized).length) return null;
  return {
    role: 'system',
    content: '【用户明确确认的长期店铺资料】仅在相关时使用；当前用户的新说明和纠错优先。不得声称知道资料之外的数据：\n' +
      JSON.stringify(normalized)
  };
}

function summarySystemMessage(summary) {
  if (!summary || !Array.isArray(summary.userNotes) || !summary.userNotes.length) return null;
  return {
    role: 'system',
    content: '【较早对话摘要】这些是已离开原文窗口的用户发言摘要，仅作背景；与当前用户纠错冲突时以纠错为准：\n' +
      summary.userNotes.map((note, index) => `${index + 1}. ${note}`).join('\n')
  };
}

function buildContext(options = {}) {
  const act = options.act || {};
  const opts = contextOptions(options);
  const rawHistory = (Array.isArray(act.messages) ? act.messages : [])
    .filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content }));
  let leadingAssistantMessages = 0;
  while (rawHistory[leadingAssistantMessages] && rawHistory[leadingAssistantMessages].role === 'assistant') {
    leadingAssistantMessages++;
  }
  const history = rawHistory.slice(leadingAssistantMessages);
  const current = { role: 'user', content: String(options.userText || '') };
  const baseSystem = { role: 'system', content: String(options.systemPrompt || '') };
  const profileMessage = agentProfileSystemMessage(options.agentProfile);
  const memoryMessage = memorySystemMessage(act.memory);
  const full = [baseSystem, ...(profileMessage ? [profileMessage] : []), ...(memoryMessage ? [memoryMessage] : []), ...history, current];
  const triggerTokens = inputBudget(opts) * opts.summaryTriggerRatio;
  const recentLimit = opts.recentTurns * 2;
  const shouldCompact = history.length > recentLimit || estimateMessagesTokens(full) > triggerTokens;

  let summary = act.context_summary && typeof act.context_summary === 'object' ? act.context_summary : null;
  let summaryCursor = Number(act.summary_cursor) || 0;
  let selectedHistory = history;
  let compactedMessages = 0;
  if (shouldCompact && history.length > recentLimit) {
    const cutoff = history.length - recentLimit;
    const rawCutoff = leadingAssistantMessages + cutoff;
    compactedMessages = rawCutoff;
    summary = updateSummary({ ...act, messages: rawHistory }, rawCutoff);
    summaryCursor = summary.through;
    selectedHistory = history.slice(cutoff);
  }

  const summaryMessage = summarySystemMessage(summary);
  const packed = [
    baseSystem,
    ...(profileMessage ? [profileMessage] : []),
    ...(memoryMessage ? [memoryMessage] : []),
    ...(summaryMessage ? [summaryMessage] : []),
    ...selectedHistory,
    current
  ];
  const fitted = fitMessagesToBudget(packed, {
    ...opts,
    minRecentMessages: Math.min(8, selectedHistory.length + 1)
  });

  return {
    messages: fitted.messages,
    summary,
    summaryCursor,
    meta: {
      ...fitted.meta,
      droppedMessages: fitted.meta.droppedMessages + compactedMessages,
      compactedMessages,
      compacted: Boolean(shouldCompact && summaryCursor > (Number(act.summary_cursor) || 0)),
      summaryCursor,
      recentTurns: opts.recentTurns
    }
  };
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_RECENT_TURNS,
  DEFAULT_SAFETY_MARGIN,
  DEFAULT_SUMMARY_TRIGGER_RATIO,
  PROFILE_FIELDS,
  applyAgentProfilePatch,
  applyMemoryPatch,
  buildContext,
  contextOptions,
  createEmptyMemory,
  estimateMessagesTokens,
  estimateTokens,
  fitMessagesToBudget,
  normalizeAgentProfile,
  normalizeMemory
};
