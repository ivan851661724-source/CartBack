'use strict';
/**
 * lib/acceptance/assert.js — PRD v2 21 句验收的离线断言基建。
 *
 * 复用现有「假 callAI 注入缝」（与 eval/runner.js、test/igde-context/streaming 同模式）：
 * 引擎按句重放脚本化 envelope（PRD v2 新契约 {reply, restatement, slot_updates, extras, corrections}），
 * 断言全部打在引擎行为上（B1 依据校验 / B2 合并与冲突 / B3 先落库后回复 / B4 选问与 chips / B5 组装）。
 *
 * 零依赖（node:assert 除外），供 test/acceptance21.test.js 与后续手工回放脚本共用。
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const { IGDE } = require('../igde');
const { SLOTS, SLOT_CHIPS } = require('../needs');

/** 读取 jsonl 用例（允许 # 注释行 / 空行） */
function loadCases(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines.map((line, idx) => {
    try { return JSON.parse(line); }
    catch (e) { throw new Error(`${file}:${idx + 1} JSON 解析失败: ${e.message}`); }
  });
}

/** 三态槽位 → 断言用字符串 */
function slotText(slot) {
  if (slot == null) return '';
  return typeof slot === 'object' ? String(slot.value || '') : String(slot);
}

function extrasMap(memory) {
  const map = {};
  for (const e of (memory && memory.extras) || []) map[e.key] = e.value;
  return map;
}

/**
 * 构造脚本化引擎：envelopes 队列逐轮弹出（与 in-scope 输入一一对应）。
 * 模拟真模型流式：opts.onReplyToken 存在时先逐段推预览，再返回结构化 envelope。
 * events 记录本轮事件序列（llm / persist / token），供 B3「先落库后回复」断言。
 * scriptExhausted 时抛错（模拟模型失联 → 引擎离线降级）。
 * extraOpts：附加引擎注入缝（Wave 3 批次域 executors 等），向后兼容。
 */
function makeScriptedEngine(envelopes, events, extraOpts = {}) {
  const script = envelopes.slice();
  const ev = events || [];
  return new IGDE({
    aiEnabled: true,
    criticMode: 'off',
    callAI: async (messages, opts) => {
      ev.push({ t: 'llm', at: Date.now() });
      if (!script.length) throw new Error('NO_SCRIPT');
      const env = script.shift();
      if (opts && typeof opts.onReplyToken === 'function' && env.reply) {
        for (let i = 0; i < env.reply.length; i += 4) opts.onReplyToken(env.reply.slice(i, i + 4));
      }
      return env;
    },
    ...extraOpts
  });
}

/**
 * B3 persist 录制器：与 store.upsertAct 同语义（mergeMonotonicAct：filled_count 落库计算 + 单调不减）。
 * 返回 persist(act) 回调；persistCalls/events 供断言。
 */
function makePersistRecorder(events, persistCalls) {
  const { mergeMonotonicAct } = require('../needs');
  let snapshot = null;
  return (act) => {
    mergeMonotonicAct(act, snapshot);
    snapshot = JSON.parse(JSON.stringify(act));
    if (persistCalls) persistCalls.push(act.id);
    if (events) events.push({ t: 'persist', at: Date.now() });
  };
}

/** 与 server.js /api/act 同构的空 act（新契约全字段） */
function makeAcceptanceAct(id) {
  return {
    id: id || 'act_acceptance21',
    stage: 'S0',
    needs: { audience: null, reason: null, offer: null, goal: null },
    messages: [],
    memory: { facts: [], decisions: [], corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 } },
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0,
    status: 'active', created_at: 0, updated_at: 0, user_id: 'acceptance'
  };
}

