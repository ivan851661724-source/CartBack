'use strict';
/**
 * 真模型联调（不入 CI）：用真实 LLM 把 PRD 21 句验收剧本按序重放到同一个 act，
 * 宽容断言（contains / 存在性 / 单调性），逐句报告 pass/fail + 实际输出。
 * 与 eval/replay21.js（脚本化 envelope，CI 用）互补：本脚本验证「真模型是否听懂剧本」。
 *
 * 用法：node eval/manual/replay21-real.js [--model qwen3.7-plus] [--fast]
 *   --fast  只跑前 11 句（省 token；#12-#21 依赖批次/汇报域，可单独跑）
 * 接线与 server.js llmCoach 同款（enable_thinking 等 extraBody 由 config.json 携带）。
 */
const path = require('path');
const fs = require('fs');
const { LLMClient } = require('../../lib/llm');
const { IGDE } = require('../../lib/igde');
const { slotText, mergeMonotonicAct } = require('../../lib/needs');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const FAST = args.includes('--fast');
const config = require('../../lib/config').load();
if (opt('--model')) { config.aiModel = opt('--model'); }

const client = new LLMClient({
  baseUrl: config.aiBaseUrl,
  model: config.aiModel,
  apiKey: config.aiKey,
  timeoutMs: 45000,
  contextWindowTokens: config.aiContextWindowTokens,
  contextSafetyMargin: config.aiContextSafetyMargin,
  extraBody: config.aiExtraBody || null
});

if (!config.aiKey) { console.error('未配置 AI key（backend/.server/config.json aiKey）'); process.exit(2); }

async function callAI(messages, opts) {
  const r = (opts && opts.onReplyToken)
    ? await client.streamChatStructured({ messages, maxTokens: config.aiMaxOutputTokens, onReplyToken: opts.onReplyToken })
    : await client.chatStructured({ messages, maxTokens: config.aiMaxOutputTokens });
  return {
    reply: r.reply, needs: r.needs,
    slotUpdates: r.slotUpdates || [], extras: r.extras || [], corrections: r.corrections || [],
    memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, jsonOk: r.jsonOk
  };
}

async function callCritic(text) {
  try {
    const r = await client.chatStructured({
      messages: [
        { role: 'system', content: '你是严格的内容审查员。判断文本是否「说教 / 推销 / 列清单 / 替用户下结论」。只回 JSON {"bad":true} 或 {"bad":false}，不要其它内容。' },
        { role: 'user', content: text }
      ],
      maxTokens: 512
    });
    const content = r.raw && r.raw.choices && r.raw.choices[0] && r.raw.choices[0].message.content;
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.bad === 'boolean') return !parsed.bad;
    return true;
  } catch (e) { return false; }
}

const igde = new IGDE({
  aiEnabled: true,
  callAI,
  callCritic,
  maxLlmCallsPerTurn: config.aiMaxCallsPerTurn,
  criticMode: 'off'   // 剧本重放关闭 critic（省一半调用；观察对象是 envelope 质量）
});

const CASES_FILE = path.join(__dirname, '..', 'cases', 'prd-v2.jsonl');
const cases = fs.readFileSync(CASES_FILE, 'utf8').trim().split('\n').map(JSON.parse);
const byId = Object.fromEntries(cases.map(c => [c.id, c]));
// 剧本自然顺序（同 test/acceptance21）：p01→p11、p13、p15、p16、p17-p20；--fast 只跑到 p11
const ORDER = ['p01','p02','p03','p04','p05','p06','p07','p08','p09','p10','p11','p13','p15','p16','p17','p18','p19','p20','p12','p14','p21'];
const runOrder = FAST ? ORDER.slice(0, 11) : ORDER;

function mkAct() {
  return {
    id: 'act_realmodel', user_id: 'u_real', stage: 'S0',
    needs: { audience: null, reason: null, offer: null, goal: null },
    messages: [], memory: { corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 }, conflicts: [] },
    created_at: Date.now(), updated_at: Date.now(), filled_count: 0, code_status: 'none'
  };
}

