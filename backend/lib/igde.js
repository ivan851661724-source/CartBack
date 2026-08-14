'use strict';
/**
 * IGDE 引导式对话引擎（PRD §4 / 架构 §10）
 *
 * 核心 IP：引导用户把意图「自己说出来」并结构化，不是 AI 替用户决策，也不是翻译层。
 * - 四阶段 FSM：S0 接入 → S1 澄清 → S2 对齐 → S3 执行
 * - 意图抽取 act.needs 与话术解耦：新字段直接落库，已确认字段仅在明确纠错时更新
 * - 5 层护栏 L0–L4：违规 → 重生成 1 次 + 兜底安全模板
 * - 离线降级：AI 不可用时仍能跑（桩模型 / 「发挽回吗？」一句话确认）
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
// 店后台连接器：收件人 locale 归一化（邮件语种唯一权威来源）
const { normalizeLocale } = require('./storeConnector');

const NEEDED_FIELDS = ['audience', 'pain', 'goal', 'offer'];
const FIELD_LABEL = { audience: '针对谁', pain: '为什么挽回', goal: '要什么结果', offer: '给什么钩子' };

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
const BIZ_RE = /(店铺|网店|开店|店|生意|电商|卖货|卖东西|客户|邮件|营销|弃购|转化|下单|加购|购物车|浏览|老客|老顾客|会员|vip|优惠|折扣|包邮|限时|复购|回流|唤醒|沉睡|流失|gmv|销量|库存|发货|物流|退款|售后)/i;

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
function extractNeeds(text) {
  const t = (text || '').toLowerCase();
  const out = {};
  // audience（加购优先于「没付」，避免「加购没付」误判为弃购）
  if (/加购|购物车/.test(t)) out.audience = '加购未付客户';
  else if (/弃购|没付|未付|下单没|未下单/.test(t)) out.audience = '弃购 / 下单未付客户';
  else if (/浏览|看看|逛/.test(t)) out.audience = '浏览未买客户';
  else if (/老客|老顾客|会员|vip|沉睡|很久没|好久没|流失/.test(t)) out.audience = '沉睡 / 流失老客';
  else if (/新客|新人|新用户/.test(t)) out.audience = '新客';
  else if (/全部|所有|大家|都/.test(t)) out.audience = '全部流失人群';
  // pain（中英文双匹配）
  if (/太久|很久|好久|不活跃|没动静|沉默|忘了|忘记|没人管|被忽略/.test(t)) out.pain = '太久没动静、快被遗忘';
  else if (/竞品|别家|对手|别人家|competitor|rival/i.test(t)) out.pain = '可能被竞品勾走';
  else if (/运费太贵|运费贵|运费高|运费偏贵|shipping.*(expensive|cost|price)|too expensive|high? cost/i.test(t)) out.pain = '嫌运费贵、临门犹豫';
  else if (/贵|价格|预算|划算|expensive|price|cost|budget/i.test(t)) out.pain = '觉得贵、犹豫价格';
  else if (/犹豫|纠结|再想想|考虑|hesitat|unsure|thinking/i.test(t)) out.pain = '还在犹豫';
  // goal（中英文双匹配）
  if (/付款|付了款|付钱|结账|结算|结清|完成下单|complete\s+the\s+purchase|complete.*payment|checkout|pay\s+(for|the)/i.test(t)) out.goal = '促使完成付款 / 结账';
  else if (/复购|再买|再下一单|回购|reorder|buy\s+again|repeat\s+purchase|repeat\s+order/i.test(t)) out.goal = '促成复购 / 再下一单';
  else if (/回流|回来|唤?醒|召回|拉回/.test(t)) out.goal = '唤醒回流';
  else if (/转化|成交|下单|购买/.test(t)) out.goal = '提升到转化 / 成交';
  else if (/逛|看看|活跃/.test(t)) out.goal = '唤回活跃 / 回来逛逛';
  // offer
  if (/(不要|不用|不给|取消|不设|不打).{0,4}(折扣|优惠|券|包邮|钩子|折)/.test(t)) out.offer = '无额外优惠';
  else if (/([一二三四五六七八九]|\d+)\s*折/.test(t)) {
    const m = t.match(/([一二三四五六七八九]|\d+)\s*折/);
    const zhDigit = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    out.offer = (zhDigit[m[1]] || m[1]) + '折优惠';
  }
  else if (/满\s*(\d+)\s*减\s*(\d+)/.test(t)) { const m = t.match(/满\s*(\d+)\s*减\s*(\d+)/); out.offer = `满${m[1]}减${m[2]}`; }
  else if (/优惠码|优惠券|券|折扣码|promo|coupon/.test(t)) out.offer = '专属优惠码';
  else if (/包邮|免邮/.test(t)) out.offer = '包邮'; // 明确要包邮时优先于通用「折扣」词，避免"折扣改成包邮"被误抽成折扣
  else if (/(\d+)\s*%|打折|折扣/.test(t)) { const m = t.match(/(\d+)\s*%/); out.offer = (m ? m[1] + '%' : '折扣') + '优惠'; }
  else if (/限时|秒杀|紧迫|倒计时|赶紧/.test(t)) out.offer = '限时紧迫钩子';
  else if (/送|赠|礼/.test(t)) out.offer = '赠送礼品';
  return out;
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
  // 抢跑禁令：S3 之前不得输出方案卡式配置
  if (stage === 'S3') return true;
  if (/(优惠码[:：]|主题行[:：]|正文[:：]|方案卡|以下是配置)/.test(reply)) return false;
  return true;
}

/** Only send ambiguous/high-risk prose to the model critic; deterministic rules always run. */
function shouldCriticReview(reply) {
  const text = String(reply || '');
  return text.length > 180 ||
    /(首先|其次|最后|第[一二三四五12345]步|建议|策略|方法|保证|一定能|必须|应该|务必|清单|框架)/.test(text);
}

