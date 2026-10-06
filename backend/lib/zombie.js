'use strict';
/**
 * lib/zombie.js — Wave 5 A4 僵尸会话收口（唯一权威；server 定时任务与测试共用）。
 *
 * 产品口径（PRD A4，P2）：
 *  - 每小时扫描：stage ∈ {S0, S1} 且最后活跃（updated_at）> 48h 的 act → 收口；
 *    S2 可能正等确认（四要素齐、等 /confirm），闲置 > 7 天才收口。
 *  - 收口 = 生成结构化待办「{已记录项}，还差 {缺失槽列表}」（中文槽名，绝不带进度数字）
 *    + act 置 stage=closed（只读归档）+ 审计事件（events type='audit'）。
 *  - 用户点待办 → POST /api/todos/:id/resume：复制原 act 的 needs/memory 到新 act（stage=S1，进度保留），
 *    原待办置 done=1，原 act 保持 closed（幂等：已 done 再 resume → 409）。
 *
 * 本模块零网络依赖：store 注入；时钟经 opts.now 注入（默认 Date.now()）。
 */

const { ZOMBIE_S1_IDLE_MS, ZOMBIE_S2_IDLE_MS } = require('./config');
const { migrateNeeds, missingSlots, SLOTS } = require('./needs');

// 待办摘要用中文槽短名（契约样例口径：受众/原因/优惠/目标；与 SLOT_LABEL 的追问语区分）
const ZOMBIE_SLOT_ZH = { audience: '受众', reason: '原因', offer: '优惠', goal: '目标' };

/**
 * 待办摘要（契约①形状）：「挽回{受众值}：已记录{已记录槽}，还差 {缺失槽}」。
 * 铁律：不带进度数字（不出现「2/4」这类）；四槽全齐（S2 收口）→ 「就差你确认」收尾。
 */
function zombieSummary(act, { now } = {}) {
  const needs = migrateNeeds(act && act.needs, Number(now) || Date.now());
  const filled = [];
  const missing = [];
  for (const s of SLOTS) {
    const v = needs[s] && String(needs[s].value || '').trim();
    (v ? filled : missing).push(ZOMBIE_SLOT_ZH[s]);
  }
  const audRaw = (needs.audience && String(needs.audience.value || '')) || '';
  const aud = audRaw.replace(/客户|人群|顾客|用户/g, '').trim();
  const prefix = aud ? `挽回${aud}` : '挽回计划';
  const recorded = filled.length ? `已记录${filled.join('与')}` : '暂无已记录项';
  const tail = missing.length ? `，还差 ${missing.join('、')}` : '，就差你确认了';
  return `${prefix}：${recorded}${tail}`;
}

/**
 * A4 扫描收口（独立函数，可直接被测试调用；server 每小时经 queue 调一次）。
 * @param {object} opts
 *   now        —— 时钟注入（测试边界用）
 *   s1IdleMs   —— S0/S1 闲置阈值（默认 config.ZOMBIE_S1_IDLE_MS = 48h）
 *   s2IdleMs   —— S2 闲置阈值（默认 config.ZOMBIE_S2_IDLE_MS = 7 天）
 *   userId     —— 只扫该商家（缺省扫全量；todos 按 act.user_id 归属）
 * @returns {[{act_id, summary, todo_id}]} 本次收口的会话列表
 */
function sweepZombieActs(store, opts = {}) {
  const at = Number(opts.now) || Date.now();
  const w1 = Number(opts.s1IdleMs) > 0 ? Number(opts.s1IdleMs) : ZOMBIE_S1_IDLE_MS;
  const w2 = Number(opts.s2IdleMs) > 0 ? Number(opts.s2IdleMs) : ZOMBIE_S2_IDLE_MS;
  const rows = store.getActs();   // 全量 act（含 closed；读取即惰性迁移）
  const openTodoActs = new Set(store.listTodos().filter(t => !t.done).map(t => t.act_id));
  const closed = [];
  let changed = false;
  for (const act of rows) {
    if (!['S0', 'S1', 'S2'].includes(act.stage)) continue;
    if (opts.userId != null && act.user_id && act.user_id !== opts.userId) continue;
    const lastActive = Number(act.updated_at) || Number(act.created_at) || 0;
    const limit = act.stage === 'S2' ? w2 : w1;
    if (!(at - lastActive > limit)) continue;
    const summary = zombieSummary(act, { now: at });
    const filledCount = SLOTS.filter(s => {
      const v = act.needs && act.needs[s];
      return v && String(typeof v === 'object' ? v.value : v || '').trim();
    }).length;
    act.stage = 'closed';
    act.updated_at = at;
    changed = true;
    // 收口动作写审计（events type='audit'；order_id 可回溯会话）
    store.addEvent({
      type: 'audit', draft_id: act.id, audience_id: null,
      value: filledCount, order_id: `zombie_close:${act.id}`, ts: at
    });
    // 待办进商家待办列表（同一 act 不重复挂待办）
    if (!openTodoActs.has(act.id)) {
      const todo = store.addTodo({
        user_id: act.user_id || null, act_id: act.id,
        type: 'zombie_session', summary, done: 0, created_at: at
      });
      closed.push({ act_id: act.id, summary, todo_id: todo.id });
    } else {
      closed.push({ act_id: act.id, summary, todo_id: null });
    }
  }
  if (changed) store._write('acts', rows);
  return closed;
}