// —— 宽容断言器：每句一组检查，失败收集不中断 ——
const ex = (act) => Object.fromEntries((act.memory.extras || []).map(e => [e.key, e.value]));
function checksFor(id, act, r) {
  const X = ex(act);
  const slot = (s) => slotText(act.needs, s);
  const has = (h, re, note) => { try { if (!re.test(h)) throw new Error(note + ' 未命中'); } catch (e) { return e.message; } return null; };
  const C = [];
  const add = (name, fn) => { try { fn(); C.push({ name, pass: true }); } catch (e) { C.push({ name, pass: false, got: e.message }); } };
  const expectSlotsFilled = (n) => add(`filled_count>=${n}`, () => { if (act.filled_count < n) throw new Error('实际 ' + act.filled_count); });

  switch (id) {
    case 'p01':
      add('extras 含品牌 LunaGlow', () => { if (!/lunaglow/i.test(X.brand || '')) throw new Error('brand=' + (X.brand || '无')); });
      add('extras 含品类', () => { if (!/蜡烛|香薰/.test(Object.values(X).join('|'))) throw new Error(JSON.stringify(X)); });
      add('audience 仍空', () => { if (slot('audience')) throw new Error('被填=' + slot('audience')); });
      add('复述含品牌', () => { const e = has(r.reply, /LunaGlow|香薰|蜡烛/i, '品牌/品类'); if (e) throw new Error(e); });
      break;
    case 'p02':
      add('audience 含人群细节', () => { if (!/25|40|女|美国/.test(slot('audience'))) throw new Error('audience=' + slot('audience')); });
      break;
    case 'p03':
      add('客单价 correction 生效', () => { if (!/35/.test(Object.values(X).join('|'))) throw new Error('extras 无 35：' + JSON.stringify(X)); });
      add('回复含 35', () => { const e = has(r.reply, /35/, '35'); if (e) throw new Error(e); });
      break;
    case 'p04':
      add('audience 不被「年轻人」直接覆盖', () => { if (/^年轻人$/.test(slot('audience'))) throw new Error('被直接覆盖'); });
      add('回复出现核实/对齐语气', () => { const e = has(r.reply, /哪个为准|以哪个|确认|核实|还是|对齐|25-34|18-24|维持/, '核实语气'); if (e) throw new Error(e); });
      break;
    case 'p05':
      add('reason 含「加购未付」（回归样本）', () => { if (!/加购|未付|付款/.test(slot('reason'))) throw new Error('reason=' + slot('reason')); });
      break;
    case 'p06':
      add('offer=10% off', () => { if (!/10\s*%|10%/.test(slot('offer'))) throw new Error('offer=' + slot('offer')); });
      break;
    case 'p07':
      add('发送时段进 extras', () => { if (!/8|晚/.test(Object.keys(X).join('|') + Object.values(X).join('|'))) throw new Error(JSON.stringify(X)); });
      break;
    case 'p08':
      add('产品特色进 extras', () => { if (!/大豆蜡|长烧|48/.test(Object.values(X).join('|'))) throw new Error(JSON.stringify(X)); });
      break;
    case 'p09':
      add('goal 含 100', () => { if (!/100/.test(slot('goal'))) throw new Error('goal=' + slot('goal')); });
      add('filled_count=4', () => { if (act.filled_count !== 4) throw new Error('实际 ' + act.filled_count); });
      add('stage=S2', () => { if (act.stage !== 'S2') throw new Error('实际 ' + act.stage); });
      break;
    case 'p10':
      add('offer 不被「发送频率」错切', () => { if (/频率|每周/.test(slot('offer'))) throw new Error('offer 被污染=' + slot('offer')); });
      add('offer 保持 10%', () => { if (!/10/.test(slot('offer'))) throw new Error('offer=' + slot('offer')); });
      break;
    case 'p11':
      add('不清零：filled_count 仍 4', () => { if (act.filled_count !== 4) throw new Error('实际 ' + act.filled_count); });
      add('同值忽略：goal 无 correction', () => { const last = (act.memory.corrections || []).slice(-1)[0]; if (last && last.slot === 'goal' && /100/.test(last.new || '')) throw new Error('goal 被重复记账'); });
      break;
    case 'p13':
      add('stage 停留 S2（S2→S3 唯一入口 confirm）', () => { if (act.stage !== 'S2') throw new Error('实际 ' + act.stage); });
      break;
    case 'p15':
      add('audience 含 老客', () => { if (!/老客|沉睡|流失/.test(slot('audience'))) throw new Error('audience=' + slot('audience')); });
      add('offer 含 15%', () => { if (!/15/.test(slot('offer'))) throw new Error('offer=' + slot('offer')); });
      break;
    case 'p16':
      add('stage 保持 S2', () => { if (act.stage !== 'S2') throw new Error('实际 ' + act.stage); });
      add('filled_count 保持 4', () => { if (act.filled_count !== 4) throw new Error('实际 ' + act.filled_count); });
      break;
    case 'p17':
      add('回复含批次拆分语义', () => { const e = has(r.reply, /两批|批次|分别|A.*B|加购.*下单/, '拆批'); if (e) throw new Error(e); });
      break;
    case 'p18':
      add('回复含停发语义', () => { const e = has(r.reply, /停发|全停|日历|黑五|11-27|11-28/, '停发'); if (e) throw new Error(e); });
      break;
    case 'p19':
      add('回复含边界声明语义', () => { const e = has(r.reply, /已发|不受影响|未发|没发/, '边界声明'); if (e) throw new Error(e); });
      break;
    case 'p12':
      add('拒绝中文邮件+解释', () => { const e = has(r.reply, /英文|中文|语种|语言|看不懂|效果/, '语种解释'); if (e) throw new Error(e); });
      break;
    case 'p14':
      add('不编造不崩溃：有正常回复', () => { if (!r.reply || r.reply.length < 4) throw new Error('空回复'); });
      add('拉回正题语义', () => { const e = has(r.reply, /正事|邮件|挽回|还差|先|聊/, '拉回'); if (e) throw new Error(e); });
      break;
    case 'p21':
      add('批次汇报语义', () => { const e = has(r.reply, /批次|A|加购|跑|发送|暂无|还没/, '汇报'); if (e) throw new Error(e); });
      break;
    default: break;
  }
  // 通用不变量（每句都查）
  add('通用:回复非空', () => { if (!r.reply || r.reply.trim().length < 2) throw new Error('空回复'); });
  add('通用:不暴露槽位英文名', () => { if (/\b(audience|reason|offer|goal|slot_updates)\b/.test(r.reply)) throw new Error('泄漏字段名'); });
  return C;
}