/** 逐句断言核心：通用不变量 + 传入的 per-turn 检查 */
function assertTurnCommon(invariant, act, result, turn) {
  // act 身份不漂移
  assert.equal(invariant.actId, act.id, 'act.id 必须全程不变');
  // filled_count 单调不减
  assert.ok(
    act.filled_count >= invariant.lastFilled,
    `filled_count 单调不减：${act.filled_count} < ${invariant.lastFilled}`
  );
  invariant.lastFilled = act.filled_count;
  // code_status 本波恒 none
  assert.equal(act.code_status, 'none', 'code_status 本波恒为 none');
  // 引擎档位：在线脚本路径恒 online
  assert.equal(result.engine, 'online', '在线脚本路径 engine 应为 online');
  // chips 与追问一致：有追问则 chips 非空或为指定集合；无追问则必为 []
  if (turn && turn.expect && Array.isArray(turn.expect.chips)) {
    assert.deepEqual(result.chips, turn.expect.chips, `chips 契约不符（${turn.id}）`);
  }
  if (turn && turn.expect && Number.isFinite(turn.expect.filled)) {
    assert.equal(act.filled_count, turn.expect.filled, `filled_count 不符（${turn.id}）`);
  }
}

/** 槽位断言：expected = { audience: {contains:['25'], source:'explicit'} | null, ... } */
function assertSlots(act, expected, label) {
  for (const [slot, want] of Object.entries(expected || {})) {
    assert.ok(SLOTS.includes(slot), `${label}: 未知槽位 ${slot}`);
    const cur = act.needs[slot];
    if (want === null) {
      assert.equal(cur, null, `${label}: needs.${slot} 应为空，实际 ${JSON.stringify(cur)}`);
      continue;
    }
    assert.ok(cur, `${label}: needs.${slot} 应已填，实际为空`);
    const value = slotText(cur);
    for (const frag of want.contains || []) {
      assert.ok(value.includes(frag), `${label}: needs.${slot}="${value}" 应包含「${frag}」`);
    }
    if (want.equals !== undefined) assert.equal(value, want.equals, `${label}: needs.${slot} 值不符`);
    if (want.source) assert.equal(cur.source, want.source, `${label}: needs.${slot}.source 不符`);
  }
}

function assertExtras(act, expected, label) {
  const map = extrasMap(act.memory);
  for (const [key, want] of Object.entries(expected || {})) {
    if (want === undefined) {
      assert.ok(key in map, `${label}: extras 应含「${key}」`);
      continue;
    }
    assert.equal(map[key], want, `${label}: extras[${key}] 期望「${want}」，实际「${map[key]}」`);
  }
}

function assertCorrectionsCount(act, expected, label) {
  const n = (act.memory.corrections || []).length;
  assert.equal(n, expected, `${label}: corrections 条数期望 ${expected}，实际 ${n}`);
}

function assertReplyIncludes(result, frags, label) {
  for (const f of frags) {
    assert.ok((result.reply || '').includes(f), `${label}: 回复应包含「${f}」，实际「${(result.reply || '').slice(0, 60)}…」`);
  }
}

/** B3 顺序断言：本轮 persist 必须先于第一个 token 帧（先落库后回复） */
function assertPersistBeforeTokens(events, label) {
  const persistIdx = events.findIndex(e => e.t === 'persist');
  const tokenIdx = events.findIndex(e => e.t === 'token');
  assert.ok(persistIdx !== -1, `${label}: 本轮应有一次 persist 落库`);
  assert.ok(tokenIdx !== -1, `${label}: 在线流式轮应有 token 帧`);
  assert.ok(persistIdx < tokenIdx, `${label}: persist(${persistIdx}) 必须先于第一个 token(${tokenIdx}) —— B3 先落库后回复`);
}

/** chips 常量再出口（测试侧与引擎侧同源，防两处硬编码漂移） */
function chipsFor(slot) { return SLOT_CHIPS[slot] || []; }

module.exports = {
  loadCases,
  slotText,
  extrasMap,
  makeScriptedEngine,
  makePersistRecorder,
  makeAcceptanceAct,
  assertTurnCommon,
  assertSlots,
  assertExtras,
  assertCorrectionsCount,
  assertReplyIncludes,
  assertPersistBeforeTokens,
  chipsFor,
  assert
};
