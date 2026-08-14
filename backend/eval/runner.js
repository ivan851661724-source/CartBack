#!/usr/bin/env node
'use strict';

/**
 * 离线确定性 Eval Runner（docs/architecture/AGENT_MEMORY_EVAL_BENCHMARK_DESIGN.md §10 M0）。
 *
 * 用法：npm run eval:offline          # 跑 eval/cases/mvp-v1.jsonl
 *       node eval/runner.js <file>    # 跑指定 jsonl
 *
 * 特性：
 *  - 零依赖、全离线：默认用桩模式 IGDE（无网络、无 key、确定性）；
 *    用例带 llm 脚本时注入假 callAI 重放（模拟真模型的 profile_patch / 违规首答等）。
 *  - 跨会话用例（group: cross）通过 acts 数组模拟多个 act 共享 agentProfile ——
 *    与 server.js 的「每轮 getAgentProfile → handle → persistAgentProfile」循环等价。
 *  - 断言全确定性：stage / needs 精确值 / planCard / 无连续复读 / 护栏命中 /
 *    画像期望与禁写。任何失败 → 退出码 1（硬门）。
 *  - 报告写 eval/reports/latest.json（每次覆盖，避免时间戳文件堆积）。
 */

const fs = require('fs');
const path = require('path');
const { IGDE } = require('../lib/igde');
const { normalizeAgentProfile } = require('../lib/context');

/** 解析 JSONL 用例文件（允许 # 注释行与空行） */
function loadCases(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines.map((line, idx) => {
    try { return JSON.parse(line); }
    catch (e) { throw new Error(`${file}:${idx + 1} JSON 解析失败: ${e.message}`); }
  });
}

/** 按用例 phase 建引擎：带 llm 脚本 → 假 callAI 重放；否则纯桩（离线） */
function makeEngine(phase) {
  const script = Array.isArray(phase.llm) ? phase.llm.slice() : [];
  if (!script.length) return new IGDE();
  return new IGDE({
    aiEnabled: true,
    callAI: async () => {
      if (!script.length) { const e = new Error('NO_SCRIPT'); throw e; } // 脚本耗尽 → 引擎自然离线降级
      const s = script.shift();
      return {
        reply: s.reply || '',
        needs: s.needs || {},
        memoryPatch: s.memory_patch || { facts: [], decisions: [], corrections: [] },
        profilePatch: s.profile_patch || {}
      };
    }
  });
}

function makeAct(id) {
  return {
    id, stage: 'S0', needs: {}, messages: [],
    memory: { facts: [], decisions: [], corrections: [] },
    context_summary: null, summary_cursor: 0, context_version: 1,
    status: 'active', created_at: 0, updated_at: 0, user_id: 'eval'
  };
}

/** 逐项核对 expect，失败原因写入 failures */
function check(id, exp, ctx, failures) {
  const { act, replies, guardrailUnion, last, profile } = ctx;
  const fail = (msg) => failures.push(`${id}: ${msg}`);
  if (!replies.length) return fail('没有任何回复产生');
  if (replies.some(r => !r || !r.trim())) fail('存在空回复（L0 违规）');
  if (exp.stage !== undefined && act.stage !== exp.stage) {
    fail(`stage 期望 ${exp.stage}，实际 ${act.stage}`);
  }
  for (const [k, v] of Object.entries(exp.needs || {})) {
    if (act.needs[k] !== v) fail(`needs.${k} 期望「${v}」，实际「${act.needs[k] === undefined ? '(未采集)' : act.needs[k]}」`);
  }
  for (const k of exp.needsAbsent || []) {
    if (act.needs[k]) fail(`needs.${k} 应保持为空，实际「${act.needs[k]}」`);
  }
  if (exp.planCard !== undefined && !!last.planCard !== exp.planCard) {
    fail(`planCard 期望 ${exp.planCard}，实际 ${!!last.planCard}`);
  }
  if (exp.noRepeat) {
    for (let i = 1; i < replies.length; i++) {
      if (replies[i] && replies[i] === replies[i - 1]) {
        fail(`第 ${i + 1} 轮回复与上一轮完全相同（死模板复读）：「${replies[i].slice(0, 30)}…」`);
      }
    }
  }
  const finalReply = replies[replies.length - 1] || '';
  for (const s of exp.replyIncludes || []) {
    if (!finalReply.includes(s)) fail(`最终回复应包含「${s}」，实际「${finalReply.slice(0, 40)}…」`);
  }
  for (const s of exp.replyExcludes || []) {
    if (finalReply.includes(s)) fail(`最终回复不得包含「${s}」`);
  }
  for (const h of exp.guardrailIncludes || []) {
    if (!guardrailUnion.includes(h)) fail(`guardrail 应命中 ${h}，实际 [${guardrailUnion.join(', ') || '无'}]`);
  }
  for (const h of exp.guardrailExcludes || []) {
    if (guardrailUnion.includes(h)) fail(`guardrail 不应命中 ${h}，实际 [${guardrailUnion.join(', ')}]`);
  }
  for (const [k, v] of Object.entries(exp.profile || {})) {
    if (profile[k] !== v) fail(`profile.${k} 期望「${v}」，实际「${profile[k] === undefined ? '(未写入)' : profile[k]}」`);
  }
  for (const k of exp.profileAbsent || []) {
    if (profile[k]) fail(`profile.${k} 应保持为空，实际「${profile[k]}」`);
  }
}

