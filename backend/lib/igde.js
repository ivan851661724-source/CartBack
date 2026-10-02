'use strict';
/**
 * IGDE 引导式对话引擎（PRD §4 / 架构 §10 / PRD v2 对话骨架）
 *
 * 核心 IP：引导用户把意图「自己说出来」并结构化，不是 AI 替用户决策，也不是翻译层。
 * - 四阶段 FSM：S0 接入 → S1 澄清 → S2 对齐 → S3 执行（任意态可转 closed；closed 不可再写）
 * - 意图抽取与话术解耦：LLM 一次返回 JSON envelope {reply, restatement, slot_updates, extras, corrections}
 * - 每轮流水线 B1-B5：
 *     B1 提取（envelope → critic 依据校验）→ B2 合并（correction > 新值 > 同值忽略；冲突检测）
 *   → B3 记账（先落库后回复：upsertAct 成功才允许向 SSE 写第一个 token 帧）
 *   → B4 选问（audience > reason > offer > goal 取第一个空槽；ask_count ≥1 不得连问；
 *     冲突澄清优先；全部问过仍缺失 → 接受 inferred 不再追问）
 *   → B5 回复组装（inferred 必带「不对请纠正」；0 提取轮直接问缺失项；S2 引导确认）
 * - chips 后端下发：按当前被问槽位给快捷选项（SLOT_CHIPS / CONFLICT_CHIPS）
 * - 5 层护栏 L0–L4：违规 → 重生成 1 次 + 兜底安全模板
 * - 离线降级：AI 不可用时仍能跑（词表桩模型 / 一句话确认），与在线路径共用同一 B2-B5
 */

// 真实模型对话组装（人格系统提示词 + 多轮上下文），由 lib/llm 提供，避免引擎内重复旧提示词
const { buildCoachContext } = require('./llm');
const {
  applyAgentProfilePatch,
  applyMemoryPatch,
  createEmptyMemory,
  normalizeAgentProfile,
  normalizeMemory
} = require('./context');
// PRD v2 槽位契约（唯一权威）：四槽 / 三态对象 / 迁移 / chips
const {
  SLOTS,
  SLOT_CHIPS,
  conflictChips,
  migrateNeeds,
  plainNeeds,
  countFilled,
  missingSlots,
  inferredSlots,
  ensureMemory
} = require('./needs');
// 店后台连接器：收件人 locale 归一化（邮件语种唯一权威来源）
const { normalizeLocale } = require('./storeConnector');
// Wave 4 F2：算账口径与账本（estGmv 公式）同源——挽回率/折扣成本计算复用 execution 单处权威
const execution = require('./execution');

// 槽位优先级即数组顺序：B4 选问 audience > reason > offer > goal
const NEEDED_FIELDS = SLOTS;
const FIELD_LABEL = { audience: '针对谁', reason: '为什么挽回', goal: '要什么结果', offer: '给什么钩子' };
const MAX_CORRECTIONS = 40;
const MAX_CONFLICTS = 4;

// 修正语气词（B2 冲突检测）：出现 → 新值视为明确纠正；不出现且与现值不同 → 冲突候选
const CORRECTION_TONE_RE = /(不是|不对|改成|改为|纠正|更新|换成|其实|之前说错|改主意|应该是|说错|rather|instead|actually|correction)/i;

// —— Wave 4 F2 算账意图（对话内问「这批人值多少钱 / 值不值」→ 确定性算账，与账本同口径）——
const LEDGER_RE = /(值多少|值不值|划不划算|能赚多少|赚多少|能回多少|值几个钱|算.{0,4}账)/i;
// —— Wave 4 A3 复用意图（新会话首条消息「照上次的来」→ prefs 预填）/ 否认复用（清预填）——
const REUSE_RE = /(照上次的?来?|跟(上次|上回)一样|和(上次|上回)一样|上个月那套|上次那套|按上次的?|照旧)/i;
const REUSE_DENY_RE = /(别用|不用|不要用|别照|不照|别按|不按|别跟|不跟|别拿|不拿|不是照|不是跟).{0,3}(上次|上回|上个月|那套)/i;

// —— D 类（私人生活/无关话题）重定向池：引擎级双保险的话术口径（与 lib/llm.js COACH_SYSTEM_PROMPT D 类一致）——
// 首句先「接住」用户刚说的（哪怕只是"哈哈这个我帮不上~"），再拉回邮件营销主业；不追问字段、不复读同一句。
const D_REDIRECT_POOL = [
  '哈哈这个我帮不上～我是专门做邮件营销的，你要是想挽回流失客人、发封挽回邮件，我随时在。',
  '这个咱就不聊啦，我主攻邮件营销挽回。你那拨想捞回来的客人，咱接着聊？',
  '这块我接不住哈，我的专长是帮你发挽回邮件。想聊聊弃购挽回不？'
];

// —— 兜底池（替代旧 SAFE_TEMPLATE 复读机）：均符合"接住 + 拉回主业"口径，轮换 + 去重避免连续相同 ——
const FALLBACK_POOL = [
  '我这边可能卡了一下，不过你刚说的我接住了。咱接着聊邮件挽回——你最想先捞哪拨客人？',
  '刚才有点断片，但咱别跑偏。想挽回哪拨客人、为啥、希望他们回来干啥，你挑一个说？',
  '我这边没接稳，你刚说的我记着。回到正题：弃购没付的、还是好久没来的老客，你想先聊哪拨？'
];

// —— 业务关键词（邮件营销/店铺生意），命中即非离题（D 类/离题判断的排除项，统一复用）——
// Wave 3：批次域动作词（批次/停发/全停/暂停/恢复/重发）也是业务词 —— 运维话术不得被离题路由劫持
// Wave 4：算账问句 / 复用意图（F2/A3）同为业务词，桩模式下不得被离题兜底吞掉
const BIZ_RE = /(店铺|网店|开店|店|生意|电商|卖货|卖东西|客户|邮件|营销|弃购|转化|下单|加购|购物车|浏览|老客|老顾客|会员|vip|优惠|折扣|包邮|限时|复购|回流|唤醒|沉睡|流失|gmv|销量|库存|发货|物流|退款|售后|批次|停发|全停|暂停|恢复|重发|值多少|值不值|划不划算|能赚|能回多少|算账|照上次|跟上次|和上次|上个月那套|上次那套|按上次|照旧)/i;

// —— 离题/元问题/身份询问 的温和接住池（桩与模型降级共用，_rotateReply 轮换防复读；guardrailHits 记空，非边界拒绝）——
const OFFTOPIC_POOL = [
  '没事，咱慢慢来。你就想着「谁快丢了、想让他们回来干啥」就行，别的我来帮你理。',
  '不急，这事儿本来就乱。你先随便唠唠你那拨客人啥情况，我帮你顺。',
  '哈哈没头绪正常，谁一开始都懵。你先说想捞哪拨人，剩下的我陪你理。'
];
const IDENTITY_POOL = [
  '我是帮你把逛了没买的人捞回来的——写挽回邮件、配受众、看效果。你想先聊聊哪拨客人流失了？想挽回哪拨人？跟我说说你想针对谁、为啥、希望他们回来干啥就行。',
  '我呀，专搞流失客户挽回邮件的搭子。弃购的、加购没付的、沉睡老客，哪拨你想捞回来，咱就聊哪拨。'
];
const META_POOL = [
  '哈哈我肯定不是机器人啦，就是个帮你搞流失挽回邮件的搭子，随叫随到～你有哪拨客人想捞回来，跟我说说？',
  '机器人哪有我这么能唠哈哈。我是你挽回邮件的小帮手，想聊哪拨客人你开口就行。'
];
const IDENTITY_RE = /你能干啥|你能做啥|你是谁|你是什么|你是干啥|你是干嘛|你能帮|你会什么|你干嘛|你做啥|干嘛的|做什么的|你会做啥/i;
const META_RE = /人机|机器人|是(个)?真人|自动回复|智能吗|ai\s*(吗|bot)?|是\s*ai\s*吗/i;

// —— 意图抽取（桩 / 离线，关键词启发式） ——
// 返回 {slot: 纯字符串}（旧式），由 B2 合并层统一转三态对象；pain 旧名已改为 reason。
function extractNeeds(text) {
  let t = (text || '').toLowerCase();
  const out = {};
  // 回归样本先行（PRD 验收 #5）：「挽回原因就盯加购未付款的」——识别挽回原因语境并剥离该短语，
  // 防止「加购未付款」里的 加购/未付/付款 被误抽成 audience/goal（此前 pain 槽漏接的复合修复）
  const reasonCtx = /原因|为啥|为什么|就盯|盯着/.test(t)
    && !/太久|很久|好久|不活跃|没动静|沉默|忘了|忘记|没人管|被忽略|竞品|别家|对手|别人家|贵|价格|预算|划算|犹豫|纠结|再想想|考虑|运费/.test(t);
  if (reasonCtx) {
    if (/加购/.test(t)) { out.reason = '加购未付款'; t = t.replace(/加购[^\s，。、；！？]*|加购/g, ' '); }
    else if (/弃购|未付/.test(t)) { out.reason = '下单未付'; t = t.replace(/弃购|未付/g, ' '); }
    else if (/浏览/.test(t)) { out.reason = '浏览未买'; t = t.replace(/浏览/g, ' '); }
    else if (/沉睡|很久没|好久没|流失/.test(t)) { out.reason = '太久没动静'; t = t.replace(/沉睡|很久没|好久没|流失/g, ' '); }
  }
  // 目标从句（"想让他们看看新款"）里的动词会误触发 audience 抽取（实测 A03「看看」→ 浏览未买），
  // audience 判定前先剥离「想(让)他们…」类意图从句
  const tAud = t.replace(/(想|希望)(让|请)?(他们|她们|客人|客户|顾客)[^，。？!?]*/g, '');
  // audience（加购优先于「没付」，避免「加购没付」误判为弃购）
  if (/加购|购物车/.test(tAud)) out.audience = '加购未付客户';
  else if (/弃购|没付|未付|下单没|未下单/.test(tAud)) out.audience = '弃购 / 下单未付客户';
  else if (/浏览|看看|逛/.test(tAud)) out.audience = '浏览未买客户';
  else if (/老客|老顾客|会员|vip|沉睡|很久没|好久没|流失/.test(tAud)) out.audience = '沉睡 / 流失老客';
  else if (/新客|新人|新用户/.test(tAud)) out.audience = '新客';
  // 收紧：裸「都/大家/所有」误伤率高（如"客人基本都是欧美的"），要求明确的人群指称才兜底
  else if (/全部(客户|老客|客人|人群)|所有(客户|客人|老客|人)|所有流失/.test(t)) out.audience = '全部流失人群';
  // reason（中英文双匹配；旧 pain 槽）
  if (!out.reason) {
    if (/太久|很久|好久|不活跃|没动静|沉默|忘了|忘记|没人管|被忽略/.test(t)) out.reason = '太久没动静、快被遗忘';
    else if (/竞品|别家|对手|别人家|competitor|rival/i.test(t)) out.reason = '可能被竞品勾走';
    else if (/运费太贵|运费贵|运费高|运费偏贵|shipping.*(expensive|cost|price)|too expensive|high? cost/i.test(t)) out.reason = '嫌运费贵、临门犹豫';
    else if (/贵|价格|预算|划算|expensive|price|cost|budget/i.test(t)) out.reason = '觉得贵、犹豫价格';
    else if (/犹豫|纠结|再想想|考虑|hesitat|unsure|thinking/i.test(t)) out.reason = '还在犹豫';
  }
  // goal（中英文双匹配）
  if (/付款|付了款|付钱|结账|结算|结清|完成下单|complete\s+the\s+purchase|complete.*payment|checkout|pay\s+(for|the)/i.test(t)) out.goal = '促使完成付款 / 结账';
  else if (/复购|再买|再下一单|回购|reorder|buy\s+again|repeat\s+purchase|repeat\s+order/i.test(t)) out.goal = '促成复购 / 再下一单';
  else if (/回流|回来|唤?醒|召回|拉回/.test(t)) out.goal = '唤醒回流';
  else if (/转化|成交|下单|购买/.test(t)) out.goal = '提升到转化 / 成交';
  else if (/逛|看看|活跃/.test(t)) out.goal = '唤回活跃 / 回来逛逛';
  // offer
  if (/(不要|不用|不给|别给|别整|别搞|别提|别弄|取消|不设|不打).{0,6}(折扣|优惠|码|券|包邮|钩子|折)/.test(t)) out.offer = '无额外优惠';
  else if (/([一二三四五六七八九]|\d+)\s*折/.test(t)) {
    const m = t.match(/([一二三四五六七八九]|\d+)\s*折/);
    const zhDigit = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    out.offer = (zhDigit[m[1]] || m[1]) + '折优惠';
  }
  else if (/满\s*(\d+)\s*减\s*(\d+)/.test(t)) { const m = t.match(/满\s*(\d+)\s*减\s*(\d+)/); out.offer = `满${m[1]}减${m[2]}`; }
  else if (/(优惠码|优惠券|折扣码|promo|coupon|\bcode\b)/i.test(t)) {
    // 用户自定义码名优先保留（实测 M10 KEYBOARD12 / M12 CAMP15），否则退回泛化表述
    const m = t.match(/(?:code|码)\s*[^A-Za-z0-9]{0,6}([A-Za-z][A-Za-z0-9]{2,15})/i);
    out.offer = m ? '优惠码' + m[1].toUpperCase() : '专属优惠码';
  }
  else if (/包邮|免邮/.test(t)) out.offer = '包邮'; // 明确要包邮时优先于通用「折扣」词，避免"折扣改成包邮"被误抽成折扣
  else if (/(\d+)\s*%|打折|折扣/.test(t)) {
    const m = t.match(/(\d+)\s*%/);
    // "100% 回来下单"是数量表述不是折扣，勿误抽成 offer；单位保留用户原话口径（% off）
    out.offer = (m && +m[1] !== 100) ? m[1] + '% off' : (m ? '' : '折扣优惠');
    if (!out.offer) delete out.offer;
  }
  // 具体、低频的钩子先判（买二送一/积分），通用的「限时」兜底放最后——分支顺序即优先级
  else if (/买\s*[一二三四五六七八九\d]+\s*送/.test(t)) { const m = t.match(/买\s*([一二三四五六七八九\d]+\s*送\s*[一二三四五六七八九\d]+)/); out.offer = '买' + m[1]; }
  else if (/积分/.test(t)) out.offer = /双倍/.test(t) ? '双倍积分' : '积分回馈';
  else if (/首月\s*(免费|0元|零元)/.test(t)) out.offer = '首月免费';
  else if (/限时|秒杀|紧迫|倒计时|赶紧/.test(t)) out.offer = '限时紧迫钩子';
  // 「发送频率」「免送货」里的「送」不是钩子（错切回归样本）：送 前邻 发/寄/配/推 时不触发
  else if (/(?<![发寄配推])送|赠|礼/.test(t)) {
    // 保留赠送物细节（实测 M13「送升降支架」粗抽成「赠送礼品」丢失用户指定）
    const m = t.match(/(?<![发寄配推])[送赠]([一-鿿A-Za-z0-9]{1,10})/);
    out.offer = m ? '送' + m[1].replace(/[吧呢啦哦呀了]+$/, '') : '赠送礼品';
  }
  return out;
}

