'use strict';
/**
 * 短时记忆压测（真实 token，不入 CI）：多轮对话中细节的保持/绑定/纠错/否定/指代。
 * 用法：node test/diag-short-memory.js [轮次过滤如 M1,M8]
 * 每个剧本末尾有 recall 探针，自动判分（期望子串命中）；完整转写落盘 output/diag-short-memory.json
 */
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { LLMClient } = require('../lib/llm');
const { IGDE } = require('../lib/igde');

const cfg = config.load();
const client = new LLMClient({
  baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiKey,
  contextWindowTokens: cfg.aiContextWindowTokens, contextSafetyMargin: cfg.aiContextSafetyMargin,
  extraBody: cfg.aiExtraBody || null
});

const stats = { calls: 0, jsonOk: 0, memAccepted: 0, memRejected: 0 };

async function callAI(messages, opts) {
  stats.calls++;
  const r = await client.streamChatStructured({ messages, maxTokens: cfg.aiMaxOutputTokens, onReplyToken: opts && opts.onReplyToken });
  if (r.jsonOk) stats.jsonOk++;
  return { reply: r.reply, needs: r.needs, memoryPatch: r.memoryPatch, profilePatch: r.profilePatch, usage: r.usage, requestCount: r.requestCount };
}
const engine = new IGDE({ aiEnabled: true, callAI, criticMode: 'off' });

/** 剧本：turns 数组项 = 字符串 或 { u: 用户话, expect: [ [词A组, 词B组], ... ] }（每组任一命中，全部组需命中） */
const SCRIPTS = [
  { id: 'M1数字细节', turns: [
    '我卖机械键盘的，客单价大概 258 元',
    '好多客户加了购物车没付款',
    '他们主要嫌价格高，在等促销',
    '想让他们回来付款，给个满300减50的满减吧',
    { u: '我刚才说的客单价是多少来着？满减又是多少？', expect: [['258'], ['300'], ['50']] }
  ] },
  { id: 'M2否定约束', turns: [
    '我们家卖手工皮具的，品牌定位高端',
    '我们从来不打折，这个是底线，任何邮件里都不能出现折扣字眼',
    '弃购的客户挺多的',
    '他们犹豫的就是价格',
    '想让他们回来付款',
    { u: '那钩子给什么好？能打个七折吗？', expectNoDiscount: true }
  ] },
  { id: 'M3纠错链', turns: [
    '我卖蓝牙耳机的',
    '改一下，不是耳机，是蓝牙音箱',
    '哦对了是蓝牙音箱 Pro 版，别搞错',
    '弃购的人挺多，嫌运费贵',
    '想让他们回来付款，给个运费减免',
    { u: '你还记得我卖的是什么吗？要完整的产品名', expect: [['音箱 Pro']] }
  ] },
  { id: 'M4指代回指', turns: [
    '我卖猫粮的，客单价 180 左右',
    '加购没付的挺多',
    '我们定过规矩：满199才包邮，就用这个当门槛',
    { u: '就用刚才说的那个门槛当钩子吧，帮他们回来付款', expect: [['199']] }
  ] },
  { id: 'M5长对话漂移', turns: [
    '我卖露营灯的，主打太阳能款',
    '哈哈今天天气不错',
    '主要客人是欧美户外党',
    '对了你几点上班？',
    '浏览未买的特别多',
    '他们嫌运费也嫌价格',
    '想让他们回来下单',
    '给个95折码吧',
    { u: '我卖的是什么款？主要客人是哪边的？', expect: [['太阳能'], ['欧美']] }
  ] },
  { id: 'M6分轮给全', turns: [
    '我卖升降桌的',
    '老客户半年没来了',
    '他们买过一张桌，可能缺配套的桌板',
    '想让他们回来复购配件',
    '老客专属：满500减60',
    { u: '总结一下：受众是谁？钩子是什么？', expect: [['老客'], ['500'], ['60']] }
  ] },
  { id: 'M7双店铺绑定', turns: [
    '我有两个店：A 店卖瑜伽服，B 店卖瑜伽垫',
    'A 店老客流失，B 店弃购多',
    'A 店想用新品预告钩子，B 店给满299减40',
    { u: '两个店的钩子分别是什么？', expect: [['预告'], ['299'], ['40']] }
  ] },
  { id: 'M8时序属性绑定', turns: [
    '我卖蛋白粉的，分新老客运营',
    '老客挽回用9折码',
    '新客首单用85折',
    '最近加购未付的以新客居多',
    { u: '老客和新客的折扣分别是多少？别记混', expect: [['9折'], ['85折']] }
  ] },
  /* —— 第二批 5 个 —— */
  { id: 'M9数值改判', turns: [
    '我卖保温杯的',
    '加购没付的多，主要是 500ml 那个款',
    '给个满199减20吧',
    '等等，成本算下来不划算，改成满199减30',
    { u: '最终的满减是多少？哪个款式是重灾区？', expect: [['199'], ['30'], ['500ml']] }
  ] },
  { id: 'M10精确小数夹杂', turns: [
    '我 store 卖 mechanical keyboard，客单价 89.9 美元',
    '很多 cart abandon，加购不付的挺多',
    '他们 wait for discount，就等促销',
    '给 12% off 的 code 吧，KEYBOARD12，想让他们回来付款',
    { u: '客单价多少？code 是什么？', expect: [['89.9'], ['KEYBOARD12']] }
  ] },
  { id: 'M11时间线记忆', turns: [
    '我卖防晒霜的，入夏开始销量掉',
    '上周五上了新版商品页，之后弃购更明显了',
    '客户抱怨说运费要 3-5 天才到，太慢',
    '想让他们回来下单',
    { u: '弃购是从什么时候开始变明显的？客户说物流要几天？', expect: [['上周五'], ['3-5']] }
  ] },
  { id: 'M12先拒后收', turns: [
    '我卖露营桌椅的',
    '弃购的客户挺多的',
    '别给我整优惠码那种，没用',
    '他们就是想要折叠便携的款式',
    '好吧，看他们老问，还是给个 code：CAMP15 吧',
    { u: '最终给码了吗？码是什么？', expect: [['CAMP15']] }
  ] },
  { id: 'M13三选二砍单', turns: [
    '我卖桌面显示器的',
    '弃购的多，他们纠结尺寸',
    '我准备了三招：延长质保、免费上门安装、送升降支架',
    '质保和安装算了，就用送支架吧',
    '想让他们回来付款',
    { u: '最终钩子是什么？哪两招被砍了？', expect: [['支架'], ['质保'], ['安装']] }
  ] }
];