// 注意：旧 SAFE_TEMPLATE 复读机已废除（P0-2），统一改用 FALLBACK_POOL 轮换兜底（见 _pickFallback）。

/**
 * IGDE 引擎
 * @param {object} opts
 *   aiEnabled: boolean 是否接了真实模型
 *   callAI: async (systemPrompt, userPrompt) => {reply, needs}  真实模型适配器（可选）
 *   callCritic: async (text) => boolean  精判是否违规（可选，缺省用本地正则）
 */
class IGDE {
  constructor(opts = {}) {
    this.aiEnabled = !!opts.aiEnabled;
    this.callAI = opts.callAI || null;
    this.callCritic = opts.callCritic || null;
    this.contextOptions = opts.contextOptions || {};
    this.maxLlmCallsPerTurn = Math.max(1, Math.min(8, Number(opts.maxLlmCallsPerTurn) || 3));
    this.criticMode = ['always', 'suspicious', 'off'].includes(opts.criticMode)
      ? opts.criticMode
      : 'suspicious';
  }

  /** 已确认字段默认不覆盖；只有用户明确纠错时才更新。 */
  applyNeeds(act, extracted, userText = '') {
    act.needs = act.needs || {};
    const correction = /(不是|不对|改成|改为|纠正|更新|换成|其实|之前说错|rather|instead|actually|correction)/i.test(userText);
    const correctionTail = correction
      ? String(userText).split(/不是|不对|改成|改为|纠正|更新|换成|其实|之前说错|rather|instead|actually|correction/i).pop()
      : '';
    const explicitCorrection = correction ? extractNeeds(correctionTail) : {};
    if (correction && /(受众|客户|顾客|人群|这拨人)/.test(correctionTail)) explicitCorrection.audience = explicitCorrection.audience || true;
    if (correction && /(痛点|原因|因为|为啥|为什么)/.test(correctionTail)) explicitCorrection.pain = explicitCorrection.pain || true;
    if (correction && /(目标|希望|回来干啥|想让)/.test(correctionTail)) explicitCorrection.goal = explicitCorrection.goal || true;
    if (correction && /(优惠|折|券|包邮|免邮|钩子|满减|赠品)/.test(correctionTail)) explicitCorrection.offer = explicitCorrection.offer || true;
    for (const f of NEEDED_FIELDS) {
      if (extracted && extracted[f] != null && String(extracted[f]).trim()) {
        const next = String(extracted[f]).trim();
        if (!act.needs[f] || act.needs[f] === next || (correction && explicitCorrection[f])) act.needs[f] = next;
      }
    }
    return act.needs;
  }

