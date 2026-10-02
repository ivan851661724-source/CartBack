'use strict';
/**
 * 30 轮场景真模型测试（不入 CI）：在 21 句验收剧本之外，覆盖复用/否认、人群画像、
 * E1 冲动拦截两轮、I2 全停恢复、E4/E5、S2 改参、F2 算账、批次全链（建批→确认→
 * 运维→汇报→停发日历）、闲聊挂起等场景。宽容断言 + 通用不变量，逐轮报告。
 *
 * 用法：node eval/manual/scenario30-real.js
 * 报告：eval/output/scenario30-report.json
 */
const path = require('path');
const fs = require('fs');
const config = require('../../lib/config').load();
const { LLMClient } = require('../../lib/llm');
const { IGDE } = require('../../lib/igde');
const { slotText, mergeMonotonicAct, SLOT_CHIPS } = require('../../lib/needs');

const client = new LLMClient({
  baseUrl: config.aiBaseUrl, model: config.aiModel, apiKey: config.aiKey,
  timeoutMs: 45000, contextWindowTokens: config.aiContextWindowTokens,
  contextSafetyMargin: config.aiContextSafetyMargin, extraBody: config.aiExtraBody || null
});
if (!config.aiKey) { console.error('未配置 AI key'); process.exit(2); }

async function callAI(messages, opts) {
  const r = (opts && opts.onReplyToken)
    ? await client.streamChatStructured({ messages, maxTokens: config.aiMaxOutputTokens, onReplyToken: opts.onReplyToken })
    : await client.chatStructured({ messages, maxTokens: config.aiMaxOutputTokens });
  return { reply: r.reply, needs: r.needs, slotUpdates: r.slotUpdates || [], extras: r.extras || [], corrections: r.corrections || [], memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, jsonOk: r.jsonOk };
}
async function callCritic(text) { return true; } // 场景测试关闭 critic（观察对象是引擎/槽位行为）

// —— 批次域执行器桩（形状对齐 server.js executor，采集调用供断言）——
function makeExecutorStub() {
  const calls = { previewBatches: [], createBatches: [], campaignOps: [], pauseAll: 0, resumeAll: 0, addBlackout: [], audits: [] };
  return {
    calls,
    async previewBatches(batches) {
      calls.previewBatches.push(batches);
      return batches.map((b, i) => ({ name: `${'ABC'[i]} ${b.audience_desc}`, audience_desc: b.audience_desc, offer_text: b.offer_text || '10% off', percent_off: 15, reach_count: String(b.audience_desc).includes('加购') ? 23 : 17, excluded: [{ reason: '已购买（店铺已下单）', count: 2 }] }));
    },
    async createBatches(batches) {
      calls.createBatches.push(batches);
      return { campaigns: batches.map((b, i) => ({ id: 'cmp_' + i, name: `${'ABC'[i]} ${b.audience_desc}`, audience_desc: b.audience_desc, status: 'draft', discount: { text: '折扣码 CART' + i + '（已在你的店铺创建 ✅）', code: 'CART' + i, code_status: 'created' }, reach_count: String(b.audience_desc).includes('加购') ? 23 : 17, scheduled_at: null })), failures: [], advice: null };
    },
    resolveTarget() { return { campaign_id: 'cmp_0', name: 'A 加购未付' }; },
    async campaignOp(o) {
      calls.campaignOps.push(o);
      const isDiscount = o && o.op === 'discount';
      return { ok: true, name: 'A 加购未付', code: isDiscount ? 'NEW12' : 'KEEP', oldCode: 'OLD', changed: isDiscount ? ['折扣改为 12%'] : ['已暂停'], boundary: '已发 18 封不受影响，改的是未发的 5 封' };
    },
    async pauseAll() { calls.pauseAll += 1; return { ok: true, paused: 2, frozen: 1 }; },
    async resumeAll() { calls.resumeAll += 1; return { ok: true, resumed: ['A 加购未付', 'B 下单未付'], resumed_count: 2 }; },
    async addBlackout(params) { calls.addBlackout.push(params); return { ok: true, range: { from: params.from, to: params.to, label: params.label } }; },
    listCampaignReports() {
      return [
        { id: 'cmp_0', name: 'A 加购未付', status: 'paused', reach_count: 23, sent_count: 18, pending_count: 5, stats: { opened: 2, clicked: 1, recovered: 2, gmv: 120, net: 108 } },
        { id: 'cmp_1', name: 'B 下单未付', status: 'running', reach_count: 17, sent_count: 9, pending_count: 8, stats: { opened: 5, clicked: 2, recovered: 1, gmv: 60, net: 54 } }
      ];
    },
    saleWindow() { return false; },
    audit(entry) { calls.audits.push(entry); return { ok: true }; }
  };
}