function newAct(id) {
  return { id, stage: 'S0', needs: {}, messages: [], memory: { facts: [], decisions: [], corrections: [] }, summary_cursor: 0, context_version: 1 };
}

async function runScript(s) {
  const act = newAct(s.id);
  const transcript = [];
  const results = [];
  for (const t of s.turns) {
    const text = typeof t === 'string' ? t : t.u;
    const r = await engine.handle(act, text);
    let verdict = '';
    if (typeof t === 'object' && t.expect) {
      const miss = [];
      for (const group of t.expect) {
        if (!group.some(w => (r.reply || '').includes(w))) miss.push('[' + group.join('/') + ']');
      }
      verdict = miss.length ? `FAIL 缺失:${miss.join('')}` : 'PASS';
      results.push({ probe: text, verdict, reply: r.reply });
    }
    if (typeof t === 'object' && t.expectNoDiscount) {
      const bad = /(折|discount|%\s*off)/i.test(r.reply) && !/不打折|不搞折扣|没有折扣/.test(r.reply);
      verdict = bad ? 'FAIL 提及折扣(违背否定约束)' : 'PASS';
      results.push({ probe: text, verdict, reply: r.reply });
    }
    transcript.push({ user: text, reply: r.reply, needs: { ...act.needs }, stage: r.stage });
  }
  stats.memAccepted += 0; // 汇总在 meta 打印
  return { id: s.id, transcript, results, finalNeeds: act.needs, finalMemory: act.memory };
}

(async () => {
  const only = (process.argv[2] || '').split(',').filter(Boolean);
  const scripts = SCRIPTS.filter(s => !only.length || only.some(o => s.id.startsWith(o)));
  const all = [];
  for (const s of scripts) {
    const r = await runScript(s);
    all.push(r);
    console.log(`\n===== ${s.id} =====`);
    for (const t of r.transcript) console.log(`  用户: ${t.user}\n  AI: ${t.reply}`);
    for (const p of r.results) {
      console.log(`  ${p.verdict.startsWith('PASS') ? '✅' : '❌'} 探针[${p.verdict}] Q: ${p.probe}`);
    }
    console.log(`  needs=${JSON.stringify(r.finalNeeds)}`);
  }
  const pass = all.flatMap(r => r.results).filter(p => p.verdict.startsWith('PASS')).length;
  const total = all.flatMap(r => r.results).length;
  console.log(`\n===== 短时记忆记分卡 =====`);
  console.log(`探针通过: ${pass}/${total} · jsonOk: ${stats.jsonOk}/${stats.calls}`);
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'diag-short-memory.json'), JSON.stringify(all, null, 2));
  console.log('转写已落盘 output/diag-short-memory.json');
})().catch(e => { console.error('DIAG FAIL:', e.code || '', e.message); process.exit(1); });