/**
 * resume 预填（POST /api/todos/:id/resume 的核心逻辑；server 层负责鉴权/幂等 409）：
 * 复制原 act 的 needs/memory 到新 act（stage=S1，进度保留），清掉复用标记（预填语义重算），
 * 首条助手消息 = 待办摘要 + 单点追问第一个缺失槽。
 * @returns 新 act 对象（调用方负责落库/closeOpenActs/置待办 done）
 */
function buildResumedAct(srcAct, { id, now } = {}) {
  const at = Number(now) || Date.now();
  const memory = JSON.parse(JSON.stringify(srcAct.memory || {}));
  // 恢复业务进度，不继承旧对话已经耗尽的追问预算。
  memory.s1_turns = 0;
  memory.loop_breaks = 0;
  memory.goal_bare = 0;
  memory.ask_count = { audience: 0, reason: 0, offer: 0, goal: 0 };
  memory.clarif_count = { audience: 0, reason: 0, offer: 0, goal: 0 };
  for (const conflict of (memory.conflicts || [])) conflict.asked = false;
  if (memory.prefs && typeof memory.prefs === 'object') {
    for (const k of ['reuse_at', 'reuse_slots', 'reuse_cleared', 'reused_from']) delete memory.prefs[k];
  }
  const act = {
    id: id || `act_resume_${String(srcAct.id).slice(0, 12)}_${at.toString(36)}`,
    stage: 'S1',
    needs: migrateNeeds(JSON.parse(JSON.stringify(srcAct.needs || {})), at),
    messages: [],
    memory,
    context_summary: null, summary_cursor: 0, context_version: 1,
    code_status: 'none', filled_count: 0,
    status: 'active', created_at: at, updated_at: at,
    user_id: srcAct.user_id || null,
    resumed_from: srcAct.id   // 留痕：由哪个收口会话恢复（前端可不展示）
  };
  const missing = missingSlots(act.needs);
  const opener = `接着上次的进度继续（${zombieSummary(srcAct, { now: at })}）。`
    + (missing.length ? `先补一块：${ZOMBIE_PROBE[missing[0]] || ''}` : '四样都齐了，在下面确认卡里核对一下就行。');
  act.messages.push({ role: 'assistant', content: opener, ts: at });
  if (srcAct.flow_version === 6) {
    const flow = require('./conversation-v6');
    act.flow_version = 6;
    act.business_version = 1;
    act.flow_state = { intent: true, candidates: JSON.parse(JSON.stringify(srcAct.flow_state?.candidates || [])), actions: [] };
    flow.initialize(act); flow.refreshActions(act);
    act.messages[0].content = '已恢复上次保存的信息。原因和量化目标可选，你可以继续修改，或先看邮件预览。';
  }
  return act;
}

// resume 开场追问语（与 igde.probeFor 同口径抽到这里，避免 zombie → igde 反向依赖）
const ZOMBIE_PROBE = {
  audience: '先说最想挽回哪拨人？弃购的、加购没付的，还是好久没来的老客？',
  reason: '他们为啥快丢了？太久没动静、被竞品勾走，还是单纯忘了？',
  goal: '你希望他们回来干啥？再下一单、回来逛逛，还是唤醒沉睡的？',
  offer: '想给点什么钩子？折扣、专属优惠码，还是包邮 / 限时？'
};

module.exports = {
  ZOMBIE_SLOT_ZH,
  ZOMBIE_PROBE,
  zombieSummary,
  sweepZombieActs,
  buildResumedAct
};