const SCENARIOS = [
  { id: 's01', input: '照上次的来，这周也给加购未付的来一版', reuse: true,
    check: (a, r) => { const e = []; if (!/上次|理解|纠正|加购/.test(r.reply)) e.push('回复未复述/未接住复用'); return e; } },
  { id: 's02', input: '不是上次那个，重新配一遍',
    check: (a, r) => { const e = []; if (!/重新|好，|行，/.test(r.reply)) e.push('否认复用未接住'); if (a.needs.audience && a.needs.audience.source === 'inferred') e.push('预填未清空'); return e; } },
  { id: 's03', input: '我的店铺叫 Blooming Home，主打手工香薰蜡烛和家居香氛',
    check: (a, r, X) => { const e = []; if (!/blooming/i.test(Object.values(X).join('|'))) e.push('品牌未进 extras'); return e; } },
  { id: 's04', input: '主要客户是 30 到 45 岁的美国女性',
    check: (a, r) => { const e = []; const v = slotText(a.needs, 'audience'); if (!/30/.test(v) || !/45/.test(v) || !/美国女性/.test(v)) e.push('audience 画像未采集：' + v); return e; } },
  { id: 's05', input: '她们是加了购物车但一直没付款的',
    check: (a, r) => { const e = []; if (!/加购|购物车|冲突|以哪个|为准/.test(r.reply) && !/加购/.test(slotText(a.needs, 'audience'))) e.push('行为客群未接住'); return e; } },
  { id: 's06', input: '挽回原因就是忘了付款',
    check: (a, r) => { const e = []; const v = slotText(a.needs, 'reason'); if (!v) e.push('reason 未入槽'); else if (/太久没动静/.test(v)) e.push('[Bug 探针] reason 罐头化（应为用户原话「忘了付款」）：' + v); return e; } },
  { id: 's07', input: '不对，是运费太贵了',
    check: (a, r) => { const e = []; if (!/运费|贵/.test(slotText(a.needs, 'reason'))) e.push('correction 未生效：' + slotText(a.needs, 'reason')); return e; } },
  { id: 's08', input: '折扣给 15% 吧',
    check: (a, r) => { const e = []; if (!/15/.test(slotText(a.needs, 'offer'))) e.push('offer 未入槽：' + slotText(a.needs, 'offer')); return e; } },
  { id: 's09', input: '算了先打五折冲一波量',
    check: (a, r) => { const e = []; if (/50|五折/.test(slotText(a.needs, 'offer'))) e.push('E1 未拦截：50% 直接入槽'); if (!/建议|毛利|替代|阶梯|赠品|门槛|确定|确认/.test(r.reply)) e.push('E1 回复无拦截建议语义'); return e; } },
  { id: 's10', input: '就要五折，我确定了',
    check: (a, r) => { const e = []; if (!/50|五折|5s*折/.test(slotText(a.needs, 'offer'))) e.push('坚持后未照做：' + slotText(a.needs, 'offer')); return e; } },
  { id: 's11', input: '发送时段选北京时间晚上 8 点',
    check: (a, r, X) => { const e = []; if (!/8|晚|北京/.test(Object.keys(X).join('|') + Object.values(X).join('|'))) e.push('时段未进 extras'); return e; } },
  { id: 's12', input: '这些客人喜欢天然成分的居家香氛',
    check: (a, r, X) => { const e = []; if (!/天然|居家/.test(Object.values(X).join('|'))) e.push('兴趣未进 extras'); return e; } },
  { id: 's13', input: '营销目标是 7 天内挽回 50 单',
    check: (a, r) => { const e = []; if (!/50/.test(slotText(a.needs, 'goal'))) e.push('goal 未入槽：' + slotText(a.needs, 'goal')); if (a.filled_count !== 4) e.push('filled 应为 4：' + a.filled_count); if (a.stage !== 'S2') e.push('stage 应为 S2：' + a.stage); return e; } },
  { id: 's14', input: '先全停一下，别发了',
    check: (a, r) => { const e = []; if (!/停|暂停|冻结/.test(r.reply)) e.push('全停未接住'); return e; } },
  { id: 's15', input: '恢复吧',
    check: (a, r) => { const e = []; if (!/恢复|解除|回到/.test(r.reply)) e.push('恢复未接住'); return e; } },
  { id: 's16', input: '今天天气真不错',
    check: (a, r, X, before) => { const e = []; if (!r.reply || r.reply.length < 4) e.push('空回复'); if (JSON.stringify(needsSnapshot(a)) !== JSON.stringify(before)) e.push('闲聊写槽了'); return e; } },
  { id: 's17', input: '邮件正文直接用中文写给美国客户',
    check: (a, r) => { const e = []; if (!/英文|语种|语言|看不懂|效果|跟(着|随)/.test(r.reply)) e.push('E4 未拒绝解释'); return e; } },
  { id: 's18', input: '把方案卡给我看看',
    check: (a, r) => { const e = []; if (!r.planCard) e.push('S2 无预览卡'); else if (/COMEBACK-/i.test(JSON.stringify(r.planCard))) e.push('预览卡出现本地假码'); if (a.stage !== 'S2') e.push('stage 应保持 S2'); return e; } },
  { id: 's19', input: '客单价改成 32 美元',
    check: (a, r, X) => { const e = []; if (!/32/.test(Object.values(X).join('|'))) e.push('客单价 correction 未生效'); if (a.stage !== 'S2') e.push('S2 改参应停留 S2：' + a.stage); return e; } },
  { id: 's20', input: '受众改成老客',
    check: (a, r) => { const e = []; if (!/老客|沉睡|流失/.test(slotText(a.needs, 'audience'))) e.push('受众 correction 未生效：' + slotText(a.needs, 'audience')); return e; } },
  { id: 's21', input: '这批人值多少钱，值不值',
    check: (a, r) => { const e = []; if (!/人数|客单|挽回率|成本|×|x|\*|约|大概/.test(r.reply)) e.push('算账回复无算式语义'); return e; } },
  { id: 's22', input: '把加购未付和下单未付分别做成两个批次',
    check: (a, r) => { const e = []; if (!/批次|两批|分别|A.*B|加购.*下单/.test(r.reply)) e.push('未逐批复述'); return e; } },
  { id: 's23', input: '对，就建这两批',
    check: (a, r, X, before, ctx) => { const e = []; if (ctx.createBatches.length !== 1) e.push('确认后未建批（0 静默已守，但确认轮未执行）'); else if (!/建好|已建|创建|好了|批次/.test(r.reply)) e.push('建批回复未复述'); return e; } },
  { id: 's24', input: 'A 批次先暂停',
    check: (a, r) => { const e = []; if (!/已发|不受影响|未发/.test(r.reply)) e.push('无边界声明（I3 灵魂句）'); return e; } },
  { id: 's25', input: '没发完的折扣改成 12%',
    check: (a, r) => { const e = []; if (!/已发|不受影响|未发/.test(r.reply)) e.push('无边界声明'); if (!/12/.test(r.reply)) e.push('未复述新折扣'); return e; } },
  { id: 's26', input: '现在都在跑啥',
    check: (a, r) => { const e = []; if (!/A|加购|B|下单/.test(r.reply) || !/发|跑|停|暂/.test(r.reply)) e.push('无批次汇报语义'); return e; } },
  { id: 's27', input: '黑五 11 月 27 到 28 号都停发',
    check: (a, r, X, before, ctx) => { const e = []; if (!ctx.addBlackout.length) e.push('黑五日历未挂上'); if (!/停发|黑五|日历|11/.test(r.reply)) e.push('回复未确认停发'); return e; } },
  { id: 's28', input: '先聊点别的吧，今天有点累',
    check: (a, r, X, before) => { const e = []; if (!r.reply || r.reply.length < 4) e.push('空回复'); if (!/累|休息|聊|正事|配置|随时/.test(r.reply)) e.push('未接住情绪'); if (JSON.stringify(needsSnapshot(a)) !== JSON.stringify(before)) e.push('情绪轮写槽了'); return e; } },
  { id: 's29', input: '继续把配置弄完吧',
    check: (a, r) => { const e = []; if (!/确认|核对|配置|四|齐/.test(r.reply)) e.push('未回到任务'); return e; } },
  { id: 's30', input: '就按这些配置生成吧',
    check: (a, r) => { const e = []; if (!/确认|核对/.test(r.reply)) e.push('收口未引导确认'); if (a.stage !== 'S2') e.push('stage 应保持 S2（confirm 走端点）'); return e; } }
];