  missingFields(act) {
    return NEEDED_FIELDS.filter(f => !act.needs || !act.needs[f]);
  }

  /** 缺失字段的引导问句（教练式：问多于说、极简） */
  probeFor(field) {
    const map = {
      audience: '先说最想挽回哪拨人？弃购的、加购没付的，还是好久没来的老客？',
      pain: '他们为啥快丢了？太久没动静、被竞品勾走，还是单纯忘了？',
      goal: '你希望他们回来干啥？再下一单、回来逛逛，还是唤醒沉睡的？',
      offer: '想给点什么钩子？折扣、专属优惠码，还是包邮 / 限时？'
    };
    return map[field];
  }

  s0Open() {
    return '想挽回哪拨流失客人？跟我说说你想针对谁、为啥、希望他们回来干啥就行。';
  }

  /** 会话创建时一次性下发 S0 开场白（不推进阶段） */
  opening() {
    return { reply: this.s0Open(), stage: 'S0' };
  }

  /** 追问单点字段；若与上一句助手回复相同则换一种说法，避免连续重复（防复读） */
  _probe(act, field) {
    const p = this.probeFor(field);
    const last = act.messages[act.messages.length - 1];
    if (last && last.role === 'assistant' && last.content === p) {
      return '再帮我想想这一项就行：' + p;
    }
    return p;
  }