// —— Wave 3 批次/运维短语（I1/I2/I3 降级词表；整短语匹配，禁碎片切片）——
// 返回 null = 本句无运维意图；否则 {kind, ...}：
//   batch_plan / pause_all / resume_all / blackout{params:{from,to,label}} / resend{target,subject} / op{op,target,params}
function parseDateRangeZh(t) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = new Date().getFullYear();
  const iso = (m, d) => `${y}-${pad(m)}-${pad(d)}`;
  let m = t.match(/(\d{4})[-/年]\s*(\d{1,2})[-/月]\s*(\d{1,2})\s*(?:日|号)?\s*(?:到|至|–|—|~|,|，|-)\s*(\d{4})[-/年]\s*(\d{1,2})[-/月]\s*(\d{1,2})/);
  if (m) return { from: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, to: `${m[4]}-${pad(m[5])}-${pad(m[6])}` };
  m = t.match(/(\d{1,2})\s*[月/]\s*(\d{1,2})\s*(?:日|号)?\s*(?:到|至|–|—|~|,|，|-)\s*(\d{1,2})\s*[月/]\s*(\d{1,2})/);
  if (m) return { from: iso(+m[1], +m[2]), to: iso(+m[3], +m[4]) };
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s*(?:到|至|–|—|~|-)\s*(\d{1,2})\s*(?:日|号)?/);
  if (m) return { from: iso(+m[1], +m[2]), to: iso(+m[1], +m[3]) };
  return null;
}

function extractOps(text) {
  const t = String(text || '');
  const tt = t.trim();
  // 恢复全停（必须明说「恢复吧」类短语，绝不自动）
  if (/^(恢复吧|恢复发送|全部恢复|都恢复|恢复所有|恢复排程|解除全停)/.test(tt)) return { kind: 'resume_all' };
  // 全停 / 停发（含日期 → 日历；无日期 → 紧急全停）
  if (/(先全停|全停|都停发|全店暂停|紧急停发|暂停一切|都先别发|停止发送)/.test(t)) {
    const range = parseDateRangeZh(t);
    if (range) return { kind: 'blackout', params: { ...range, label: (t.match(/[「『]([^」』]{1,20})[」』]/) || [])[1] || '停发' } };
    return { kind: 'pause_all' };
  }
  if (/停发|别发|暂停发送/.test(t)) {
    const range = parseDateRangeZh(t);
    if (range) return { kind: 'blackout', params: { ...range, label: (t.match(/[「『]([^」』]{1,20})[」』]/) || [])[1] || '停发' } };
  }
  // 重发（频次护栏确认流）
  if (/再打一轮|重发|再发一轮|没打开的再/.test(t)) {
    return { kind: 'resend', target: extractOpsTarget(t), subject: (t.match(/主题[行为]?\s*[「『]([^」』]+)[」』]/) || [])[1] || '' };
  }
  // 单批折扣：「改成 15%」
  const dm = t.match(/(?:改成|改为|换成|调整为?)\s*(\d{1,2}(?:\.\d+)?)\s*%/);
  if (dm) return { kind: 'op', op: 'discount', target: extractOpsTarget(t), params: { percent_off: +dm[1] } };
  // 单批暂停/恢复
  if (/暂停/.test(t)) return { kind: 'op', op: 'pause', target: extractOpsTarget(t) };
  if (/恢复/.test(t)) return { kind: 'op', op: 'resume', target: extractOpsTarget(t) };
  // 建批（I1）：≥2 批的明确说法
  if (/两个批次|两批|分别建批|分别做(成)?(两|2)?批|拆(成)?(两|2)批|建两个|三个批次|三批|几批|多个批次/.test(t)) {
    return { kind: 'batch_plan' };
  }
  return null;
}

/** 从原话提取批次指代（A 批 / 批次 A / 第一封 / 第 2 批 / 加购未付那批；无指代 null） */
function extractOpsTarget(t) {
  let m = t.match(/([A-Ja-j])\s*(?:批|批次)/);                      // 「A 批暂停」
  if (m) return { letter: m[1].toUpperCase() };
  m = t.match(/(?:批次|批)\s*([A-Ja-j])(?![A-Za-z])/);              // 「批次 A 暂停」
  if (m) return { letter: m[1].toUpperCase() };
  m = t.match(/第\s*([一二三四五六七八九十]|\d{1,2})\s*(?:个|批|批次|封)/);
  if (m) return { ordinal: m[1] };
  m = t.match(/([\u4e00-\u9fff]{2,8})那批|那批([\u4e00-\u9fff]{2,8})/);
  if (m) return { keyword: m[1] || m[2] };
  return null;
}

/** 降级建批：从原话按出现顺序提取人群（整词匹配，禁碎片切片）；offer 沿用槽位/原话数值 */
function batchesFromText(text, act) {
  const t = String(text || '');
  const found = [];
  const scan = [
    [/加购/, '加购未付'],
    [/下单未付|弃购/, '下单未付'],
    [/浏览/, '浏览未买'],
    [/老客|沉睡|流失/, '老客']
  ];
  const hits = [];
  for (const [re, label] of scan) {
    const m = re.exec(t);
    if (m) hits.push({ at: m.index, label });
  }
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) if (!found.includes(h.label)) found.push(h.label);
  if (found.length < 2) return [];
  const pctM = t.match(/(\d{1,2}(?:\.\d+)?)\s*%/);
  const needsOffer = (act && act.needs && act.needs.offer && act.needs.offer.value) || '';
  const offerText = pctM ? `${pctM[1]}% off` : (needsOffer || '10% off');
  return found.map(aud => ({ audience_desc: aud, offer_text: offerText }));
}