(async () => {
  const act = mkAct();
  const opening = igde.opening({ hasAnyAct: false, storeBanner: null });
  act.messages.push({ role: 'assistant', content: opening.reply, ts: Date.now() });
  console.log('【开场】' + opening.reply.slice(0, 80).replace(/\n/g, ' '));

  const report = { model: config.aiModel, base_url: config.aiBaseUrl, started_at: new Date().toISOString(), turns: [] };
  let passCount = 0;

  for (const id of runOrder) {
    const input = byId[id] && byId[id].input;
    if (!input) { console.log(`⚠ ${id} 无 input，跳过`); continue; }
    // persist 语义与 store.upsertAct 同款：落库前做单调合并、计算 filled_count（脚本内存版）
    const prev = JSON.parse(JSON.stringify({ needs: act.needs, filled_count: act.filled_count, memory: act.memory }));
    const t0 = Date.now();
    let r;
    try {
      r = await igde.handle(act, input, {
        locale: 'en',
        persist: (a) => { mergeMonotonicAct(a, prev); return a; }
      });
    } catch (e) {
      report.turns.push({ id, input, error: e.message });
      console.log(`✗ ${id} 引擎异常: ${e.message}`);
      continue;
    }
    const dt = Date.now() - t0;
    const checks = checksFor(id, act, r);
    const ok = checks.every(c => c.pass);
    if (ok) passCount++;
    report.turns.push({
      id, input, reply: r.reply, engine: r.engine, chips: r.chips,
      stage: act.stage, filled: act.filled_count,
      needs: Object.fromEntries(['audience', 'reason', 'offer', 'goal'].map(s => [s, slotText(act.needs, s) || null])),
      extras: act.memory.extras, corrections: act.memory.corrections, latency_ms: dt, checks
    });
    const mark = ok ? '✓' : '✗';
    const fails = checks.filter(c => !c.pass).map(c => `${c.name}${c.got ? '（' + c.got + '）' : ''}`).join('; ');
    console.log(`${mark} ${id} [${dt}ms ${r.engine}] stage=${act.stage} filled=${act.filled_count} chips=[${(r.chips || []).join(',')}]`
      + `\n    输入: ${input}`
      + `\n    回复: ${(r.reply || '').slice(0, 90).replace(/\n/g, ' ')}`
      + `\n    needs: ${JSON.stringify(report.turns[report.turns.length - 1].needs)}`
      + (fails ? `\n    ✗ 断言: ${fails}` : ''));
  }

  report.pass = passCount;
  report.total = runOrder.length;
  report.finished_at = new Date().toISOString();
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'real-model-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n========================================');
  console.log(`真模型剧本重放：${passCount}/${runOrder.length} 通过   report → ${path.relative(process.cwd(), outFile)}`);
  process.exit(passCount === runOrder.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