function needsSnapshot(a) { return JSON.stringify(Object.fromEntries(['audience', 'reason', 'offer', 'goal'].map(s => [s, slotText(a.needs, s) || null]))); }
function extrasMap(a) { return Object.fromEntries((a.memory.extras || []).map(e => [e.key, e.value])); }

(async () => {
  const executors = makeExecutorStub();
  const igde = new IGDE({ aiEnabled: true, callAI, callCritic, maxLlmCallsPerTurn: config.aiMaxCallsPerTurn, criticMode: 'off' });
  const act = {
    id: 'act_s30', user_id: 'u_s30', stage: 'S0',
    needs: { audience: null, reason: null, offer: null, goal: null },
    messages: [], memory: { corrections: [], extras: [], prefs: {}, ask_count: { audience: 0, reason: 0, offer: 0, goal: 0 }, conflicts: [] },
    created_at: Date.now(), updated_at: Date.now(), filled_count: 0, code_status: 'none'
  };
  const opening = igde.opening({ hasAnyAct: false, storeBanner: null });
  act.messages.push({ role: 'assistant', content: opening.reply, ts: Date.now() });

  const REUSE_PREFS = { audience: '加购未付客户', reason: '太久没动静', offer_text: '10% off', goal: '挽回 30 单', confirmed_at: Date.now() - 86400000, source: 'confirm' };
  const report = { model: config.aiModel, started_at: new Date().toISOString(), turns: [] };
  let pass = 0;
  const FIELD_LEAK = /\b(audience|reason|offer|goal|slot_updates)\b/;

  for (const sc of SCENARIOS) {
    const prev = JSON.parse(JSON.stringify({ needs: act.needs, filled_count: act.filled_count, memory: act.memory }));
    const before = needsSnapshot(act);
    const t0 = Date.now();
    let r;
    try {
      r = await igde.handle(act, sc.input, {
        locale: 'en', executors, reusePrefs: sc.reuse ? REUSE_PREFS : undefined,
        persist: (x) => { mergeMonotonicAct(x, prev); return x; }
      });
    } catch (e) {
      report.turns.push({ id: sc.id, input: sc.input, error: e.message });
      console.log(`✗ ${sc.id} 引擎异常: ${e.message}`);
      continue;
    }
    const dt = Date.now() - t0;
    const X = extrasMap(act);
    let checks = [];
    try { checks = sc.check(act, r, X, before, executors.calls).map(msg => ({ name: msg, pass: false })); } catch (e) { checks = [{ name: 'check 异常: ' + e.message, pass: false }]; }
    // 通用不变量
    if (!r.reply || String(r.reply).trim().length < 2) checks.push({ name: '通用:空回复', pass: false });
    if (FIELD_LEAK.test(r.reply || '')) checks.push({ name: '通用:回复泄漏字段名', pass: false });
    checks = checks.length ? checks : [{ name: '场景断言', pass: true }];
    const ok = checks.every(c => c.pass);
    if (ok) pass++;
    report.turns.push({ id: sc.id, input: sc.input, reply: r.reply, chips: r.chips, stage: act.stage, filled: act.filled_count, needs: JSON.parse(needsSnapshot(act)), extras: act.memory.extras, engine: r.engine, latency_ms: dt, checks });
    const mark = ok ? '✓' : '✗';
    const fails = checks.filter(c => !c.pass).map(c => c.name).join('; ');
    console.log(`${mark} ${sc.id} [${dt}ms] stage=${act.stage} filled=${act.filled_count} chips=[${(r.chips || []).join(',')}]`
      + `\n    ${sc.input}\n    → ${(r.reply || '').slice(0, 84).replace(/\n/g, ' ')}`
      + (fails ? `\n    ✗ ${fails}` : ''));
  }
  report.pass = pass; report.total = SCENARIOS.length; report.finished_at = new Date().toISOString();
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scenario30-report.json'), JSON.stringify(report, null, 2));
  console.log('\n========================================');
  console.log(`30 轮场景真模型测试：${pass}/${SCENARIOS.length} 通过  → eval/output/scenario30-report.json`);
  process.exit(pass === SCENARIOS.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