/** 跑一个用例（可含多个 phase = 多个 act，共享 agentProfile） */
async function runCase(def) {
  const phases = Array.isArray(def.acts) && def.acts.length
    ? def.acts
    : [{ turns: def.turns, llm: def.llm, expect: def.expect }];
  const failures = [];
  const traces = [];
  let profile = {}; // 跨 act 的长期画像（等价 server 的 agentProfile 表）
  for (const [i, phase] of phases.entries()) {
    const igde = makeEngine(phase);
    const act = makeAct(`${def.id}-p${i + 1}`);
    // 与 server.js /api/act 一致：新会话先落一条引擎开场白
    const op = igde.opening();
    act.messages.push({ role: 'assistant', content: op.reply, ts: 0 });
    const replies = [];
    const guardrailUnion = [];
    let last = null;
    for (const turn of phase.turns || []) {
      const r = await igde.handle(act, turn, { agentProfile: normalizeAgentProfile(profile) });
      if (r.agentMeta && r.agentMeta.agentProfile) profile = r.agentMeta.agentProfile;
      replies.push(r.reply);
      for (const h of r.guardrailHits || []) if (!guardrailUnion.includes(h)) guardrailUnion.push(h);
      last = r;
    }
    check(def.id, phase.expect || {}, { act, replies, guardrailUnion, last, profile }, failures);
    traces.push({ actId: act.id, stage: act.stage, needs: act.needs, replies, guardrailHits: guardrailUnion, profile: normalizeAgentProfile(profile) });
  }
  return {
    id: def.id, group: def.group || 'misc', desc: def.desc || '',
    ok: failures.length === 0, failures, traces
  };
}

/** 跑整个套件，返回汇总（不落盘、不退码，便于测试复用） */
async function runSuite(file) {
  const cases = loadCases(file);
  const results = [];
  for (const def of cases) results.push(await runCase(def));
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] || { total: 0, failed: 0 };
    byGroup[r.group].total++;
    if (!r.ok) byGroup[r.group].failed++;
  }
  return {
    suite: path.basename(file, '.jsonl'),
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    byGroup, cases: results
  };
}

async function main() {
  const file = process.argv[2] || path.join(__dirname, 'cases', 'mvp-v1.jsonl');
  const report = await runSuite(file);
  for (const r of report.cases) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.id} — ${r.desc}`);
    for (const f of r.failures) console.log(`        ↳ ${f}`);
  }
  console.log(`\n${report.passed}/${report.total} passed` + (report.failed ? `（${report.failed} 失败）` : ''));
  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportFile = path.join(reportsDir, 'latest.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log('report → ' + path.relative(process.cwd(), reportFile));
  process.exit(report.failed ? 1 : 0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(2); });

module.exports = { loadCases, runCase, runSuite };