  /** 主入口：处理一条用户消息 */
  async handle(act, userText, opts = {}) {
    const guardrailHits = [];
    act.needs = act.needs || {};
    act.messages = act.messages || [];
    act.memory = normalizeMemory(act.memory || createEmptyMemory());
    act.summary_cursor = Number(act.summary_cursor) || 0;
    act.context_version = Number(act.context_version) || 1;
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
      agentProfile: normalizeAgentProfile(opts.agentProfile),
      profileChanged: false
    };
    const beforeKeys = Object.keys(act.needs);

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
        act.messages.push({ role: 'user', content: userText, ts: Date.now() });
        act.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
        act.updated_at = Date.now();
        return { reply, stage: act.stage, needs: act.needs, planCard: null, guardrailHits: ['SCOPE'] };
      }
      // 否则（软边界 + 有真模型）：不在此拦截，继续下沉到 _aiCoach 让模型自然处理
    }

    // —— 离题 / 元问题 / 身份询问（needs 仍为空、无业务指向）：给温和、不重复的接住拉回 ——
    //    不甩死模板、不追问字段、guardrailHits 记空（非边界拒绝）；一旦有业务上下文则交给正常收集。
    const routed = this._routeOffTopic(act, userText);
    if (routed) {
      const reply = this._rotateReply(act, routed.primary, routed.pool);
      act.messages.push({ role: 'user', content: userText, ts: Date.now() });
      act.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
      act.updated_at = Date.now();
      return { reply, stage: act.stage, needs: act.needs, planCard: null, guardrailHits: [] };
    }

    // —— applyNeeds 无条件第一优先级（话术解耦） ——
    let extracted;
    let reply = '';
    let aiDead = false;
    let memoryPatch = null;
    let profilePatch = null;
    if (this.aiEnabled && this.callAI) {
      try {
        const r = await this._aiCoach(act, userText, runtime); // 一次对话同时抽取 needs + 生成话术
        // 抽取合并：AI 抽取优先；AI 漏抽的字段用关键词启发式补缺（保证四要素迟早集齐，确认标签能弹出）
        extracted = { ...(r.needs || {}) };
        const kw = extractNeeds(userText);
        for (const f of NEEDED_FIELDS) if (!extracted[f] && kw[f]) extracted[f] = kw[f];
        reply = r.reply;
        memoryPatch = r.memoryPatch;
        profilePatch = r.profilePatch;
      } catch (e) {
        extracted = extractNeeds(userText); // AI 调用失败 → 离线降级（抽取走关键词启发式）
        aiDead = true;
      }
    } else {
      extracted = extractNeeds(userText);
    }
    this.applyNeeds(act, extracted, userText);
    // 用户明确指定的本次 offer 优先；没指定时才沿用其已确认的长期默认值。
    if (!act.needs.offer && runtime.agentProfile.default_offer) {
      act.needs.offer = runtime.agentProfile.default_offer;
    }
    if (memoryPatch) {
      const memoryStats = applyMemoryPatch(act, memoryPatch, {
        userText,
        sourceMessageIndex: act.messages.length,
        now: Date.now()
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

    // 弱信号离题兜底：仅桩模式使用（无模型时才需引擎判断 stalled）。
    // 有真模型时，_aiCoach 已自然接住离题，此处若兜底会覆盖模型的正常回复 → 必须跳过。
    if (!this.aiEnabled && this._offTopicWeak(act, userText, beforeKeys)) {
      const reply2 = this._rotateReply(act, D_REDIRECT_POOL[0], D_REDIRECT_POOL);
      act.messages.push({ role: 'user', content: userText, ts: Date.now() });
      act.messages.push({ role: 'assistant', content: reply2, ts: Date.now() });
      act.updated_at = Date.now();
      return { reply: reply2, stage: act.stage, needs: act.needs, planCard: null, guardrailHits: ['SCOPE'] };
    }

    // 离线降级 / 桩模型 / 模型空回复：无缝回落桩教练（§5 可靠：离线也能跑）
    if (!reply) {
      try { reply = this._stubReply(act, userText); }
      catch (e) { reply = this._pickFallback(act); }
      if (aiDead && !guardrailHits.includes('AI_OFFLINE')) guardrailHits.push('AI_OFFLINE');
    }

    // —— 单一 FSM 权威：阶段推进只在此处（桩/AI 两条路径一致），_stubReply/_aiCoach 不碰 stage（P2-1）——
    this._advanceStage(act, userText);

    // —— 护栏管线（L0→L1→L2→L4；违规重生成 1 次 + 轮换兜底）——
    //    注：L3 已软化（P0-4）—— 不再强制问号，问号与否交给模型人格（COACH_SYSTEM_PROMPT 要求"该问才问"）
    if (!guardrailL0(reply)) { reply = this._pickFallback(act); guardrailHits.push('L0'); }
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

    act.messages.push({ role: 'user', content: userText, ts: Date.now() });
    act.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
    act.updated_at = Date.now();

    // 静默采集：四要素齐即产出方案卡（前端弹确认标签）；不以 ready 回写 stage（避免把 deny→S1 顶回 S3）
    const planCard = this.missingFields(act).length === 0 ? this.producePlanCard(act, { locale: opts.locale }) : null;
    return {
      reply, stage: act.stage, needs: act.needs, planCard, guardrailHits,
      agentMeta: this._agentMeta(runtime)
    };
  }

  /** 离题/元问题/身份询问路由：needs 仍为空且无业务指向时，返回温和接住池（轮换防复读）；否则 null。
   *  注意：仅当「尚无业务上下文」时拦截，避免误伤已进入收集的正常对话；业务关键词命中直接放行。 */
  _routeOffTopic(act, userText) {
    // 接了真模型时，离题 / 闲聊 / 身份 / 元问题交给 _aiCoach 自然处理（系统提示词含对应口径），
    // 不再用写死模板提前 return —— 否则会陷入「人机话循环」。仅桩模式（无模型）才用模板兜底。
    if (this.aiEnabled) return null;
    const t = (userText || '').trim();
    if (!t) return null;
    if (Object.keys(act.needs || {}).length > 0) return null; // 已有业务上下文 → 正常收集
    if (BIZ_RE.test(t)) return null;                          // 业务相关 → 不拦
    if (IDENTITY_RE.test(t)) return { primary: IDENTITY_POOL[0], pool: IDENTITY_POOL };
    if (META_RE.test(t)) return { primary: META_POOL[0], pool: META_POOL };
    return { primary: OFFTOPIC_POOL[0], pool: OFFTOPIC_POOL };
  }

  /** 弱信号离题兜底：多轮无任何新字段 + 无业务关键词 + 非确认/调整意图 → 视为 stalled/离题，接住拉回 */
  _offTopicWeak(act, userText, beforeKeys) {
    const t = (userText || '').trim();
    if (!t) return false;
    // 业务关键词命中 → 绝非离题
    if (BIZ_RE.test(t)) return false;
    const afterKeys = Object.keys(act.needs || {});
    if (afterKeys.length <= beforeKeys.length) {
      if (afterKeys.length === 0) return false; // 还没聊出任何字段，用户在想，不判离题
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

  /** 单一 FSM 权威：依据「已收集字段 + 用户意图」推进阶段；桩/AI 两条路径共用（P2-1） */
  _advanceStage(act, userText) {
    const t = (userText || '').trim().toLowerCase();
    const miss = this.missingFields(act);
    const deny = /不对|错|改|不是|纠正|重新|等下|等等|再想想/.test(t);
    const confirm = /对|是的|可以|确认|没问题|ok|好|行|就这样|generate|生成|出方案|方案|配置/.test(t);
    const wantAdjust = /改|调(整|整下)?|再聊|不对|换|重(新|做)?|另一|别的|加一拨|换拨|再想想/.test(t);

    if (act.stage === 'S3') { if (wantAdjust) act.stage = 'S1'; return; }
    if (act.stage === 'S2') {
      if (deny) { act.stage = 'S1'; return; }                       // 否认 → 回澄清
      if (miss.length === 0 && confirm) { act.stage = 'S3'; return; } // 四要素齐 + 确认 → 执行
      return;                                                       // 否则停留对齐
    }
    if (act.stage === 'S1') { if (miss.length === 0) act.stage = 'S2'; return; }
    if (act.stage === 'S0') {
      act.stage = 'S1';
      if (miss.length === 0) act.stage = 'S2';
      return;
    }
  }

  /** 桩模型回复（离线可用，功能完整的教练） */
  _stubReply(act, userText) {
    const nonInfo = isNonInfo(userText);
    if (act.stage === 'S0') {
      // 阶段推进统一由 _advanceStage 负责；此处只产出首轮澄清话术
      if (this.missingFields(act).length) return this._probe(act, this.missingFields(act)[0]);
      return this._replyFresh(act, this._readyLine(), FALLBACK_POOL);
    }
    if (act.stage === 'S1') {
      if (nonInfo) {
        return this._replyFresh(act, '没事，这块本来就乱。你就想着「谁快丢了、想让他们回来干啥」就行，别的我来帮你理。', FALLBACK_POOL);
      }
      const miss = this.missingFields(act);
      if (miss.length === 0) return this._replyFresh(act, this._readyLine(), FALLBACK_POOL);
      return this._probe(act, miss[0]);
    }
    if (act.stage === 'S2') {
      // 对齐 / 确认 / 否认；对话里不暴露字段（字段只在确认标签出现）
      const t = userText.trim();
      const deny = /不对|错|改|不是|纠正|重新|等下|等等|再想想/.test(t);
      if (deny) return '好，哪点要改？告诉我，其它对的我留着。';
      if (this.missingFields(act).length === 0) {
        const confirm = /对|是的|可以|确认|没问题|ok|好|行|就这样|generate|生成|出方案|方案|配置/.test(t.toLowerCase());
        if (confirm) return '好，我按这个帮你把邮件配置生成好了，右边确认标签你可以看一眼再发。';
        return this._replyFresh(act, this._readyLine(), FALLBACK_POOL);
      }
      return this._probe(act, this.missingFields(act)[0]);
    }
    if (act.stage === 'S3') {
      // S3 执行阶段：按用户意图分流，避免「进 S3 后每轮回复完全相同」（防复读）
      const t = (userText || '').trim().toLowerCase();
      const wantAdjust = /改|调(整|整下)?|再聊|不对|换|重(新|做)?|另一|别的|加一拨|换拨|再想想/.test(t);
      const wantSend = /^(发|发吧|发送|发出|安排发)|发(送|吧|出)$|send|确认发送|去发|帮我发/.test(t);
      let cand;
      if (wantAdjust) {
        cand = '好，回到前面。你想先调哪一项？受众、痛点、目标还是钩子？';
      } else if (wantSend) {
        cand = '好，点右边「确认发送」就行；发完我会帮你盯送达和回流数据。';
      } else if (/生成|方案|配置|看卡|卡片|确认|行不|可以吗/.test(t)) {
        cand = '配置一直都在右边确认标签里，随时能看。确认好了就点「确认发送」。';
      } else {
        cand = '方案已经帮你整理好了，右边确认标签里能看到，点「确认发送」就发。还想针对别的人群再聊一轮也可以。';
      }
      // 防复读：若与上一句助手回复完全相同则换一种说法
      const last = act.messages[act.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === cand) {
        cand = '刚才那点没变。你说「发吧」我就帮你安排发送，或者换拨人再聊一轮。';
      }
      return this._replyFresh(act, cand, FALLBACK_POOL);
    }
    return this._pickFallback(act);
  }

  /** 主要信息收集完时的自然收口话术（不在对话里列字段 — 字段只在确认标签里出现） */
  _readyLine() {
    return '我大概摸清了，帮你整理成一封邮件营销配置，右边弹出确认标签啦，你瞅瞅这样行不？';
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

  async _callAI(messages, runtime) {
    if (runtime.llmCalls >= this.maxLlmCallsPerTurn) {
      const error = new Error('单轮 LLM 调用预算已用完');
      error.code = 'CALL_BUDGET';
      throw error;
    }
    runtime.llmCalls++;
    runtime.providerRequests++;
    const result = await this.callAI(messages);
    runtime.providerRequests += result && Number(result.requestCount) > 1
      ? Number(result.requestCount) - 1
      : 0;
    if (result && result.usage) this._mergeUsage(runtime, result.usage);
    return result;
  }

  /** 真实模型：一次对话同时完成话术、needs patch 与来源可校验的 memory patch。 */
  async _aiCoach(act, userText, runtime) {
    const promptNeeds = { ...act.needs };
    if (!promptNeeds.offer && runtime.agentProfile.default_offer) {
      promptNeeds.offer = runtime.agentProfile.default_offer;
    }
    const context = buildCoachContext({
      act,
      userText,
      needs: promptNeeds,
      stage: act.stage,
      missing: NEEDED_FIELDS.filter(field => !promptNeeds[field]),
      agentProfile: runtime.agentProfile,
      contextOptions: this.contextOptions
    });
    runtime.context = context.meta;
    if (context.summary) act.context_summary = context.summary;
    act.summary_cursor = context.summaryCursor;
    act.context_version = 1;

    const res = await this._callAI(context.messages, runtime);
    let reply = '', needs = {}, memoryPatch = { facts: [], decisions: [], corrections: [] }, profilePatch = {};
    if (typeof res === 'string') {
      try {
        const j = JSON.parse(res);
        reply = j.reply || '';
        needs = j.needs || {};
        memoryPatch = j.memory_patch || memoryPatch;
        profilePatch = j.profile_patch || profilePatch;
      }
      catch (e) { reply = res; } // 非 JSON → 整段当话术，needs 留空（引擎补抽取）
    } else if (res && typeof res === 'object') {
      reply = res.reply || '';
      needs = res.needs || {};
      memoryPatch = res.memoryPatch || res.memory_patch || memoryPatch;
      profilePatch = res.profilePatch || res.profile_patch || profilePatch;
    }
    return { reply, needs, memoryPatch, profilePatch };
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
      : '严禁在确认前输出方案卡/主题行/优惠码等配置内容；只做引导对话。';
    const regenText = `用户刚才说：「${userText}」。上一轮回复触发了护栏（${isPreachy ? '说教/推销' : '抢跑'}），${constraint}请重新组织一句回复。`;
    const promptNeeds = { ...act.needs };
    if (!promptNeeds.offer && runtime.agentProfile.default_offer) {
      promptNeeds.offer = runtime.agentProfile.default_offer;
    }
    const context = buildCoachContext({
      act,
      userText: regenText,
      needs: promptNeeds,
      stage: act.stage,
      missing: NEEDED_FIELDS.filter(field => !promptNeeds[field]),
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
      const m = o.match(/(\d+)\s*%/);
      if (m) return m[1] + '% off';
      if (/包邮|免邮|运费|free\s*shipping|shipping/i.test(o)) return 'free shipping';
      if (/优惠码|券|coupon|promo|discount\s*code/i.test(o)) return 'an exclusive coupon';
      return 'a special offer';
    }
    return o || '专属优惠';
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

  /** 推荐发送时机（按受众紧迫度 + 语种） */
  _sendTiming(n, lang) {
    const a = (n.audience || '');
    const zh = [
      [/加购|未付/, '24 小时内发送（紧迫，趁购物车未清空）'],
      [/弃购/, '48 小时内发送（弃购挽回窗口）'],
      [/老客|沉睡|流失/, '7 天内唤醒（低频，避免打扰）'],
      [/浏览/, '3 天内种草召回']
    ];
    const en = [
      [/加购|未付|cart|unpaid|abandon/i, 'Send within 24h (urgent — cart still active)'],
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
      return [
        `Hi, we noticed you ${pain} and wanted to reach out.`,
        `We've set aside ${offer} just for you — a little welcome-back gift.`,
        `Use code ${coupon} at checkout to ${verb}.`,
        `Unsubscribe anytime — we respect your choice.`
      ].join('\n');
    }
    const pain = n.pain || '太久没联系';
    const verb = this._goalVerb(n.goal, 'zh');
    return [
      `Hi，注意到你${pain}，特地回来找你。`,
      `这次专门给你留了「${offer}」，就当老朋友见面礼。`,
      `优惠码 ${coupon}，点下面就能${verb}。`,
      `退订点此，随时尊重你的选择。`
    ].join('\n');
  }

  /** 语种折叠：仅 zh/en 有内置模板，其余 locale 统一回落英文模板（跨境默认） */
  _collapseLang(l) { return l === 'zh' ? 'zh' : 'en'; }

  /** S3：生成方案卡（邮件配置建议，§5③）
   *  字段：受众 / 主题 / 正文 / 海报(3款) / 折扣 / 独立优惠码 / 发送时机
   *  ⚠️ 语种 lang 来自「收件人 locale」（opts.locale），绝不由商家聊天语言决定。
   *     opts.locale 缺省时回落 shopDefaultLocale（默认 en，跨境主客群）。
   *     发送时逐收件人本地化请用 renderForRecipient()，本卡只是「店铺默认语种」预览。 */
  producePlanCard(act, opts = {}) {
    const n = act.needs;
    const lang = this._collapseLang(opts.locale); // 仅 zh/en 有模板，其余语种回落 en
    const offer = this._offerText(n.offer, lang);
    const coupon = 'COMEBACK-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const subject = this._subject(n, lang);
    const body = this._body(n, coupon, lang);
    const posters = lang === 'en'
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
      subject,
      body,
      discount: offer,
      coupon,
      posters,
      sendTiming: this._sendTiming(n, lang),
      needs: n,        // 保留 needs，供 renderForRecipient 逐收件人重新本地化
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
    const coupon = (planCard && planCard.coupon) || 'COMEBACK-DEMO';
    return {
      locale: lang,
      subject: this._subject(n, lang),
      body: this._body(n, coupon, lang),
      coupon
    };
  }
}

module.exports = {
  IGDE, extractNeeds, isNonInfo, scopeBoundary,
  guardrailL0, guardrailL1, guardrailL2, guardrailL3, guardrailL4,
  NEEDED_FIELDS, FIELD_LABEL, PREACH_PATTERNS, D_REDIRECT_POOL, FALLBACK_POOL
};