// —— B1 critic 护栏：slot_update 的 value 必须在本轮用户消息原文中有语义依据 ——
// 实现：去标点/空白归一后，value 主干字符 ≥60% 出现在原文（或 value 本身是原文子串）→ 有依据；
// 降级词表命中的直接通过（extractNeeds(userText)[slot] 非空）。无依据 → 调用方丢弃（丢弃优先于降级 inferred）。
function normalizeForGround(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function valueGroundedInText(value, text) {
  const v = normalizeForGround(value);
  const t = normalizeForGround(text);
  if (!v || !t) return false;
  if (t.includes(v)) return true;
  if (v.length > t.length * 2) return false; // 值远长于原文，必无逐字依据
  const chars = [...new Set(v)].filter(c => /[\u4e00-\u9fff a-z0-9]/i.test(c));
  if (!chars.length) return false;
  const hit = chars.filter(c => t.includes(c)).length / chars.length;
  return hit >= 0.6;
}

// 判断用户这句是不是「提问 / 吐槽 / 迷茫」（非信息，先回应本身）
function isNonInfo(text) {
  const t = text || '';
  if (/[?？]$/.test(t.trim())) return true;
  if (/^(怎么|怎样|如何|为什么|能|可以|会不会|是不是|啥|什么)/.test(t.trim())) return true;
  if (/烦|不会|不懂|太难|没用|怎么办|搞不定|头疼|懵|不知道/.test(t)) return true;
  return false;
}

// —— 边界（负空间，fail-open）：仅在用户「真触发」越界需求时才返回委婉拒绝 ——
// 设计原则（PRD §4.1）：只定义「不能做」，不定义「必须怎么聊」；用户没触雷就不打断。
// 返回 null 表示在范围内（含顺带提及的电商基础咨询）；返回字符串表示委婉拒绝话术。
// 保守策略：仅匹配「强信号」，避免把「顺带提到物流/退款」误伤为越界。
function scopeBoundary(text) {
  const t = (text || '').trim();
  if (!t) return null;
  // 1) 违法 / 有害：无条件拒绝
  if (/欺诈|诈骗|钓鱼|违禁|色情|暴力|赌博|假药|仿牌|售假|黑客|入侵/.test(t)) {
    return '这个我真没法帮你弄，换个正经玩法？';
  }
  // 2) 非邮件渠道：明确不接（社媒 / 短信等）；注意 CJK 不走 \b 单词边界，直接字面匹配
  if (/(抖音|小红书|朋友圈|社媒|短信群发|微信推送|私域群发|公众号群发|fb广告|facebook广告)/.test(t)) {
    return '社媒 / 短信这些渠道我暂时接不了，不过邮件这块我帮你弄，要不要先聊聊你的弃购挽回？';
  }
  // 3) 明确「请帮我做」非邮件、非电商基础事务（作为主要请求才拦，顺带提及不误伤）
  if (/(帮我|能不能|可以帮我|我想让你|麻烦你|请帮我|能否帮我)(写代码|建站|做网站|处理退款|退换货|补货|备货|投广告|投放广告|投流|报税|记账|做账|起草合同|打官司|看病|诊断病情|写文案外包)/.test(t)) {
    return '这个我暂时帮不上，我擅长的是邮件营销、顺便聊聊电商基础，要不要先说说你的弃购挽回？';
  }
  // 4) D 类：私人生活 / 无关话题（引擎级双保险；提示词层之外再加 fail-safe）
  //    强信号匹配「明确个人私生活 / 性暗示 / 情感私事」且无业务指向；保守：宁可漏拦（让模型接）也不误伤生意吐槽。
  //    注意：裸「性」易误伤（性格/性能），只用性生活/做爱/持久等明确信号；生意场景以 BIZ_RE 排除。
  const D_STRONG = /(性生活|做爱|性爱|sex|约炮|持久|性能力|阳痿|早泄|避孕|嫖|手淫|自慰)|(抑郁症?|看病|诊断|确诊)|(老婆|老公|女友|男友|离婚|感情破裂|婚姻|谈恋爱|分手|暗恋|出轨)/i;
  if (D_STRONG.test(t) && !BIZ_RE.test(t)) {
    return D_REDIRECT_POOL[0]; // 接住 + 拉回主业（含"哈哈"接住短语，不追问字段）
  }
  return null;
}

// —— 5 层护栏 ——
const PREACH_PATTERNS = [
  /你应该|你必须|务必|你需要(先|做)|建议你可以|按(以下|下面|这个)步骤|第一步|第二步|第1步|第2步|清单|框架|方法论|记住这几点|请按照以下步骤/
];

function guardrailL0(reply) {
  return typeof reply === 'string' && reply.trim().length > 0;
}
function guardrailL1(reply, max = 400) {
  if (reply.length <= max) return reply;
  // 仅在超长且能在句边界（。！？）截断时才裁剪，且不强行加"…"（避免语句破碎，呼吸感交给模型人格）
  const bound = Math.max(
    reply.lastIndexOf('。', max),
    reply.lastIndexOf('！', max),
    reply.lastIndexOf('？', max)
  );
  if (bound > max * 0.5) return reply.slice(0, bound + 1);
  return reply.slice(0, max); // 无句边界则硬裁剪（不补"…"）
}
function guardrailL2(reply) {
  // 返回是否「说教/推销/列清单」
  for (const p of PREACH_PATTERNS) if (p.test(reply)) return false; // false = 命中违规
  return true; // true = 通过
}
function guardrailL3(reply) {
  // 疑问句强制：应以问号结尾（问多于说）
  return /[?？]/.test(reply.trim());
}
function guardrailL4(reply, stage) {
  // 整封邮件倾倒（含【邮件标题】等变体）在聊天里任何阶段都算抢跑——邮件由引擎方案卡/mailgen 产出，
  // 聊天直出会绕过 G0 语种护栏与商家确认环节
  if (/(优惠码[:：]|主题行[:：]|正文[:：]|方案卡|以下是配置|【邮件(标题|主题|正文)】|subject\s*[:：]|hi\s*\[|dear\s*\[)/i.test(reply)) return false;
  if (stage === 'S3') return true;
  return true;
}

/** Only send ambiguous/high-risk prose to the model critic; deterministic rules always run. */
function shouldCriticReview(reply) {
  const text = String(reply || '');
  return text.length > 180 ||
    /(首先|其次|最后|第[一二三四五12345]步|建议|策略|方法|保证|一定能|必须|应该|务必|清单|框架)/.test(text);
}

// 注意：旧 SAFE_TEMPLATE 复读机已废除（P0-2），统一改用 FALLBACK_POOL 轮换兜底（见 _pickFallback）。

/** 注入防御：needs 值收口 —— 控制字符替换、空白折叠、限长，防止超长文本把指令带进后续 prompt 与邮件插值。 */
function clampNeedValue(value, max = 24) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** 注入防御：识别常见提示词注入话术（忽略/无视指令、角色切换、索要系统提示词），用于不可信输入的直接拒绝。 */
function looksLikeInjection(value) {
  const t = clampNeedValue(value, 200);
  return /(忽略|无视|disregard|ignore)[^\n]{0,20}(指令|规则|提示|以上|上述|之前|instruction|prompt|rule)|(你现在是|假装你是|扮演|act as|enter (developer |dev )?mode|开发者模式)|(系统提示|初始指令|system prompt|initial instruction)/i.test(t);
}

/**
 * IGDE 引擎
 * @param {object} opts
 *   aiEnabled: boolean 是否接了真实模型
 *   callAI: async (systemPrompt, userPrompt) => envelope  真实模型适配器（可选）
 *   callCritic: async (text) => boolean  精判是否违规（可选，缺省用本地正则）
 */
class IGDE {
  constructor(opts = {}) {
    this.aiEnabled = !!opts.aiEnabled;
    this.callAI = opts.callAI || null;
    this.callCritic = opts.callCritic || null;
    this.contextOptions = opts.contextOptions || {};
    // Wave 3 批次/运维执行器（I1/I2/I3）：server 注入（store/connector 感知）；
    // 也可经 handle() 的 opts.executors 按请求注入（带 userId 作用域）。缺省 = 批次域不劫持对话。
    this.executors = opts.executors || null;
    this.maxLlmCallsPerTurn = Math.max(1, Math.min(8, Number(opts.maxLlmCallsPerTurn) || 3));
    this.criticMode = ['always', 'suspicious', 'off'].includes(opts.criticMode)
      ? opts.criticMode
      : 'suspicious';
  }

  /** 已确认字段默认不覆盖；只有用户明确纠错（修正语气词 + 纠错尾部指向该槽）、
   *  或本轮用户原话直接命中该字段（kwTouched）时才更新。
   *  kwTouched：本轮关键词抽取命中的字段集合（逐字有据）——短时记忆语义 = 用户最新明确表述优先，
   *  防止模型编造/早期值被首字段优先锁死（实测 M5 浏览未买被锁成加购未付、M8 新客被锁成老客）。
   *  兼容入口（server preset 路径 / 外部脚本）：接受字符串或三态对象值，统一落三态契约。 */
  applyNeeds(act, extracted, userText = '', kwTouched = null) {
    const { normalizeSlot } = require('./needs');
    act.needs = migrateNeeds(act.needs);
    const now = Date.now();
    const correction = CORRECTION_TONE_RE.test(userText);
    const correctionTail = correction
      ? String(userText).split(/不是|不对|改成|改为|纠正|更新|换成|其实|之前说错|rather|instead|actually|correction/i).pop()
      : '';
    const explicitCorrection = correction ? extractNeeds(correctionTail) : {};
    if (correction && /(受众|客户|顾客|人群|这拨人)/.test(correctionTail)) explicitCorrection.audience = explicitCorrection.audience || true;
    if (correction && /(痛点|原因|因为|为啥|为什么)/.test(correctionTail)) explicitCorrection.reason = explicitCorrection.reason || true;
    if (correction && /(目标|希望|回来干啥|想让)/.test(correctionTail)) explicitCorrection.goal = explicitCorrection.goal || true;
    if (correction && /(优惠|折|券|包邮|免邮|钩子|满减|赠品|码|code)/i.test(correctionTail)) explicitCorrection.offer = explicitCorrection.offer || true;
    for (const f of NEEDED_FIELDS) {
      let raw = extracted && extracted[f] != null ? extracted[f] : '';
      if (f === 'reason' && !raw && extracted && extracted.pain != null) raw = extracted.pain; // 旧 pain 键兼容
      const slot = normalizeSlot(raw, { source: 'explicit', at: now });
      if (!slot) continue;
      const value = clampNeedValue(slot.value);
      if (!value) continue;
      const prev = act.needs[f];
      const same = prev && prev.value === value;
      if (!prev || same || (correction && explicitCorrection[f]) || (kwTouched && kwTouched.has(f))) {
        act.needs[f] = { value, source: slot.source, at: now };
      }
    }
    return act.needs;
  }

  missingFields(act) {
    return missingSlots(act.needs);
  }

  /** 缺失字段的引导问句（教练式：问多于说、极简） */
  probeFor(field) {
    const map = {
      audience: '先说最想挽回哪拨人？弃购的、加购没付的，还是好久没来的老客？',
      reason: '他们为啥快丢了？太久没动静、被竞品勾走，还是单纯忘了？',
      goal: '你希望他们回来干啥？再下一单、回来逛逛，还是唤醒沉睡的？',
      offer: '想给点什么钩子？折扣、专属优惠码，还是包邮 / 限时？'
    };
    return map[field];
  }

  s0Open() {
    return '请按照引导填充品牌基础信息，完成初始设置。';
  }

  /** 会话创建时一次性下发 S0 开场白（不推进阶段）。
   *  Wave 4 F1 零配置开场：
   *  - opts.hasAnyAct=true（商家名下已存在任何 act，含 closed）→ 不拼欢迎语（欢迎语一生只在首次出现）；
   *  - opts.storeBanner.connected 且有数据 → 数据先于提问：
   *    「已连接{店名}。本周{N}个加购未付（客单¥X，弃购总额¥Y）」+ 数据式 chips（≤2 数据 chip +「我自己说」）；
   *  - 未连接 / 无店铺数据 → 问一句话开场（不硬编数据），chips = ['加购未付','浏览未买','我自己说']。
   *  返回 { reply, stage, chips, welcome }；welcome=是否拼了欢迎语（前端可据此高亮首屏）。 */
  opening(opts = {}) {
    const banner = (opts.storeBanner && typeof opts.storeBanner === 'object') ? opts.storeBanner : null;
    const count = Math.max(0, Number(banner && banner.weekly_abandoned_count) || 0);
    const aov = Math.max(0, Number(banner && banner.aov) || 0);
    const total = Math.max(0, Number(banner && banner.abandoned_value) || 0);
    const hasData = Boolean(banner && banner.connected && (banner.store_name || count > 0));
    const cur = banner && String(banner.currency) === 'USD' ? '$' : '¥';
    const parts = [];
    if (!opts.hasAnyAct) parts.push('欢迎使用百客，我是你的专属智能邮件营销助手。');
    let chips;
    if (hasData) {
      if (banner.store_name) parts.push(`已连接${banner.store_name}。`);
      if (count > 0) {
        const fmt = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
        parts.push(`本周${count}个加购未付（客单${cur}${fmt(aov)}，弃购总额${cur}${fmt(total)}）。`);
      }
      parts.push('想先把这拨人捞回来吗？还是先聊别的客群？');
      chips = [];
      if (count > 0) chips.push(`加购未付 ${count} 人`);
      if (chips.length < 2) chips.push('浏览未买');
      chips.push('我自己说');
    } else {
      parts.push('想先把哪拨客人捞回来？加购没付的、逛了没买的，还是好久没来的老客？');
      chips = ['加购未付', '浏览未买', '我自己说'];
    }
    return { reply: parts.join(''), stage: 'S0', chips, welcome: !opts.hasAnyAct };
  }

  /** 追问单点字段；与上一句重复则轮换说法（桩模型路径的防复读；真模型由提示词硬约束 + 交付层相似度检查兜底） */
  _probe(act, field) {
    const p = this.probeFor(field);
    const assistantMsgs = act.messages.filter(m => m.role === 'assistant').map(m => m.content || '');
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (!last || !last.includes(p)) return p;
    // 防复读：本体不变时轮换包装说法，优先给没用过的；问过 3 轮以上给例子式追问
    const variants = [
      `换个说法——${p}`,
      `再帮我想想这一项就行：${p}`,
      `这项还没聊到：${p}`,
      `比如「${this._probeExample(field)}」——你的情况是？`
    ];
    return variants.find(v => !assistantMsgs.includes(v)) || variants[variants.length - 1];
  }

  /** 字段追问示例（第 4 次仍未采集到时给例子引导，避免无限复读） */
  _probeExample(field) {
    const map = {
      audience: '加购没付款的、浏览没买的、还是很久没来的老客',
      reason: '忘了结账、被别家勾走、还是单纯没需求',
      goal: '回来下单、领券复购、还是先回店铺逛逛',
      offer: '9 折、满减、还是免邮'
    };
    return map[field] || '加购未付的客户';
  }

  /** 复读判定：去空白/标点后全文相等，或一方（≥12 字符）被另一方完整包含 */
  _similarEnough(a, b) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y));
  }

  /** B4 选问（合并后状态）：audience > reason > offer > goal 取第一个空槽；
   *  ask_count ≥1 的槽不优先（顺延下一缺失槽）；全部问过仍缺失 → 仍问第一个缺失槽（轮换说法，不编造）。 */
  _nextProbeSlot(act) {
    const miss = this.missingFields(act);
    if (!miss.length) return null;
    const ac = (act.memory && act.memory.ask_count) || {};
    const fresh = miss.find(s => !(Number(ac[s]) > 0));
    return fresh || miss[0];
  }

  /** B4 决策（B2 合并后调用）：冲突澄清优先于常规追问；无缺失 → 不问（转 S2 由 _advanceStage 处理） */
  _decideQuestion(act, turnResult) {
    const miss = this.missingFields(act);
    if (!miss.length) return { slot: null, chips: [], kind: 'none' };
    const newConflict = (turnResult.conflictsNew || [])[0];
    if (newConflict) {
      return { slot: newConflict.slot, chips: conflictChips(newConflict.slot), kind: 'conflict' };
    }
    const probe = this._nextProbeSlot(act);
    return probe
      ? { slot: probe, chips: SLOT_CHIPS[probe] || [], kind: 'probe' }
      : { slot: null, chips: [], kind: 'none' };
  }

  /** 主入口：处理一条用户消息。
   *  opts.onReplyToken：reply 增量回调（B3 落库成功后才冲刷 —— 严格先落库后回复，token 为乐观预览，
   *  权威 reply 一律以返回值为准，由交付层做 replace 校正）。
   *  opts.persist：async (act) => void —— B3 落库钩子（upsertAct），失败抛错 → 本轮不发回复。 */
  async handle(act, userText, opts = {}) {
    const guardrailHits = [];
    act.needs = migrateNeeds(act.needs);
    act.messages = act.messages || [];
    act.memory = normalizeMemory(act.memory || createEmptyMemory());
    act.summary_cursor = Number(act.summary_cursor) || 0;
    act.context_version = Number(act.context_version) || 1;
    if (act.code_status == null) act.code_status = 'none';
    const nowMs = Date.now();
    const runtime = {
      llmCalls: 0,
      providerRequests: 0,
      criticCalls: 0,
      context: null,
      usage: null,
      memoryAccepted: 0,
      memoryRejected: 0,
      profileAccepted: 0,
      profileRejected: 0,
      slotUpdatesAccepted: 0,
      slotUpdatesRejected: 0,
      correctionsAdded: 0,
      conflictsRaised: 0,
      agentProfile: normalizeAgentProfile(opts.agentProfile),
      profileChanged: false
    };
    // B3 落库钩子：upsertAct 成功才允许发回复；失败 → 统一 error 帧「刚才那句我没存上，再说一次」
    const persistFn = typeof opts.persist === 'function' ? opts.persist : null;
    const doPersist = async () => {
      if (!persistFn) return;
      try { await persistFn(act); }
      catch (e) {
        const err = new Error('刚才那句我没存上，再说一次');
        err.code = 'PERSIST_FAIL';
        throw err;
      }
    };
    // B3 顺序保证：LLM 流式增量先入缓冲，落库成功后才冲刷给交付层（SSE 第一个 token 帧在落库之后）
    const tokenBuffer = [];
    const bufferedOnReplyToken = opts.onReplyToken ? (p) => tokenBuffer.push(p) : undefined;

    // —— closed 会话：不可再写（FSM 允许从任意态转 closed；收口后拒绝新输入） ——
    if (act.stage === 'closed') {
      return {
        reply: '这个会话已经收尾归档啦，想再跑一轮挽回配置，开个新会话我随时在。',
        stage: 'closed', needs: act.needs, planCard: null, guardrailHits: ['CLOSED'],
        engine: 'degraded', chips: [], askedSlot: null
      };
    }

    // —— 边界（负空间）：仅当用户真触发越界需求才处理 ——
    //   强信号命中 → scopeBoundary 返回拒绝话术。
    //   · 硬拒绝（A/B/C 类：违法 / 非邮件渠道 / 非邮件任务）：两种模式都引擎级拦截（安全 fail-safe）。
    //   · 软边界（D 类私人生活）：无真模型时走引擎级 D_REDIRECT 兜底；
    //     一旦接了真模型，下沉给 _aiCoach，由系统提示词自然「接住 + 拉回」，避免写死模板的人机话循环。
    const strongDecline = scopeBoundary(userText);
    if (strongDecline) {
      const isSoftD = D_REDIRECT_POOL.includes(strongDecline); // D 类私人生活 = 软边界
      if (!isSoftD || !this.aiEnabled) {
        // 硬拒绝（始终）或 软边界但无模型（桩兜底）：引擎级直接回话术
        const reply = isSoftD
          ? this._rotateReply(act, strongDecline, D_REDIRECT_POOL)
          : strongDecline;
        act.messages.push({ role: 'user', content: userText, ts: nowMs });
        act.messages.push({ role: 'assistant', content: reply, ts: nowMs });
        act.updated_at = nowMs;
        await doPersist();
        return { reply, stage: act.stage, needs: act.needs, planCard: null, guardrailHits: ['SCOPE'], engine: this._engineOf(false), chips: [], askedSlot: null };
      }
      // 否则（软边界 + 有真模型）：不在此拦截，继续下沉到 _aiCoach 让模型自然处理
    }

    // —— 离题 / 元问题 / 身份询问（四槽全空、无业务指向）：给温和、不重复的接住拉回 ——
    //    不甩死模板、不追问字段、guardrailHits 记空（非边界拒绝）；一旦有业务上下文则交给正常收集。
    const routed = this._routeOffTopic(act, userText);
    if (routed) {
      const reply = this._rotateReply(act, routed.primary, routed.pool);
      act.messages.push({ role: 'user', content: userText, ts: nowMs });
      act.messages.push({ role: 'assistant', content: reply, ts: nowMs });
      act.updated_at = nowMs;
      await doPersist();
      return { reply, stage: act.stage, needs: act.needs, planCard: null, guardrailHits: [], engine: this._engineOf(false), chips: [], askedSlot: null };
    }

    const filledBefore = countFilled(act.needs);

    // —— B1 提取：LLM envelope（在线）或词表（离线降级），统一进 B2 合并 ——
    let env = { reply: '', slotUpdates: [], extras: [], corrections: [], restatement: [] };
    let memoryPatch = null;
    let profilePatch = null;
    let aiDead = false;
    let usedAI = false;
    const preProbe = this._nextProbeSlot(act); // 提示词注入的单点追问指令（B4 预决策，合并后可能变化）
    if (this.aiEnabled && this.callAI) {
      try {
        env = await this._aiCoach(act, userText, runtime, bufferedOnReplyToken, preProbe);
        memoryPatch = env.memoryPatch || null;
        profilePatch = env.profilePatch || null;
        usedAI = true;
      } catch (e) {
        aiDead = true; // AI 调用失败 → 离线降级（抽取走关键词启发式）
      }
    }

    // 词表抽取（恒算）：离线路径是唯一抽取源；在线路径作为 B1 critic 的「词表命中直通」依据 + 模型漏抽补缺
    const kw = extractNeeds(userText);
    // 问句守卫（仅在线路径）：recall 类提问是在查询记忆而非陈述新事实，不得触发覆盖（实测 M8）
    const probeQuestion = /[?？]/.test(userText)
      || /(多少|哪个|哪些|是不是|有没有|还记得|别记混|是多少)/.test(userText);
    const kwActive = !usedAI || !probeQuestion;

    // B1 critic：envelope slot_updates 逐条校验原文依据（confidence<0.6 → inferred；无依据 → 丢弃）
    const grounded = usedAI ? this._groundSlotUpdates(env.slotUpdates, userText) : [];
    runtime.slotUpdatesAccepted += grounded.length;
    runtime.slotUpdatesRejected += Math.max(0, (env.slotUpdates || []).length - grounded.length);
    // B2 更新列表：envelope 优先，词表覆盖同槽（kwTouched = 用户原话逐字命中，短时记忆语义=原话为准）
    const bySlot = {};
    for (const u of grounded) bySlot[u.slot] = bySlot[u.slot] || u;
    if (kwActive) {
      for (const f of NEEDED_FIELDS) {
        if (kw[f]) bySlot[f] = { slot: f, value: kw[f], inferred: false, kw: true };
      }
    }
    const turn = {
      userText,
      updates: Object.values(bySlot),
      corrections: env.corrections || [],
      extras: env.extras || [],
      conflictCandidates: []
    };

    // —— B2 合并：correction > 新值 > 同值忽略；冲突检测；extras 纠错；C6 兜底 ——
    const mergeResult = this._mergeTurn(act, turn, runtime);

    // —— Wave 3 批次域（I1/I2/I3）：batch_plan / campaign_ops / 降级词表 / 待确认确认流 ——
    //  命中即短路本轮常规 B4 流水线（运维轮的回复由执行器结构化结果确定性组装，不进桩/模型话术层）。
    const executors = opts.executors || this.executors || null;
    if (executors) {
      const opsTurn = await this._handleOpsTurn(act, userText, env, usedAI, executors);
      if (opsTurn) {
        let opsReply = guardrailL1(opsTurn.reply || '');
        if (!guardrailL0(opsReply) || opsReply.trim().length < 2) { opsReply = this._pickFallback(act); guardrailHits.push('L0'); }
        if (!guardrailL2(opsReply)) { opsReply = this._pickFallback(act); guardrailHits.push('L2'); }
        if (!guardrailL4(opsReply, act.stage)) { opsReply = this._pickFallback(act); guardrailHits.push('L4'); }
        act.messages.push({ role: 'user', content: userText, ts: nowMs });
        act.messages.push({ role: 'assistant', content: opsReply, ts: nowMs });
        act.updated_at = nowMs;
        // 运维轮不推进 FSM（「改成 15%」这类措辞不应把 S3 打回 S2 作废快照）
        const opsPlanCard = (act.stage === 'S3' && act.plan_card) ? act.plan_card : null;
        await doPersist();
        if (opts.onReplyToken && tokenBuffer.length) {
          for (const p of tokenBuffer) opts.onReplyToken(p);
        }
        return {
          reply: opsReply, stage: act.stage, needs: act.needs, planCard: opsPlanCard, guardrailHits,
          engine: this._engineOf(usedAI && !aiDead),
          chips: opsTurn.chips || [], askedSlot: null,
          campaignOps: opsTurn.opResults || null,
          batches: opsTurn.batches || null,   // done 帧 batches：batch_plan 待确认时下发（前端画待确认批次卡）
          agentMeta: this._agentMeta(runtime)
        };
      }
    }

    // —— Wave 4（F2 算账 / A3 复用）：确定性短路轮，在线与降级同口径（envelope 到了也优先用确定性回复）——
    const w4 = this._wave4Turn(act, userText, { executors, reusePrefs: opts.reusePrefs });
    if (w4) {
      let reply4 = guardrailL1(w4.reply || '');
      if (!guardrailL0(reply4) || reply4.trim().length < 2) { reply4 = this._pickFallback(act); guardrailHits.push('L0'); }
      if (!guardrailL2(reply4)) { reply4 = this._pickFallback(act); guardrailHits.push('L2'); }
      if (!guardrailL4(reply4, act.stage)) { reply4 = this._pickFallback(act); guardrailHits.push('L4'); }
      if (w4.askedSlot) {
        act.memory = ensureMemory(act.memory, nowMs);
        act.memory.ask_count[w4.askedSlot] = (Number(act.memory.ask_count[w4.askedSlot]) || 0) + 1;
      }
      if (w4.advance) this._advanceStage(act, userText);   // 复用/否认轮推进 FSM；算账是查询，不推进
      act.messages.push({ role: 'user', content: userText, ts: nowMs });
      act.messages.push({ role: 'assistant', content: reply4, ts: nowMs });
      act.updated_at = nowMs;
      await doPersist();
      if (opts.onReplyToken && tokenBuffer.length) {
        for (const p of tokenBuffer) opts.onReplyToken(p);
      }
      return {
        reply: reply4, stage: act.stage, needs: act.needs,
        planCard: (act.stage === 'S3' && act.plan_card) ? act.plan_card : null,
        guardrailHits,
        engine: this._engineOf(usedAI && !aiDead),
        chips: w4.chips || [], askedSlot: w4.askedSlot || null,
        agentMeta: this._agentMeta(runtime)
      };
    }

    // 弱信号离题兜底：仅桩模式使用（无模型时才需引擎判断 stalled）。
    // 有真模型时，_aiCoach 已自然接住离题，此处若兜底会覆盖模型的正常回复 → 必须跳过。
    if (!usedAI && this._offTopicWeak(act, userText, filledBefore)) {
      const reply2 = this._rotateReply(act, D_REDIRECT_POOL[0], D_REDIRECT_POOL);
      act.messages.push({ role: 'user', content: userText, ts: nowMs });
      act.messages.push({ role: 'assistant', content: reply2, ts: nowMs });
      act.updated_at = nowMs;
      await doPersist();
      return { reply: reply2, stage: act.stage, needs: act.needs, planCard: null, guardrailHits: ['SCOPE'], engine: this._engineOf(false), chips: [], askedSlot: null };
    }

    // 用户未指定本次 offer 时沿用其已确认的长期默认值（agent profile；来源 inferred，回复须可纠正）
    if (!act.needs.offer && runtime.agentProfile.default_offer) {
      act.needs.offer = { value: clampNeedValue(runtime.agentProfile.default_offer), source: 'inferred', at: nowMs };
      mergeResult.acceptedInferred.push('offer');
    }
    if (memoryPatch) {
      const memoryStats = applyMemoryPatch(act, memoryPatch, {
        userText,
        sourceMessageIndex: act.messages.length,
        now: nowMs
      });
      runtime.memoryAccepted += memoryStats.accepted;
      runtime.memoryRejected += memoryStats.rejected;
    }
    if (profilePatch) {
      const profileResult = applyAgentProfilePatch(runtime.agentProfile, profilePatch, { userText });
      runtime.agentProfile = profileResult.profile;
      runtime.profileAccepted += profileResult.stats.accepted;
      runtime.profileRejected += profileResult.stats.rejected;
      runtime.profileChanged = profileResult.stats.accepted > 0;
    }

    // —— B4 选问决策（合并后）：问槽 / 冲突澄清 / 不问；记 ask_count + 冲突 asked 标记 ——
    const question = this._decideQuestion(act, mergeResult);

    // —— B5 回复组装：AI envelope reply 或桩教练；0 提取轮直接问缺失项 ——
    let reply = env.reply || '';
    let askedSlot = null;
    if (!reply) {
      const stub = this._stubReply(act, userText, question);
      reply = stub.reply;
      if (stub.asked) askedSlot = question.slot;
    } else {
      askedSlot = question.slot; // 在线路径：提示词已按 B4 指令约束「一轮只问一个」
    }
    if (aiDead && !guardrailHits.includes('AI_OFFLINE')) guardrailHits.push('AI_OFFLINE');
    // inferred 槽回复必须可纠正（B5 硬约束）：回复缺「我理解为/不对请纠正」表述时引擎补一句
    reply = this._appendInferredNote(reply, act, mergeResult.acceptedInferred, usedAI);

    // B4 记账：本轮实际追问的槽 ask_count +1；冲突候选标记 asked（下一轮未回应则 C6 兜底）
    if (askedSlot) {
      act.memory = ensureMemory(act.memory, nowMs);
      act.memory.ask_count[askedSlot] = (Number(act.memory.ask_count[askedSlot]) || 0) + 1;
      for (const c of act.memory.conflicts || []) {
        if (c.slot === askedSlot) c.asked = true;
      }
    }
    const chips = askedSlot ? (question.chips || []) : [];

    // —— 单一 FSM 权威：阶段推进只在此处（桩/AI 两条路径一致），_stubReply/_aiCoach 不碰 stage（P2-1）——
    this._advanceStage(act, userText);

    // —— 护栏管线（L0→L1→L2→L4；违规重生成 1 次 + 轮换兜底）——
    //    注：L3 已软化（P0-4）—— 不再强制问号，问号与否交给模型人格（COACH_SYSTEM_PROMPT 要求"该问才问"）
    // L0：空回复或退化输出（实测出现过 3 字符 "[1]" 残渣）→ 落兜底池，绝不直达用户
    if (!guardrailL0(reply) || reply.trim().length < 2) { reply = this._pickFallback(act); guardrailHits.push('L0'); }
    reply = guardrailL1(reply);
    // L2 说教/推销：本地正则先拦 + /critic 精判；违规先重生成 1 次（真模型），仍不过则兜底
    let l2ok = guardrailL2(reply);
    if (l2ok && this.callCritic && this._criticRequired(reply)) {
      if (runtime.llmCalls >= this.maxLlmCallsPerTurn) {
        l2ok = false;
      } else {
        runtime.llmCalls++;
        runtime.providerRequests++;
        runtime.criticCalls++;
        try { l2ok = await this.callCritic(reply); } catch (e) { l2ok = false; } // fail-closed
      }
    }
    if (!l2ok) {
      const regen = await this._tryRegen(act, userText, 'preachy', runtime);
      if (regen && (await this._passL2(regen, runtime))) { reply = regen; guardrailHits.push('L2regen'); }
      else { reply = this._pickFallback(act); guardrailHits.push('L2'); }
    }
    // L4 抢跑禁令（S3 前不得出方案卡式配置）
    if (!guardrailL4(reply, act.stage)) {
      const regen = await this._tryRegen(act, userText, 'preempt', runtime);
      if (regen && guardrailL4(regen, act.stage)) { reply = regen; guardrailHits.push('L4regen'); }
      else { reply = this._pickFallback(act); guardrailHits.push('L4'); }
    }

    // 交付层防复读（走查 P1-1）：与上一句助手回复高度相似 → 重生成 1 次，仍相似则轮换兜底。
    // 放在 push 之前，比对对象才是「上一轮」的回复。
    // 例外：四要素已齐的确认阶段，提示词本来就要求「复述要点 + 问同一句确认」，回复天然相似，不做此检查
    const lastAssistant = [...act.messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant && this.missingFields(act).length > 0 && this._similarEnough(lastAssistant.content, reply)) {
      const regen = await this._tryRegen(act, userText, 'repeat', runtime);
      if (regen && !this._similarEnough(lastAssistant.content, regen)) { reply = regen; guardrailHits.push('REPEATregen'); }
      else { reply = this._pickFallback(act); guardrailHits.push('REPEAT'); }
    }

    act.messages.push({ role: 'user', content: userText, ts: nowMs });
    act.messages.push({ role: 'assistant', content: reply, ts: nowMs });
    act.updated_at = nowMs;

    // 静默采集 → 方案卡（Wave 2 契约）：
    //  - S3（confirm 已通过）→ 回权威卡 act.plan_card（含店铺真实回执码）；
    //  - 四要素齐 + 本轮在线（真模型 envelope）→ 产出「无码预览卡」（code_status=pending，
    //    真实出卡在 /confirm 建码成功之后 —— E2 红线：卡面绝不出现未真实存在的折扣码）；
    //  - 降级轮（桩 / AI 失败）不出 planCard（剧本 #13：降级 4/4 时 stage=S2 且不出 planCard）。
    let planCard = null;
    if (act.stage === 'S3' && act.plan_card) {
      planCard = act.plan_card;
    } else if (usedAI && !aiDead && this.missingFields(act).length === 0) {
      planCard = this.producePlanCard(act, { locale: opts.locale, code: null });
    }

    // —— B3 记账（严格先落库后回复）：upsertAct 成功后才冲刷 token / 返回 ——
    await doPersist();
    if (opts.onReplyToken && tokenBuffer.length) {
      for (const p of tokenBuffer) opts.onReplyToken(p);
    }

    return {
      reply, stage: act.stage, needs: act.needs, planCard, guardrailHits,
      engine: this._engineOf(usedAI && !aiDead),
      chips, askedSlot,
      agentMeta: this._agentMeta(runtime)
    };
  }

  /** 本轮引擎档位：online = 走了真实模型 envelope；degraded = 桩 / AI 失败（G2 降级路径） */
  _engineOf(online) { return online ? 'online' : 'degraded'; }

  /* ------------------- Wave 3 批次域（I1/I2/I3）------------------- */

  // 待确认批次计划的确认/否认短语（仅 pending 存在时才参与判定，不影响常规对话）
  _confirmOpsRe() { return /确认建批|建批吧|建吧|就这么建|就这样建|确认重发|重发吧|确认|对的?|没错|可以|行|好吧|ok|就这样|是的/i; }
  _denyOpsRe() { return /不对|先不|别建|不建|先等等|等一下|等下|改一下|再想想|取消|先别|暂不|再改改|不对哦/i; }

  /**
   * 批次/运维轮主入口。返回 null = 本轮无运维语义（回归常规 B4 流水线）。
   * 判定顺序：待确认批次 → 待确认重发 → envelope campaign_ops → envelope batch_plan → 降级词表。
   */
  async _handleOpsTurn(act, userText, env, usedAI, executors) {
    const pending = (act.pending_ops && typeof act.pending_ops === 'object') ? act.pending_ops : {};
    const text = String(userText || '').trim();
    const confirm = this._confirmOpsRe().test(text);
    const deny = this._denyOpsRe().test(text);

    // ① 待确认批次计划（I1：0 静默建批 —— plan 轮绝不建，确认才建）
    if (Array.isArray(pending.batches) && pending.batches.length && !deny) {
      if (confirm) {
        let r = null;
        try { r = await executors.createBatches(pending.batches, { exclusionOverride: Boolean(pending.exclusion_override) }); } catch (e) { r = null; }
        act.pending_ops = null;
        if (r) return { reply: this._composeCreated(r), chips: [], opResults: [{ op: 'create_batches', ok: true, count: (r.campaigns || []).length }] };
        return { reply: '建批的时候店铺那边出了点状况，稍后再说一次「确认建批」我就再试。', chips: [], opResults: [{ op: 'create_batches', ok: false }] };
      }
      // I4 覆盖：「别排除，就要发」→ 先提示风险，确认建批时照建并留痕
      if (/别排除|不要排除|不用排除|不排除|就要发|都得发|都要发|照发/.test(text) && !pending.exclusion_override) {
        pending.exclusion_override = true;
        act.pending_ops = pending;
        return {
          reply: '行，风险得先说明白：被排除的人里可能有刚买过单的、刚收过邮件的，重复打扰容易伤名单、退订率会涨。你坚持的话，回「确认建批」我就按不排除建，并留痕备查。',
          chips: ['确认建批', '改一下'], opResults: [{ op: 'exclusion_override', ok: true }]
        };
      }
    }
    if (Array.isArray(pending.batches) && pending.batches.length && deny) {
      act.pending_ops = null;
      return { reply: '好，这份先不建。要调哪一批（人群 / 钩子 / 时间）直接说。', chips: [], opResults: [{ op: 'cancel_plan', ok: true }] };
    }

    // ② 待确认重发（I3 频次护栏确认流）
    if (pending.resend) {
      if (confirm) {
        let r = null;
        try { r = await executors.campaignOp({ op: 'resend', campaign_id: pending.resend.campaign_id, params: { subject: pending.resend.subject || '', confirm_frequency: true } }); } catch (e) { r = null; }
        act.pending_ops = null;
        return { reply: this._composeOpReply('resend', r) || '重发没成，稍后再试。', chips: [], opResults: [{ op: 'resend', ok: Boolean(r && r.ok) }] };
      }
      if (deny) {
        act.pending_ops = null;
        return { reply: '好，不重发了，名单先养一养。', chips: [], opResults: [{ op: 'cancel_resend', ok: true }] };
      }
    }

    // ③ envelope campaign_ops（在线路径）：引擎校验 op 枚举后逐条经执行器落地
    const rawOps = Array.isArray(env.campaignOps) ? env.campaignOps : [];
    const ops = rawOps.filter(o => o && typeof o === 'object' && typeof o.op === 'string'
      && ['pause', 'resume', 'discount', 'exclude', 'resend', 'pause_all', 'resume_all', 'blackout'].includes(String(o.op).trim()));
    if (ops.length) {
      const results = [];
      const parts = [];
      for (const rawOp of ops.slice(0, 6)) {
        const kind = String(rawOp.op).trim();
        const params = (rawOp.params && typeof rawOp.params === 'object') ? rawOp.params : {};
        const r = await this._execOneOp(executors, kind, {
          target: rawOp.target != null ? String(rawOp.target) : null,
          campaignId: rawOp.campaign_id || null,
          params
        }).catch(() => null);
        results.push({ op: kind, ...(r || { ok: false }) });
        parts.push(this._composeOpReply(kind, r));
      }
      const reply = parts.filter(Boolean).join('\n');
      if (reply) return { reply, chips: [], opResults: results };
    }

    // ④ envelope batch_plan（在线路径）：不落库 —— 逐批复述 + chips，等用户下轮确认
    const rawPlan = Array.isArray(env.batchPlan) ? env.batchPlan : [];
    const batchPlan = rawPlan.filter(b => b && typeof b === 'object' && String(b.audience || b.audience_desc || '').trim());
    if (batchPlan.length) {
      return this._planBatchesTurn(act, batchPlan.map(b => ({
        name: b.name,
        audience_desc: String(b.audience_desc || b.audience).trim(),
        offer_text: String(b.offer || b.offer_text || '').trim(),
        percent_off: Number(b.percent_off) || undefined,
        scheduled_at: Number(b.scheduled_at) || undefined
      })), executors);
    }

    // ⑤ 降级词表（仅桩 / AI 失败路径；整短语匹配，禁碎片切片）
    if (!usedAI) {
      const op = extractOps(text);
      if (op && op.kind === 'batch_plan') {
        const batches = batchesFromText(text, act);
        if (batches.length) return this._planBatchesTurn(act, batches, executors);
      }
      if (op && op.kind === 'pause_all') {
        const r = await executors.pauseAll().catch(() => null);
        if (r) return { reply: this._composeOpReply('pause_all', r), chips: [], opResults: [{ op: 'pause_all', ok: true, ...r }] };
      }
      if (op && op.kind === 'resume_all') {
        const r = await executors.resumeAll().catch(() => null);
        if (r) return { reply: this._composeOpReply('resume_all', r), chips: [], opResults: [{ op: 'resume_all', ok: true, ...r }] };
      }
      if (op && op.kind === 'blackout') {
        const r = await executors.addBlackout(op.params).catch(() => null);
        if (r) return { reply: this._composeOpReply('blackout', r), chips: [], opResults: [{ op: 'blackout', ok: Boolean(r.ok), ...(r) }] };
      }
      if (op && (op.kind === 'resend' || op.kind === 'op')) {
        // 单批操作：目标能解析到真实批次才接手（否则不劫持正常对话）
        const resolved = executors.resolveTarget ? await executors.resolveTarget(op.target || null) : null;
        if (resolved) {
          const passTarget = op.target != null ? op.target : { campaign_id: resolved.campaign_id };
          if (op.kind === 'resend') {
            const r = await executors.campaignOp({ op: 'resend', target: passTarget, params: { subject: op.subject || '', confirm_frequency: false } }).catch(() => null);
            if (r && r.needs_confirm) {
              act.pending_ops = { ...(act.pending_ops || {}), resend: { campaign_id: r.campaign_id, subject: op.subject || '' } };
              return {
                reply: `先等一下——${r.risk}。重复打扰容易伤名单，确认要再打一轮就回「确认重发」。`,
                chips: ['确认重发', '先不重发'], opResults: [{ op: 'resend', ok: false, needs_confirm: true }]
              };
            }
            if (r && r.ok) return { reply: this._composeOpReply('resend', r), chips: [], opResults: [{ op: 'resend', ok: true }] };
          } else {
            const r = await executors.campaignOp({ op: op.op, target: passTarget, params: op.params || {} }).catch(() => null);
            const reply = this._composeOpReply(op.op, r);
            if (reply) return { reply, chips: [], opResults: [{ op: op.op, ...(r || {}) }] };
          }
        }
      }
    }
    return null;
  }

  /** I1 建批计划轮：逐批复述 + chips，pending 存 act（不落 campaigns 行） */
  async _planBatchesTurn(act, batches, executors) {
    const LETTERS = 'ABCDEFGHIJ';
    let previews = null;
    try { previews = await executors.previewBatches(batches); } catch (e) { previews = null; }
    const list = (Array.isArray(previews) && previews.length === batches.length) ? previews
      : batches.map((b, i) => ({
        name: b.name || `${LETTERS[i]} ${String(b.audience_desc || '').slice(0, 12)}`,
        audience_desc: b.audience_desc, offer_text: b.offer_text,
        percent_off: b.percent_off != null ? b.percent_off : null,
        reach_count: null, excluded: []
      }));
    act.pending_ops = { ...(act.pending_ops || {}), batches: batches.map(b => ({ ...b })) };
    const parts = list.map(p => {
      const offer = p.offer_text || (p.percent_off ? `${p.percent_off}% off` : '无钩子');
      return `批次 ${p.name}：${p.audience_desc}${p.reach_count != null ? ` ${p.reach_count} 人` : ''}，${offer}`;
    });
    let reply = `拆成 ${list.length} 批，逐批跟你核对：${parts.join('；')}。对吗？`;
    const excl = list.flatMap(p => (p.excluded || []));
    if (excl.length) reply += `（已自动排除：${excl.map(x => `${x.reason} ${x.count} 人`).join('、')}）`;
    reply += ' 建批后每批独立折扣码、独立走发送闸门，先不发。';
    if (list.length > 3) reply += ' 批多了你自己也要看不过来，建议合并或排队。';
    return {
      reply, chips: ['确认建批', '改一下'],
      opResults: [{ op: 'batch_plan', ok: true, count: list.length }],
      batches: list.map(p => ({
        name: p.name, audience_desc: p.audience_desc,
        offer_text: p.offer_text || (p.percent_off ? `${p.percent_off}% off` : '无钩子'),
        reach_count: p.reach_count != null ? p.reach_count : 0
      }))
    };
  }

  /** 建批确认轮的确定性回复（逐批人话名 + 码 + 失败三出口 + 并行批次建议） */
  _composeCreated(r) {
    const camps = (r && r.campaigns) || [];
    const okParts = camps.map(c =>
      `「${c.name}」${c.discount && c.discount.code ? `（码 ${c.discount.code}，${c.reach_count} 人${c.scheduled_at ? '，已排程' : ''}）` : `（${c.reach_count} 人）`}`);
    let reply = `好，${camps.length} 批都建好了：${okParts.join('、')}。建批不等于发送，要发哪批说一声，可以指定时间。`;
    const fails = (r && r.failures) || [];
    if (fails.length) {
      reply += ` 另外「${fails[0].name}」建码没成（${fails[0].reason}），先存成草稿，可以：${(fails[0].options || []).join(' / ')}。`;
    }
    if (r && r.advice) reply += ` ${r.advice}`;
    return reply;
  }

  /** 运维操作的确定性回复（I3 灵魂：边界声明必含） */
  _composeOpReply(kind, r) {
    if (!r) return null;
    if (kind === 'pause_all') {
      return `已全店紧急停发：运行中的批次转暂停，待发/冻结的批次全部冻结（不删）。恢复必须你明说「恢复吧」，我不会自动恢复。`;
    }
    if (kind === 'resume_all') {
      const n = Number(r.resumed_count != null ? r.resumed_count : (r.resumed || []).length);
      return `好，全停解除${n ? `，${n} 个批次回到原状态` : ''}。`;
    }
    if (kind === 'blackout') {
      if (r.ok === false || r.error) return `停发日历没挂上：${r.error || r.reason || '区间不对'}`;
      const g = r.range || {};
      return `停发日历已挂上：${g.label || '停发'} ${g.from || ''} 到 ${g.to || ''}。窗口内的排程发送会冻结（不删不发送），结束后自动顺延恢复；期间新批次可建、不可发。`;
    }
    if (kind === 'pause') {
      return r.ok ? `好，「${r.name}」已暂停。${r.boundary}。要继续时明说「恢复」。` : `暂停没成：${r.reason}`;
    }
    if (kind === 'resume') {
      return r.ok ? `好，「${r.name}」恢复排程。${r.boundary}。` : `恢复没成：${r.reason}`;
    }
    if (kind === 'discount') {
      if (!r.ok) return `改折扣没成：${r.reason}`;
      const old = r.oldCode ? `旧码 ${r.oldCode} 对已发邮件继续有效，` : '';
      return `改好了：「${r.name}」未发部分${(r.changed || []).join('、')}，新码 ${r.code} 只对未发的生效；${old}${r.boundary}。`;
    }
    if (kind === 'exclude') {
      if (!r.ok) return `排除没成：${r.reason}`;
      const rej = (r.rejected && r.rejected.length) ? `；另有 ${r.rejected.length} 人已发过、存档只读未动` : '';
      return `已从「${r.name}」未发名单移除 ${r.excluded_count} 人并逐条留痕${rej}。${r.boundary}。`;
    }
    if (kind === 'resend') {
      if (r && r.needs_confirm) return `先等一下——${r.risk}。重复打扰容易伤名单，确认要再打一轮就回「确认重发」。`;
      if (r && r.ok && r.camp) {
        return `新批次「${r.camp.name}」已建好（新码 ${((r.camp.discount || {}).code) || '发送前创建'}，${(r.camp.recipients || []).length} 人）。旧批次已发部分不受影响，这轮只动没打开的。`;
      }
      return `重发没成：${(r && r.reason) || '未知原因'}`;
    }
    return null;
  }

  /** 单条运维执行（campaign_ops 与降级词表共用） */
  async _execOneOp(executors, kind, { target, campaignId, params }) {
    if (kind === 'pause_all') return executors.pauseAll();
    if (kind === 'resume_all') return executors.resumeAll();
    if (kind === 'blackout') return executors.addBlackout(params || {});
    return executors.campaignOp({ op: kind, target, campaign_id: campaignId || null, params: params || {} });
  }

  /* ------------------- Wave 4：F2 算账 / A3 复用（确定性短路轮）------------------- */

  /** 返回 null = 本轮无算账/复用语义（回归常规 B4 流水线）；复用/否认优先于算账。 */
  _wave4Turn(act, userText, { executors, reusePrefs } = {}) {
    return this._reuseTurn(act, userText, reusePrefs) || this._ledgerTurn(act, userText, executors);
  }

  /** Wave 4 F2：算账问句 → 确定性算账回复（同账本口径：人数 × 客单 × 挽回率 − 折扣成本），chips=[]。
   *  口径优先级：① confirm 冻结的执行快照 / 方案卡（estGmv.formula，逐字段同源）；
   *  ② 运行时圈人 + 客单（executors.audienceStats，server 注入；未确认方案也能当场算）；
   *  ③ 圈不到人 → 引导先选人群（不产数字 —— 无数据支撑不硬编）。 */
  _ledgerTurn(act, userText, executors) {
    if (!LEDGER_RE.test(String(userText || ''))) return null;
    const audValue = (act.needs && act.needs.audience && act.needs.audience.value) || '';
    const audLabel = audValue || '全部可捞人群';
    const curOf = (c) => (String(c || '') === 'USD' ? '$' : '¥');
    const compose = (f, amount, cur, src) =>
      `给你算笔账（和账本同口径，预估）：「${audLabel}」${f.people} 人 × 客单 ${cur}${f.aov} × 挽回率 ${Math.round((Number(f.rate) || 0) * 100)}%（行业参考）− 折扣成本 ${cur}${f.discount_cost} ≈ 能回 ${cur}${amount}（约 ${+(f.people * f.rate).toFixed(1)} 单）。${src}。要按这个下手，说一声我就开始配。`;
    // ① 权威口径：执行快照 / 方案卡的 estGmv（与账本逐字段同源）
    const snap = act.execution_snapshot || (act.plan_card ? { discount: act.plan_card.discount, estGmv: act.plan_card.estGmv } : null);
    if (snap && snap.estGmv && snap.estGmv.formula) {
      const f = snap.estGmv.formula;
      const src = snap.estGmv.source === 'store' ? '口径：客单按你店里的实数' : '口径：客单按行业默认，预估示意';
      return { advance: false, reply: compose(f, snap.estGmv.amount, curOf(snap.estGmv.currency), src), chips: [], askedSlot: null };
    }
    // ② 运行时口径：圈人 + 客单
    let stats = null;
    try { stats = (executors && executors.audienceStats) ? executors.audienceStats(audValue) : null; } catch (e) { stats = null; }
    if (!stats || !(stats.count > 0)) {
      return {
        advance: false,
        reply: '先圈到人我才能给你算账：告诉我先捞哪拨客人（加购未付 / 浏览未买 / 老客都行），我马上按人数 × 客单 × 挽回率算给你看。',
        chips: [], askedSlot: null
      };
    }
    const pct = execution.parseOfferPercent((act.needs && act.needs.offer && act.needs.offer.value) || '') || 0;
    const est = execution.computeEstGmv({ reachCount: stats.count, aov: stats.aov, aovSource: stats.aov_source, percentOff: pct });
    const src = est.source === 'store' ? '口径：人数、客单按你店里的实数' : '口径：客单按行业默认，预估示意';
    return { advance: false, reply: compose(est.formula, est.amount, curOf(stats.currency), src), chips: [], askedSlot: null };
  }

  /** Wave 4 A3：复用意图（仅新会话首条消息）→ prefs 预填（source=inferred）+ 逐项复述 + 差异项显式追问；
   *  否认复用（「别用上次的」）→ 清空本次预填（只清 inferred 槽）回正常采集。 */
  _reuseTurn(act, userText, reusePrefs) {
    const text = String(userText || '').trim();
    act.memory = ensureMemory(act.memory, Date.now());
    const prefs = act.memory.prefs || {};
    const reuseAt = Number(prefs.reuse_at) || 0;
    // ① 否认复用：清预填回 S1 正常采集（保留商家偏好本身，只清本次复用标记）
    if (reuseAt && REUSE_DENY_RE.test(text)) {
      const slots = String(prefs.reuse_slots || '').split(',').filter(s => SLOTS.includes(s));
      for (const s of slots) {
        if (act.needs[s] && act.needs[s].source === 'inferred') act.needs[s] = null;
      }
      // 落库合并器（mergeMonotonicAct）默认拒绝槽位降级：显式打标本次清空，允许覆盖预填旧值
      if (slots.length) prefs.reuse_cleared = slots.join(',');
      delete prefs.reuse_at;
      delete prefs.reuse_slots;
      delete prefs.reused_from;
      const miss = this.missingFields(act);
      const probe = miss[0] || null;
      return {
        advance: true,
        reply: '好，上次的先不用，咱们重新配一遍。' + (probe ? this.probeFor(probe) : '你说，这次想针对谁、给什么钩子？'),
        chips: probe ? (SLOT_CHIPS[probe] || []) : [],
        askedSlot: probe
      };
    }
    if (!REUSE_RE.test(text)) return null;
    if (reuseAt) return null;                                        // 已预填过：不再重复接手
    if (act.messages.some(m => m.role === 'user')) return null;      // 仅新会话首条消息命中
    const last = (reusePrefs && typeof reusePrefs === 'object') ? reusePrefs : null;
    if (!last || !String(last.audience || '').trim()) {
      // 没有可复用的历史方案：如实说，不硬编
      return {
        advance: true,
        reply: '我这边没翻到你上次确认过的方案，咱们直接配新的：先说最想挽回哪拨人？',
        chips: SLOT_CHIPS.audience,
        askedSlot: 'audience'
      };
    }
    // ② prefs 预填（inferred；回复必须带「不对请纠正」语义；缺失项 = 差异项，显式追问不静默沿用）
    const now = Date.now();
    const filledText = [];
    const slots = [];
    const put = (slot, raw) => {
      const v = clampNeedValue(raw);
      if (!v) return;
      act.needs[slot] = { value: v, source: 'inferred', at: now };
      filledText.push(`${FIELD_LABEL[slot]}「${v}」`);
      slots.push(slot);
    };
    put('audience', last.audience);
    put('reason', last.reason);
    put('offer', last.offer_text || last.offer);
    put('goal', last.goal);
    act.memory.prefs.reuse_at = String(now);
    act.memory.prefs.reuse_slots = slots.join(',');
    if (last.act_id) act.memory.prefs.reused_from = String(last.act_id);
    const miss = this.missingFields(act);
    let reply = `我理解为${filledText.join('、')}——照上次的来，不对请纠正。`;
    if (miss.length) {
      reply += `有 ${miss.length} 样跟上次没对齐的，我逐个问：${this.probeFor(miss[0])}`;
    } else {
      reply += '四样都和上次对齐了，你在下面确认卡里核对一遍，没问题就点确认。';
    }
    return {
      advance: true,
      reply,
      chips: miss.length ? (SLOT_CHIPS[miss[0]] || []) : [],
      askedSlot: miss.length ? miss[0] : null
    };
  }


  /** B1 critic：envelope slot_updates 逐条校验原文语义依据。confidence<0.6 → inferred；
   *  词表命中直通；无依据 → 丢弃（丢弃优先于降级 inferred）。 */
  _groundSlotUpdates(rawUpdates, userText) {
    const out = [];
    for (const u of (Array.isArray(rawUpdates) ? rawUpdates : []).slice(0, 8)) {
      if (!u || typeof u !== 'object') continue;
      const slot = String(u.slot || '').trim();
      if (!NEEDED_FIELDS.includes(slot)) continue;
      const value = clampNeedValue(u.value);
      if (!value) continue;
      let inferred = u.inferred === true;
      const confidence = Number(u.confidence);
      if (Number.isFinite(confidence) && confidence < 0.6) inferred = true;
      const wordlistHit = !!extractNeeds(userText)[slot];
      if (!valueGroundedInText(value, userText) && !wordlistHit) continue; // 无依据 → 丢弃
      out.push({ slot, value, inferred });
    }
    return out;
  }

  /**
   * B2 合并（就 act 就地修改）：
   *  ① envelope corrections：明确纠错（四槽或 extras key）；old 以库内现值重算，不信模型申报；
   *     目标槽为空 → 等同新值写入但仍记 corrections；extras 纠错 → 更新对应条目并记 corrections。
   *  ② slot_updates：correction > 新值 > 同值忽略；新值与现值不同且消息无修正语气 → 冲突候选（不覆盖），
   *     带 kW 语气/词表覆盖 → 视为纠正并记账。
   *  ③ C6 兜底：上一轮冲突追问未被回应（本轮无该槽新值/纠错）→ 接受候选新值 source=inferred。
   *  ④ 本轮新冲突入 memory.conflicts（B4 追问后标记 asked）。
   *  ⑤ extras 合并（latest-wins）。
   */
  _mergeTurn(act, turn, runtime) {
    const now = Date.now();
    const needs = act.needs;
    act.memory = ensureMemory(act.memory, now);
    const mem = act.memory;
    const corrected = new Set();      // 本轮已走 correction 的槽
    const acceptedInferred = [];      // 本轮接受的 inferred 槽（B5「不对请纠正」依据）
    let correctionsAdded = 0;
    const hasTone = CORRECTION_TONE_RE.test(turn.userText || '');

    // ① corrections
    for (const c of (turn.corrections || []).slice(0, 8)) {
      if (!c || typeof c !== 'object') continue;
      const slot = String(c.slot || '').trim();
      const newVal = clampNeedValue(c.new != null ? c.new : c.value);
      if (!slot || !newVal) continue;
      if (NEEDED_FIELDS.includes(slot)) {
        const prev = needs[slot];
        const oldVal = prev ? prev.value : '';
        if (oldVal === newVal) continue; // 同值忽略
        needs[slot] = { value: newVal, source: 'explicit', at: now };
        mem.corrections.push({ slot, old: oldVal, new: newVal, at: now });
        mem.corrections = mem.corrections.slice(-MAX_CORRECTIONS);
        corrected.add(slot);
        correctionsAdded++;
      } else {
        // extras correction（如「客单价改成 35」且客单价在 extras）→ 更新条目并记 corrections
        const entry = mem.extras.find(x => x.key === slot);
        if (!entry) continue; // extras key 不存在 → 忽略（防模型编造记忆条目；新事实应走 extras 更新）
        const oldVal = entry.value;
        if (oldVal === newVal) continue;
        entry.value = newVal;
        entry.at = now;
        mem.corrections.push({ slot, old: oldVal, new: newVal, at: now, scope: 'extras' });
        mem.corrections = mem.corrections.slice(-MAX_CORRECTIONS);
        correctionsAdded++;
      }
    }

    // ② slot_updates
    for (const u of (turn.updates || []).slice(0, 8)) {
      const slot = u && u.slot;
      if (!NEEDED_FIELDS.includes(slot)) continue;
      if (corrected.has(slot)) continue; // correction > 新值
      const value = clampNeedValue(u.value);
      if (!value) continue;
      const prev = needs[slot];
      if (prev && prev.value === value) continue; // 同值忽略
      const kwTouched = u.kw === true;
      if (prev && !hasTone && !kwTouched) {
        // 冲突：现值已填 + 本轮消息无修正语气 → 不覆盖，产出冲突候选转 B4 澄清
        turn.conflictCandidates.push({ slot, old: prev.value, new: value });
        continue;
      }
      const inferred = u.inferred === true;
      needs[slot] = { value, source: inferred ? 'inferred' : 'explicit', at: now };
      if (inferred) acceptedInferred.push(slot);
      if (prev && (hasTone || kwTouched)) {
        // 用户带修正语气 / 原话逐字覆盖已填值 → 记 corrections（追加制）
        mem.corrections.push({ slot, old: prev.value, new: value, at: now });
        mem.corrections = mem.corrections.slice(-MAX_CORRECTIONS);
        corrected.add(slot);
        correctionsAdded++;
      }
    }

    // ③ C6 兜底：上一轮冲突追问未被回应 → 接受候选新值 inferred（inferred 槽回复带「不对请纠正」）
    for (const cf of (mem.conflicts || []).slice(0, MAX_CONFLICTS)) {
      if (cf.asked !== true) continue;
      const slot = cf.slot;
      if (corrected.has(slot)) continue;
      if ((turn.updates || []).some(x => x.slot === slot)) continue; // 本轮已回应
      const cur = needs[slot];
      const curVal = cur ? cur.value : '';
      const candVal = clampNeedValue(cf.new);
      if (candVal && curVal !== candVal) {
        needs[slot] = { value: candVal, source: 'inferred', at: now };
        acceptedInferred.push(slot);
      }
    }
    mem.conflicts = [];

    // ④ 本轮新冲突候选入记忆（asked 标记由 B4 追问后打上）
    for (const c of (turn.conflictCandidates || []).slice(0, MAX_CONFLICTS)) {
      mem.conflicts.push({ slot: c.slot, old: c.old, new: c.new, at: now, asked: false });
    }

    // ⑤ extras 合并（latest-wins，同 key 更新不追加）
    for (const e of (turn.extras || []).slice(0, 8)) {
      if (!e || typeof e !== 'object') continue;
      const key = String(e.key || '').trim().slice(0, 48);
      const value = clampNeedValue(e.value, 120);
      if (!key || !value) continue;
      const entry = mem.extras.find(x => x.key === key);
      if (entry) { entry.value = value; entry.at = now; }
      else mem.extras.push({ key, value, at: now });
      mem.extras = mem.extras.slice(-24);
    }

    if (runtime) {
      runtime.correctionsAdded += correctionsAdded;
      runtime.conflictsRaised += (turn.conflictCandidates || []).length;
    }
    return { corrected, conflictsNew: turn.conflictCandidates || [], acceptedInferred, correctionsAdded };
  }

  /** B5 硬约束：本轮接受了 inferred 槽 → 回复必须含「我理解为…不对请纠正」类表述（缺则引擎补一句） */
  _appendInferredNote(reply, act, acceptedInferred, usedAI) {
    if (!acceptedInferred || !acceptedInferred.length) return reply;
    if (/我理解为|不对请纠正|不对再纠正|如果不对|理解得不对/.test(reply)) return reply;
    const names = acceptedInferred
      .filter(s => act.needs[s] && act.needs[s].value)
      .map(s => `「${act.needs[s].value}」`)
      .join('和');
    if (!names) return reply;
    const note = `我先按${names}理解，不对请纠正。`;
    if (!reply) return note;
    return reply + (usedAI ? ' ' + note : note);
  }

  /** 离题/元问题/身份询问路由：四槽全空且无业务指向时，返回温和接住池（轮换防复读）；否则 null。
   *  注意：仅当「尚无业务上下文」时拦截，避免误伤已进入收集的正常对话；业务关键词命中直接放行。 */
  _routeOffTopic(act, userText) {
    // 接了真模型时，离题 / 闲聊 / 身份 / 元问题交给 _aiCoach 自然处理（系统提示词含对应口径），
    // 不再用写死模板提前 return —— 否则会陷入「人机话循环」。仅桩模式（无模型）才用模板兜底。
    if (this.aiEnabled) return null;
    const t = (userText || '').trim();
    if (!t) return null;
    if (countFilled(act.needs) > 0) return null; // 已有业务上下文 → 正常收集
    if (BIZ_RE.test(t)) return null;             // 业务相关 → 不拦
    if (IDENTITY_RE.test(t)) return { primary: IDENTITY_POOL[0], pool: IDENTITY_POOL };
    if (META_RE.test(t)) return { primary: META_POOL[0], pool: META_POOL };
    return { primary: OFFTOPIC_POOL[0], pool: OFFTOPIC_POOL };
  }

  /** 弱信号离题兜底：多轮无任何新字段 + 无业务关键词 + 非确认/调整意图 → 视为 stalled/离题，接住拉回 */
  _offTopicWeak(act, userText, filledBefore) {
    const t = (userText || '').trim();
    if (!t) return false;
    // 业务关键词命中 → 绝非离题
    if (BIZ_RE.test(t)) return false;
    const filledAfter = countFilled(act.needs);
    if (filledAfter <= filledBefore) {
      if (filledAfter === 0) return false; // 还没聊出任何字段，用户在想，不判离题
      const userTurns = act.messages.filter(m => m.role === 'user').length;
      if (userTurns < 3) return false; // 至少 3 轮用户发言仍无进展才兜底
      if (/(对|是的|可以|确认|改|调|换|发|生成|方案|配置|不对|好|行)/.test(t.toLowerCase())) return false; // 在推进的不算
      return true;
    }
    return false;
  }

  /** 轮换回复：跳过与上一句助手回复相同的候选（防复读），保证连续不同 */
  _rotateReply(act, primary, pool) {
    const last = act.messages[act.messages.length - 1];
    const lastContent = last && last.role === 'assistant' ? last.content : null;
    const cand = (pool || []).find(p => p !== lastContent);
    return cand || pool[0] || primary || '';
  }

  /** 兜底选择器：从 FALLBACK_POOL 轮换（用于 L0/L2/L4 兜底与异常兜底） */
  _pickFallback(act) {
    return this._rotateReply(act, null, FALLBACK_POOL);
  }

  /** 自然回复去重：若与上一句助手相同则换一个备选（避免桩路径自然复读，如连发"我不知道"） */
  _replyFresh(act, primary, alternates) {
    const last = act.messages[act.messages.length - 1];
    if (last && last.role === 'assistant' && last.content === primary) {
      const alt = (alternates && alternates.length ? alternates : FALLBACK_POOL).find(p => p !== primary);
      return alt || primary;
    }
    return primary;
  }

  /** 单一 FSM 权威：依据「已收集字段 + 用户意图」推进阶段；桩/AI 两条路径共用（P2-1）
   *  Wave 2（E2/D2）：
   *  - S2 不再因「确认话术」直跳 S3 —— S2→S3 唯一入口是 POST /api/act/:id/confirm
   *    （先真实建码、后出卡；失败停留 S2）；聊天里的确认/否认都停留 S2（correction 由 B2 解冻更新）。
   *  - S3 correction/改参 → 回 S2，并作废 execution_snapshot 与 plan_card（旧方案卡/草稿不再可用）。 */
  _advanceStage(act, userText) {
    const t = (userText || '').trim().toLowerCase();
    // S3 改参信号（保守口径：避免「没错」误伤）；correction 语气词已在 B2 记账
    const wantAdjust = /改|调(整|整下)?|再聊|不对|换|重(新|做)?|另一|别的|加一拨|换拨|再想想|纠正/.test(t);

    if (act.stage === 'closed') return;
    if (act.stage === 'S3') {
      if (wantAdjust) {
        act.stage = 'S2';
        // D2 快照失效：S3 改参后旧执行快照/方案卡作废（闸门⑤将因快照缺失拦截发送），回 S2 等再次确认
        act.execution_snapshot = null;
        act.plan_card = null;
      }
      return;
    }
    if (act.stage === 'S2') {
      // correction → needs 已在 B2 解冻更新，停留 S2 重新出确认卡数据；确认动作走 /confirm 端点
      return;
    }
    if (act.stage === 'S1') { if (this.missingFields(act).length === 0) act.stage = 'S2'; return; }
    if (act.stage === 'S0') {
      act.stage = 'S1';
      if (this.missingFields(act).length === 0) act.stage = 'S2';
      return;
    }
  }

  /** 桩模型回复（离线可用，功能完整的教练）。question = B4 决策（合并后）；
   *  返回 { reply, asked }，asked=true 表示本轮实际追问了 question.slot（驱动 ask_count 记账）。 */
  _stubReply(act, userText, question) {
    const nonInfo = isNonInfo(userText);
    const probeSlot = question && question.slot;
    if (act.stage === 'S0') {
      // 阶段推进统一由 _advanceStage 负责；此处只产出首轮澄清话术
      if (probeSlot) return { reply: this._probe(act, probeSlot), asked: true };
      return { reply: this._replyFresh(act, this._readyLine(), FALLBACK_POOL), asked: false };
    }
    if (act.stage === 'S1') {
      if (nonInfo) {
        return { reply: this._replyFresh(act, '没事，这块本来就乱。你就想着「谁快丢了、想让他们回来干啥」就行，别的我来帮你理。', FALLBACK_POOL), asked: false };
      }
      if (!probeSlot) return { reply: this._replyFresh(act, this._readyLine(), FALLBACK_POOL), asked: false };
      return { reply: this._probe(act, probeSlot), asked: true };
    }
    if (act.stage === 'S2') {
      // 对齐 / 确认 / 否认；对话里不暴露字段（字段只在确认标签出现）
      // Wave 2：确认动作走 /confirm 端点（先建码后出卡），聊天里的「对/生成」只做引导
      const t = userText.trim();
      const deny = /不对|错|改|不是|纠正|重新|等下|等等|再想想/.test(t);
      if (deny) return { reply: '好，哪点要改？告诉我，其它对的我留着。', asked: false };
      if (this.missingFields(act).length === 0) {
        const confirm = /对|是的|可以|确认|没问题|ok|好|行|就这样|generate|生成|出方案|方案|配置/.test(t.toLowerCase());
        if (confirm) return { reply: '好，四样都核对齐了。点下面的「确认」按钮，我去你的店铺创建折扣码并生成方案卡。', asked: false };
        return { reply: this._replyFresh(act, this._readyLine(), FALLBACK_POOL), asked: false };
      }
      if (nonInfo) {
        return { reply: this._replyFresh(act, '没事，咱不急。哪点想调直接说，其它对的我先留着。', FALLBACK_POOL), asked: false };
      }
      return { reply: this._probe(act, probeSlot || this.missingFields(act)[0]), asked: true };
    }
    if (act.stage === 'S3') {
      // S3 执行阶段：按用户意图分流，避免「进 S3 后每轮回复完全相同」（防复读）
      const t = (userText || '').trim().toLowerCase();
      const wantAdjust = /改|调(整|整下)?|再聊|不对|换|重(新|做)?|另一|别的|加一拨|换拨|再想想/.test(t);
      const wantSend = /^(发|发吧|发送|发出|安排发)|发(送|吧|出)$|send|确认发送|去发|帮我发/.test(t);
      let cand;
      if (wantAdjust) {
        cand = '好，回到前面。你想先调哪一项？受众、挽回原因、目标还是钩子？';
      } else if (wantSend) {
        cand = '好，点下面「确认发送」就行；发完我会帮你盯送达和回流数据。';
      } else if (/生成|方案|配置|看卡|卡片|确认|行不|可以吗/.test(t)) {
        cand = '配置一直都在下面确认标签里，随时能看。确认好了就点「确认发送」。';
      } else {
        cand = '方案已经帮你整理好了，下面确认标签里能看到，点「确认发送」就发。还想针对别的人群再聊一轮也可以。';
      }
      // 防复读：若与上一句助手回复完全相同则换一种说法
      const last = act.messages[act.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === cand) {
        cand = '刚才那点没变。你说「发吧」我就帮你安排发送，或者换拨人再聊一轮。';
      }
      return { reply: this._replyFresh(act, cand, FALLBACK_POOL), asked: false };
    }
    return { reply: this._pickFallback(act), asked: false };
  }

  /** 主要信息收集完时的自然收口话术（不在对话里列字段 — 字段只在确认标签里出现；含「确认/核对」引导） */
  _readyLine() {
    return '四样都齐了。我帮你按这个配一封挽回邮件，你在下面确认卡里核对一遍，没问题就点确认。';
  }

  _criticRequired(text) {
    if (this.criticMode === 'off') return false;
    if (this.criticMode === 'always') return true;
    return shouldCriticReview(text);
  }

  _agentMeta(runtime) {
    return {
      llmCalls: runtime.llmCalls,
      providerRequests: runtime.providerRequests,
      criticCalls: runtime.criticCalls,
      context: runtime.context,
      usage: runtime.usage,
      memoryAccepted: runtime.memoryAccepted,
      memoryRejected: runtime.memoryRejected,
      profileAccepted: runtime.profileAccepted,
      profileRejected: runtime.profileRejected,
      slotUpdatesAccepted: runtime.slotUpdatesAccepted,
      slotUpdatesRejected: runtime.slotUpdatesRejected,
      correctionsAdded: runtime.correctionsAdded,
      conflictsRaised: runtime.conflictsRaised,
      agentProfile: runtime.profileChanged ? runtime.agentProfile : null
    };
  }

  _mergeUsage(runtime, usage) {
    if (!usage || typeof usage !== 'object') return;
    const current = runtime.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      current[key] += Number(usage[key]) || 0;
    }
    runtime.usage = current;
  }

  async _callAI(messages, runtime, streamOpts) {
    if (runtime.llmCalls >= this.maxLlmCallsPerTurn) {
      const error = new Error('单轮 LLM 调用预算已用完');
      error.code = 'CALL_BUDGET';
      throw error;
    }
    runtime.llmCalls++;
    runtime.providerRequests++;
    const result = await this.callAI(messages, streamOpts);
    runtime.providerRequests += result && Number(result.requestCount) > 1
      ? Number(result.requestCount) - 1
      : 0;
    if (result && result.usage) this._mergeUsage(runtime, result.usage);
    return result;
  }

  /** 真实模型：一次对话同时完成话术与结构化提取（PRD v2 envelope）。
   *  onReplyToken 仅流给首轮 coach 调用（critic / 重生成不流，护栏前的预览以返回值为权威）；
   *  预览 token 由 handle 缓冲，B3 落库成功后才冲刷（严格先落库后回复）。 */
  async _aiCoach(act, userText, runtime, onReplyToken, preProbe) {
    const promptNeeds = plainNeeds(act.needs);
    if (!promptNeeds.offer && runtime.agentProfile.default_offer) {
      promptNeeds.offer = runtime.agentProfile.default_offer;
    }
    const missing = preProbe ? [preProbe] : [];
    const context = buildCoachContext({
      act,
      userText,
      needs: promptNeeds,
      stage: act.stage,
      missing,
      chips: preProbe ? (SLOT_CHIPS[preProbe] || []) : [],
      agentProfile: runtime.agentProfile,
      contextOptions: this.contextOptions
    });
    runtime.context = context.meta;
    if (context.summary) act.context_summary = context.summary;
    act.summary_cursor = context.summaryCursor;
    act.context_version = 1;

    const res = await this._callAI(context.messages, runtime, onReplyToken ? { onReplyToken } : undefined);
    let reply = '';
    const emptyPatch = { facts: [], decisions: [], corrections: [] };
    let slotUpdates = [], extras = [], corrections = [], restatement = [];
    let batchPlan = [], campaignOps = [];
    let needsLegacy = null, memoryPatch = emptyPatch, profilePatch = {};
    const absorb = (j) => {
      reply = typeof j.reply === 'string' ? j.reply : '';
      restatement = Array.isArray(j.restatement) ? j.restatement : [];
      slotUpdates = Array.isArray(j.slot_updates) ? j.slot_updates
        : (Array.isArray(j.slotUpdates) ? j.slotUpdates : []);
      extras = Array.isArray(j.extras) ? j.extras : [];
      corrections = Array.isArray(j.corrections) ? j.corrections : [];
      // Wave 3 批次域（I1/I3）：可选 batch_plan / campaign_ops（引擎校验后经执行器落地）
      batchPlan = Array.isArray(j.batch_plan) ? j.batch_plan : (Array.isArray(j.batchPlan) ? j.batchPlan : []);
      campaignOps = Array.isArray(j.campaign_ops) ? j.campaign_ops : (Array.isArray(j.campaignOps) ? j.campaignOps : []);
      needsLegacy = (j.needs && typeof j.needs === 'object') ? j.needs : null;
      memoryPatch = (j.memory_patch && typeof j.memory_patch === 'object') ? j.memory_patch
        : (j.memoryPatch && typeof j.memoryPatch === 'object' ? j.memoryPatch : emptyPatch);
      profilePatch = (j.profile_patch && typeof j.profile_patch === 'object') ? j.profile_patch
        : (j.profilePatch && typeof j.profilePatch === 'object' ? j.profilePatch : {});
    };
    if (typeof res === 'string') {
      try { absorb(JSON.parse(res)); }
      catch (e) { reply = res; } // 非 JSON → 整段当话术（0 提取），引擎补词表抽取
    } else if (res && typeof res === 'object') {
      absorb(res);
    }
    // 旧契约兼容：{needs:{audience:...}} → slot_updates（explicit，confidence=1，仍过 B1 critic 校验）
    if (needsLegacy) {
      const { normalizeSlot } = require('./needs');
      for (const f of NEEDED_FIELDS) {
        let raw = needsLegacy[f];
        if (f === 'reason' && !raw && needsLegacy.pain != null) raw = needsLegacy.pain;
        const slot = normalizeSlot(raw);
        if (slot) slotUpdates.push({ slot: f, value: slot.value, confidence: 1, inferred: false });
      }
    }
    return { reply, restatement, slotUpdates, extras, corrections, batchPlan, campaignOps, memoryPatch, profilePatch };
  }

  /** L2 复核（本地正则 + critic 精判），供重生成后判定 */
  async _passL2(text, runtime) {
    if (!guardrailL2(text)) return false;
    if (this.callCritic && this._criticRequired(text)) {
      if (runtime.llmCalls >= this.maxLlmCallsPerTurn) return false;
      runtime.llmCalls++;
      runtime.providerRequests++;
      runtime.criticCalls++;
      try { return await this.callCritic(text); } catch (e) { return false; } // fail-closed
    }
    return true;
  }

  /** 护栏违规时，真实模型「重生成 1 次」（架构 §10：违规→重生成 1 次 + 兜底）
   *  复用 token-aware context builder，并把约束追加进末句，避免输出违规/抢跑内容。 */
  async _tryRegen(act, userText, why, runtime) {
    if (!this.aiEnabled || !this.callAI) return null; // 桩模型无重生成能力，直接兜底
    const isPreachy = why === 'preachy';
    const constraint = isPreachy
      ? '严禁说教、列清单、推销框架或替用户下结论；用极简口语追问或确认。'
      : why === 'repeat'
        ? '严禁重复你上一句回复的原文或近似原文；必须换个角度、给例子或把对话往前推一步。'
        : '严禁在确认前输出方案卡/主题行/优惠码等配置内容；只做引导对话。';
    const regenText = `用户刚才说：「${userText}」。上一轮回复触发了护栏（${isPreachy ? '说教/推销' : why === 'repeat' ? '复读上一句' : '抢跑'}），${constraint}请重新组织一句回复。`;
    const promptNeeds = plainNeeds(act.needs);
    if (!promptNeeds.offer && runtime.agentProfile.default_offer) {
      promptNeeds.offer = runtime.agentProfile.default_offer;
    }
    const probe = this._nextProbeSlot(act);
    const context = buildCoachContext({
      act,
      userText: regenText,
      needs: promptNeeds,
      stage: act.stage,
      missing: probe ? [probe] : [],
      chips: probe ? (SLOT_CHIPS[probe] || []) : [],
      agentProfile: runtime.agentProfile,
      contextOptions: this.contextOptions
    });
    try {
      const res = await this._callAI(context.messages, runtime);
      let r = '';
      if (typeof res === 'string') {
        try { const j = JSON.parse(res); r = j.reply || ''; } catch (e) { r = res; }
      } else if (res && typeof res === 'object') {
        r = res.reply || '';
      }
      return (r && r.trim()) ? r.trim() : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * @deprecated 旧逻辑：按「商家聊天文字」判语种来决定邮件语言 —— 这是错的。
   *   邮件发给进店客户，语种应跟「收件人 locale」（见 recipientLang / renderForRecipient）。
   *   本方法仅保留以防外部引用，不再用于决定邮件语种。
   */
  detectLang(act) {
    const msgs = (act && Array.isArray(act.messages) ? act.messages : []);
    const u = msgs.filter(m => m.role === 'user').map(m => m.content || '').join(' ');
    if (/[一-鿿]/.test(u)) return 'zh';
    if (/[A-Za-z]{3,}/.test(u)) return 'en';
    return 'zh';
  }

  /** 优惠文案（按语种；中英文关键词都认） */
  _offerText(o, lang) {
    o = o || '';
    if (lang === 'en') {
      const zheM = o.match(/(\d+(?:\.\d+)?)\s*折/);       // 「8 折」→ 20% off（商家说折、邮件说 %，必须换算）
      if (zheM) {
        const raw = parseFloat(zheM[1]);
        const zhe = raw > 10 ? raw / 10 : raw;             // 「85 折」= 8.5 折
        return Math.round((10 - zhe) * 10) + '% off';
      }
      const m = o.match(/(\d+)\s*%/);
      if (m) return m[1] + '% off';
      if (/包邮|免邮|运费|free\s*shipping|shipping/i.test(o)) return 'free shipping';
      if (/优惠码|券|coupon|promo|discount\s*code/i.test(o)) return 'an exclusive coupon';
      return '10% off'; // 兜底必须带数字：下游变体/海报默认就是 10% off，不能让「a special offer」和实际数字打架（走查 P1-5）
    }
    return o || '10% off 专属优惠';
  }

  /** 目标动作短语（先判意图·中英文都认，再按语种输出；避免把 goal 原样直插句子造成语法断裂） */
  _goalVerb(goal, lang) {
    goal = (goal || '').toLowerCase();
    const isPay = /付款|付了款|结账|结算|结清|完成下单|complete|purchase|checkout|pay/i.test(goal);
    const isReorder = /复购|再买|回购|reorder|buy\s+again|repeat/i.test(goal);
    const isOrder = /转化|下单|购买|买|order|buy/i.test(goal);
    if (lang === 'en') {
      if (isPay) return 'complete your purchase';
      if (isReorder) return 'place another order';
      if (isOrder) return 'place your order';
      return 'come back';
    }
    if (isPay) return '把订单付了';
    if (isReorder) return '再下一单';
    if (isOrder) return '下单带走';
    return '回来逛逛';
  }

  /** 痛点英文（受众推导，避免直译中文自由文本） */
  _painEn(n) {
    const a = n.audience || '';
    if (/加购|未付|弃购|abandon|cart|checkout|unpaid/i.test(a)) return 'left items in your cart without checking out';
    if (/老客|沉睡|流失|dormant|lapsed|lost/i.test(a)) return 'been away for a while';
    if (/浏览|brows/i.test(a)) return "browsed but didn't buy";
    return "haven't finished your order";
  }

  /** 推荐发送时机（按受众紧迫度 + 语种；加购未付走分钟级黄金窗口，走查 P1-10） */
  _sendTiming(n, lang) {
    const a = (n.audience || '');
    const zh = [
      [/加购|未付/, '30–60 分钟内发送（弃购挽回黄金窗口，趁购物车未清空）'],
      [/弃购/, '48 小时内发送（弃购挽回窗口）'],
      [/老客|沉睡|流失/, '7 天内唤醒（低频，避免打扰）'],
      [/浏览/, '3 天内种草召回']
    ];
    const en = [
      [/加购|未付|cart|unpaid|abandon/i, 'Send within 30–60 min (golden window — cart still active)'],
      [/弃购|abandoned/i, 'Send within 48h (abandoned-checkout window)'],
      [/老客|沉睡|流失|dormant|lapsed/i, 'Re-engage within 7 days (low frequency)'],
      [/浏览|brows/i, 'Reach within 3 days (retargeting)']
    ];
    const tbl = lang === 'en' ? en : zh;
    for (const [re, t] of tbl) if (re.test(a)) return t;
    return lang === 'en' ? 'Send within 3 days' : '3 天内发送';
  }

  _subject(n, lang) {
    const a = n.audience || '';
    const o = this._offerText(n.offer, lang);
    if (lang === 'en') {
      if (/弃购|未付|加购|abandon|cart|checkout|unpaid|churn/i.test(a)) return `Your order is waiting — here's ${o}`;
      if (/老客|沉睡|流失|dormant|lost|lapsed|returning/i.test(a)) return `We saved something for you`;
      return `Come back — we've got ${o} for you`;
    }
    if (/弃购|未付|加购/.test(a)) return `你落下的订单，我们帮你留着（${o}）`;
    if (/老客|沉睡|流失/.test(a)) return `好久不见，给你留了份${o}`;
    return `回来逛逛？给你准备了${o}`;
  }

  _body(n, coupon, lang) {
    const offer = this._offerText(n.offer, lang);
    if (lang === 'en') {
      const pain = this._painEn(n);
      const verb = this._goalVerb(n.goal, lang);
      // E2 红线：没有真实存在的码绝不写码行（确认后建码，预览卡/无钩子卡正文不出现假码）
      const codeLine = coupon
        ? `Use code ${coupon} at checkout to ${verb}.`
        : `Your welcome-back offer is ready — ${verb} and it will be applied.`;
      return [
        `Hi, we noticed you ${pain} and wanted to reach out.`,
        `We've set aside ${offer} just for you — a little welcome-back gift.`,
        codeLine,
        `Unsubscribe anytime — we respect your choice.`
      ].join('\n');
    }
    const pain = n.reason || n.pain || '太久没联系';
    const verb = this._goalVerb(n.goal, 'zh');
    const codeLine = coupon
      ? `优惠码 ${coupon}，点下面就能${verb}。`
      : `点下面就能${verb}，你的专属优惠确认后发放。`;
    return [
      `Hi，注意到你${pain}，特地回来找你。`,
      `这次专门给你留了「${offer}」，就当老朋友见面礼。`,
      codeLine,
      `退订点此，随时尊重你的选择。`
    ].join('\n');
  }

  /** 语种折叠：仅 zh/en 有内置模板，其余 locale 统一回落英文模板（跨境默认） */
  _collapseLang(l) { return l === 'zh' ? 'zh' : 'en'; }

  /** S3：生成方案卡（邮件配置建议，§5③）
   *  字段：受众 / 主题 / 正文 / 海报(3款) / 折扣 / 独立优惠码 / 发送时机
   *  PRD v2：inferred_slots 带出推断槽标记（C6），确认卡据此提示「这是我们的理解，可改」。
   *  Wave 2（E2 红线）：本方法只产出「基础卡」（文案/海报/数值口径），**绝不本地生成折扣码**——
   *    opts.code 必须来自店铺连接器真实回执（confirm 建码成功后传入）；缺省 = 无码（预览/无钩子卡）。
   *  ⚠️ 语种 lang 来自「收件人 locale」（opts.locale），绝不由商家聊天语言决定。
   *     opts.locale 缺省时回落 shopDefaultLocale（默认 en，跨境主客群）。
   *     发送时逐收件人本地化请用 renderForRecipient()，本卡只是「店铺默认语种」预览。 */
  producePlanCard(act, opts = {}) {
    const n = plainNeeds(act.needs); // 纯字符串视图（模板插值安全）
    const lang = this._collapseLang(opts.locale); // 仅 zh/en 有模板，其余语种回落 en
    const offer = this._offerText(n.offer, lang);
    // 折扣数值只在这里产生一处（% off 口径）：变体 / 海报 / 营销图统一读它，
    // 消除「8 / 10 / a special offer」三处默认值各说各话（走查 P1-5）。
    // 「8 折」= 20% off；「85 折」= 8.5 折 = 15% off（两位数写法归一化）；「20%」= 20% off；都缺省 = 10
    const offerSrc = String(n.offer || '');
    const zheToOff = (raw) => {
      const zhe = raw > 10 ? raw / 10 : raw;   // 「85 折」「95 折」= 8.5 / 9.5 折
      return +((10 - zhe) * 10).toFixed(1);
    };
    const zheM = offerSrc.match(/(\d+(?:\.\d+)?)\s*折/);
    const pctM = offerSrc.match(/(\d+(?:\.\d+)?)\s*%/);
    const isDiscountType = Boolean(zheM || pctM) || /(优惠码|折扣|coupon|promo|code)/i.test(offerSrc);
    const discountNum = zheM ? zheToOff(parseFloat(zheM[1]))
      : (pctM ? +pctM[1] : (isDiscountType ? 10 : 0));
    // 给商家看的文案（时机建议 / 海报方向）跟随商家对话语言，不跟店铺语种 —— 邮件正文才跟收件人（走查 P1-6）
    const merchantLang = this._collapseLang(this.detectLang(act));
    // E2：码只能来自店铺真实回执（opts.code）；本地绝不拼码（旧 COMEBACK- 随机码已根除）
    const coupon = String(opts.code || '').toUpperCase() || null;
    const subject = this._subject(n, lang);
    const body = this._body(n, coupon, lang);
    const posters = merchantLang === 'en'
      ? [
          { title: 'Pain-resonance', copy: `"You left something behind" + ${offer} hook` },
          { title: 'Scarcity-urgency', copy: `"Only X left / ${offer} limited-time" countdown` },
          { title: 'Benefit-direct', copy: `Big ${offer} + one-click return button` }
        ]
      : [
          { title: '痛点共鸣款', copy: `「你落下的，我们帮你留着」+ ${offer} 钩子` },
          { title: '稀缺紧迫款', copy: `「仅剩 X 件 / 限时 ${offer}」倒计时视觉` },
          { title: '利益直给款', copy: `大字 ${offer} + 一键回流按钮` }
        ];
    return {
      audience: n.audience || '高意向流失人群',
      reason: n.reason || '',        // PRD v2：与 needs.reason 对齐（旧 pain 键已删除）
      goal: n.goal || '',
      offer: offerSrc,               // offer 槽原文（E2 建码/无码分支判定用）
      subject,
      body,
      discount: offer,
      discountNum,
      posters,
      sendTiming: this._sendTiming(n, merchantLang),
      inferred_slots: inferredSlots(act.needs), // C6：推断槽带标记（如 ["audience"]），确认卡提示可改
      needs: n,        // 纯字符串 needs，供 renderForRecipient 逐收件人重新本地化
      locale: lang,
      generatedAt: Date.now()
    };
  }

  /**
   * 收件人语种：邮件发给「进店客户」，语种必须跟客户的 locale，不跟商家配置语言。
   * 优先级：收件人.locale → 收件人.country 推导 → 店铺默认语种 → fallback 'en'。
   * 依赖 storeConnector.normalizeLocale（国家→语种兜底）。
   */
  recipientLang(recipient, shopMeta) {
    const r = recipient || {};
    const fallback = (shopMeta && shopMeta.defaultLocale) || 'en';
    return normalizeLocale(r.locale, r.country, fallback);
  }

  /**
   * 发送时逐收件人本地化：同一张方案卡，按每个收件人的 locale 重新渲染主题/正文。
   * 这是「语种跟随客户」在发送环节的最终落点。
   * @returns { locale, subject, body, coupon }
   */
  renderForRecipient(planCard, recipient, shopMeta) {
    const lang = this._collapseLang(this.recipientLang(recipient, shopMeta));
    const n = (planCard && planCard.needs) || {};
    // E2 红线：无真实码就不渲染码（绝不回落假码占位）
    const coupon = (planCard && planCard.coupon) || '';
    return {
      locale: lang,
      subject: this._subject(n, lang),
      body: this._body(n, coupon, lang),
      coupon
    };
  }
}

module.exports = {
  IGDE, extractNeeds, extractOps, extractOpsTarget, batchesFromText, parseDateRangeZh, isNonInfo, scopeBoundary,
  guardrailL0, guardrailL1, guardrailL2, guardrailL3, guardrailL4,
  NEEDED_FIELDS, FIELD_LABEL, PREACH_PATTERNS, D_REDIRECT_POOL, FALLBACK_POOL,
  CORRECTION_TONE_RE, SLOT_CHIPS, valueGroundedInText, clampNeedValue, looksLikeInjection
};
