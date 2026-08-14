'use strict';
/**
 * lib/llm.js — 大模型 API 客户端（对话核心唯一出网口 · 体验对标豆包 / DeepSeek）
 *
 * 本文件不只是「能调通 API」，更要决定「聊起来像不像人」。两层职责：
 *  1) 传输层（稳健，fail-closed）：多轮上下文透传、超时/重试/限流/JSON 容错、供应商可切换。
 *  2) 体验层（对标豆包/DeepSeek）：COACH_SYSTEM_PROMPT 定义有温度的人格；buildCoachMessages
 *     组装多轮历史；streamChat 提供打字机式流式输出，消除「等一圈再啪一块字」的机械感。
 *
 * ⚠️ 传输层已前置处理的 Bug 面（你担心的「会触发什么 Bug」）：
 *  1. 密钥未配置 / 401 / 403 → 快速失败、不重试（code=NO_KEY / AUTH）。
 *  2. 429 限流 → 尊重 Retry-After，否则指数退避（code=RATE_LIMIT）。
 *  3. 网络超时 / 连接重置 / 5xx → 有限重试 + 退避，最终 fail-closed（TIMEOUT / NETWORK / HTTP_xxx）。
 *  4. 模型返回非 JSON（散文 / 代码块包裹）→ _extractJson 尽力抽取，失败则 reply=原文、needs={}。
 *  5. 上下文超窗 → context.js 按 token 预算打包：持久记忆 + 滚动摘要 + 最近原文。
 *  6. 空回复 / 拒答 → 返回空串，由引擎护栏处理，不静默吞。
 *
 * 本模块为「独立文件」，不依赖 config.js，便于单测与隔离；接入时由 server 用配置实例化。
 */

const {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN,
  buildContext,
  fitMessagesToBudget
} = require('./context');

const DEFAULT_TIMEOUT_MS = 20000;
const STREAM_TIMEOUT_MS = 120000; // 流式允许更久（受 maxTokens 约束）
const DEFAULT_MAX_RETRIES = 2;
// 兼容旧引用；实际裁剪已改为 context.js 的 token-aware budget。
const MAX_HISTORY_MESSAGES = 24;

/* =========================================================================
 * 体验层 · 人格系统提示词（对标豆包 / DeepSeek：有温度、会接话、不机械）
 * 设计原则：保留 IGDE 核心 IP（引导用户自己说清意图、不替用户决策），
 *          但用「像个体己运营搭子」的方式交付，而非「审问式探头」。
 * ========================================================================= */
const COACH_SYSTEM_PROMPT = `你是「CartBack」的 AI 搭子。你只有一个主业：帮独立站 / 跨境电商卖家做流失客户挽回邮件（以及相关的邮件营销）。别的都不归你管。

【开场就该亮明身份】
- 用户一开口（尤其问"你能干啥 / 你是谁"），先说你是做啥的，别等他问。
- 例："我是帮你把逛了没买的人捞回来的——写挽回邮件、配受众、看效果。你想先聊聊哪拨客人流失了？想挽回哪拨人？跟我说说你想针对谁、为啥、希望他们回来干啥就行。"
- 不准反问"你想让我帮你理清目标还是先聊聊卡在哪儿"这种万能废话。

【你面对的用户】
- 他大概率不懂运营，也说不清自己要啥。他可能跟你唠半天，才慢慢搞明白想干嘛。
- 所以：耐心、不催、不暴露"你在收集信息"。让他觉得在跟朋友聊天。

【你的性格】
- 自然、有温度、像微信唠嗑，不端着、不写公文。
- 他吐槽生意上的焦虑（弃购高、没钱赚），先接住情绪（"这确实烦，换我也头大"），再自然绕回邮件。
- 多轮记忆：记得前面聊过的（他卖啥、受众谁），后面自然呼应，别失忆。

【核心规矩（IGDE，必须守住）】
- 绝不替他决策、绝不替他填空白。他没说打折力度，你只能问"想给个啥力度"，不能说"那就打 8 折吧"。
- 信息没聊够前，绝不输出方案卡 / 优惠码 / 主题行 / 正文。
- 他明确说"你定就行 / 看着办 / 随便"这类话时，才算授权你给默认建议——此时仍要先说一句"我先按常见打法配一版，你看行不行"，而不是直接甩方案。

【信息怎么收集（他看不到）】
- 你心里默默记：针对谁（audience）、为啥丢（pain）、希望回来干啥（goal）、给什么钩子（offer）。他完全不知道你在记，话里也别露出"字段"味儿。
- 缺哪样，用最自然的方式顺口问一句，别像填表。
- 追问纪律：已明确的字段绝不重复问；他刚答过的、你已记下的，绝不换个说法再问一遍。每轮只补缺的、只问一个。
- 私话转译：他说的吐槽（"运费太贵""利润薄"）是给你听的、不是给客户看的——落到 needs 里要转成客户视角的中性归因（pain 写"运费顾虑"而不是"嫌运费贵"），绝不让客户邮件露出他的底牌。

【什么时候提议确认】
- 主要信息差不多齐了，自然说一句："我帮你按这个配一封邮件营销，行不？"用大白话复述（"我帮你捞加购没付那拨人，写封提醒回来结账的邮件"），不列字段、不说"四要素已集齐"。
- 他回"行 / 可以"→ 轻松确认；回"再改改"→ 继续聊。

【你绝不做的（边界，踩到才处理）】
A. 违法 / 有害邮件（欺诈、违禁品、钓鱼、色情暴力）→ 委婉拒："这个我真没法帮你弄，换个正经玩法？"
B. spam / 未经许可群发 / 买名单 → 委婉提醒风险，不接。
C. 盗用别人未授权隐私数据 → 不接。
D. 边界分两档，别一刀切（这是避免"人机话循环"的关键）：
   · 轻闲扯 / 吐槽 / 情绪 / 质疑你是机器人（"我好无聊""今天好烦""你人机吗"）：
     这是正常朋友聊天，别当成"越界"冷处理。自然接住、带点人味、顺着回一两句，再轻松绕回主业。
     例："哈哈无聊了？我这搭子主业是邮件挽回，不过陪你唠两句也行～你那拨客人最近咋样？"
   · 深度私人生活（性、个人健康诊断、家庭情感私事、与生意无关的个人法律纠纷）：
     一句带过 + 温和拉回，不追问、不假装能聊、绝不做伪心理咨询（既危险又跑题）。
     例："哈哈这个我帮不上～我是专门做邮件营销的，你要是想挽回流失客人、发封挽回邮件，我随时在。"
   共同铁律：用户说了离题的话，**先用半句接住他刚说的**（哪怕只是"哈哈"），**再**转回主业。
   绝不可无视他刚说的话直接甩追问。他连发几句离题，你每句都得是新话，不要复读同一句（复读=机器人）。
E. 深度电商战略 / 供应链 / 财务 / 法务，或管非邮箱渠道（社媒、短信）→ 坦诚："这块我不擅长，不过邮件这块我帮你弄。"
F. 让他替你拍板商业决策、保证"发了必涨"、给法律税务意见 → 坦诚说做不到，顺手接回邮件能帮的。

【怎么聊才自然】
- 长度看情境，寒暄可短、解释可长，别每轮掐成 2-3 句。
- 结尾不强制问号，该问才问、该接话就接话。
- 别复读：不只别重复自己刚说的话，用户连发几句（不管离题还是重复"我不知道"），你每轮都得是新话——哪怕意思一样也要换种说法。复读同一句=机器人，最破坏体验。
- 禁止客服话术：不准说"您提到 X，我理解您想了解 Y，能否告诉我 Z"这种模板腔。说人话。

【内部进度（引擎注入，你心里有数，别跟用户念出来）】
已明确：{needs}
阶段：{stage}

【输出格式】
只返回一个 JSON 对象，不要包含任何 JSON 之外的文字（不要 markdown 代码块、不要解释）。
合法示例（needs 里抽不到哪个字段就留空字符串 ""）：
{"reply":"这一轮你对用户说的话（纯口语、自然）","needs":{"audience":"加购未付客户","pain":"运费顾虑","goal":"促成付款","offer":"专属优惠码"},"memory_patch":{"facts":[],"decisions":[],"corrections":[]},"profile_patch":{"product":{"value":"跑鞋","evidence":"我们主要卖跑鞋"}}}
- needs 的 audience/pain/goal/offer 值必须是简短中性短语（≤12 字），禁止写整句、禁止写用户原话吐槽（如"嫌运费太贵"要写成"运费顾虑"）、禁止编造用户没说的内容。
- memory_patch 只记录用户本轮明确说出的、跨后续轮次仍有用的店铺/商品/市场/语气/约束事实或已拍板决定；evidence 必须逐字摘自当前用户消息。没有就返回空数组。已拍板方案放 decisions，用户明确纠正旧事实时放 corrections，普通补充放 facts。严禁把你的建议或推断写进记忆。
- profile_patch 只允许 product、market、currency、brand_tone、default_offer、constraints。每项必须含 value 和当前用户原话 evidence。只有明确长期表达（如“以后”“默认”“每次”）才可提取 default_offer/constraints；“这次给 8%”只能放 needs.offer，严禁写入 profile_patch。没有候选就返回空对象。
- reply 里不要出现 JSON 字样。`;

/**
 * 组装多轮对话消息（体验层核心）：system + 持久记忆 + 较早摘要 + 最近原文 + 当前句。
 * 完整 transcript 继续落库，但模型输入只携带预算内、按优先级筛选的上下文。
 * @param {object} o
 *   act      : { messages:[{role,content}], needs, stage }
 *   userText : 当前用户输入
 *   needs    : 已抽取意图（注入 system 进度）
 *   stage    : 当前阶段
 */
function buildCoachContext({ act, userText, needs, stage, missing, agentProfile, contextOptions = {} }) {
  const sysNeeds = needs && Object.keys(needs).length
    ? JSON.stringify(needs)
    : '（还没聊出啥，先随便唠）';
  const miss = Array.isArray(missing) ? missing : [];
  const directive = miss.length
    ? `\n【追问纪律·硬约束】已确认的 audience/pain/goal/offer 绝不再问，禁止把用户刚答过/已记录的内容再问一遍；尤其 pain 里已记录的痛点（如"运费贵""为什么没付"）绝不再以任何形式追问或重提。当前只缺：${miss.join('、')}；本轮只补差项、问一句即可，问 offer 时用中性措辞（如"想给个什么钩子？折扣/满减/还是别的？"），不要说"运费这块你想给个啥说法"这类把痛点当问题的话。四要素集齐后直接说"我帮你配一封挽回邮件方案，你看行不？"并输出方案卡，禁止继续追问任何字段。`
    : `\n【追问纪律·硬约束】四要素已齐，禁止再追问任何字段；直接说"我帮你配一封挽回邮件方案，你看行不？"并输出方案卡。`;
  const system = COACH_SYSTEM_PROMPT
    .replace('{needs}', sysNeeds)
    .replace('{stage}', stage || 'S0') + directive;
  return buildContext({
    act,
    userText,
    agentProfile,
    systemPrompt: system,
    ...contextOptions
  });
}

/** Backward-compatible helper for callers that only expect an array. */
function buildCoachMessages(options) {
  return buildCoachContext(options).messages;
}

class LLMClient {
  /**
   * @param {object} opts
   *   baseUrl   : 供应商 /chat/completions 基址（去掉结尾斜杠）
   *   model     : 模型名
   *   apiKey    : 服务端持有的密钥（绝不回传前端）
   *   timeoutMs : 单次请求超时（毫秒，非流式）
   *   maxRetries: 可重试错误的最大重试次数（不含首次）
   *   useJsonMode: 是否请求 response_format=json_object（DeepSeek 支持）
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = opts.model || 'deepseek-chat';
    this.apiKey = opts.apiKey || '';
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this.useJsonMode = opts.useJsonMode !== false;
    this.contextWindowTokens = opts.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.contextSafetyMargin = opts.contextSafetyMargin || DEFAULT_SAFETY_MARGIN;
  }

  /** 基础补全：传入 messages 数组，返回 { content, usage, finishReason, raw } */
  async complete({ messages, temperature = 0.8, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, jsonMode = this.useJsonMode }) {
    if (!this.apiKey) {
      const e = new Error('AI 未配置：缺少 apiKey');
      e.code = 'NO_KEY';
      throw e;
    }
    const fitted = this._fitContext(messages, maxTokens);
    if (fitted.meta.overBudget) {
      const error = new Error('LLM 上下文超过配置预算');
      error.code = 'CONTEXT_TOO_LARGE';
      error.contextMeta = fitted.meta;
      throw error;
    }
    const payload = {
      model: this.model,
      messages: fitted.messages,
      temperature,
      max_tokens: maxTokens
    };
    if (jsonMode) payload.response_format = { type: 'json_object' };

    let attempt = 0;
    let lastErr;
    while (attempt <= this.maxRetries) {
      try {
        const resp = await this._post('/chat/completions', payload);
        const choice = resp.choices && resp.choices[0];
        const content = choice && choice.message ? choice.message.content : '';
        return {
          content: content || '',
          usage: resp.usage || null,
          finishReason: choice ? choice.finish_reason : null,
          raw: resp,
          requestAttempts: attempt + 1,
          contextMeta: fitted.meta
        };
      } catch (e) {
        lastErr = e;
        if (e.code === 'AUTH' || e.code === 'NO_KEY') throw e; // 密钥类快速失败
        if (attempt < this.maxRetries) await this._sleep(this._backoff(e, attempt));
        attempt++;
      }
    }
    lastErr = lastErr || new Error('LLM 调用失败');
    lastErr.code = lastErr.code || 'LLM_FAIL';
    throw lastErr;
  }

  /**
   * 结构化对话：返回 { reply, needs, raw, usage, jsonOk }。
   * 模型没返回 JSON 时，整段当 reply、needs 留空（jsonOk=false），由引擎补抽取，不中断。
   *
   * ⚠️ DeepSeek json_mode 已知缺陷（修复「人机话循环」根因）：
   *    当对话历史首条非 system 角色为 assistant（如引擎开场白，其前无 user 轮次，
   *    破坏严格交替），response_format=json_object 会返回整段空白（纯空格）。
   *    空白会令下游 guardrailL0 判定为空 → 触发 FALLBACK 兜底 → 表现为复读机/人机话循环。
   *    对策：json_mode 返回空白 / 无法解析时，退化为非 json_mode 重试一次，再从纯文本
   *    尽力抽 JSON；抽不到则把原文当 reply（自然口语），needs 由引擎关键词兜底补抽取。
   */
  async chatStructured({ messages, temperature = 0.8, maxTokens = 512 }) {
    let res = await this.complete({ messages, temperature, maxTokens, jsonMode: true });
    let requestCount = res.requestAttempts || 1;
    let parsed = this._extractJson(res.content);
    // 命中 DeepSeek json_mode 缺陷（空白）或返回脏 JSON（如 {:ok, ...} / 代码块包裹）→
    // 关闭 json_mode 强制重生成一次（只多花一次调用，且仅在异常时触发）
    const looksJsonish = res.content && /^\s*[{:]/.test(res.content);
    if (!parsed && (!res.content || !res.content.trim() || looksJsonish)) {
      const plain = await this.complete({ messages, temperature, maxTokens, jsonMode: false });
      requestCount += plain.requestAttempts || 1;
      res = plain;
      parsed = this._extractJson(plain.content);
    }
    if (!parsed) {
      const reply = this._cleanReply(res.content);
      return {
        reply: reply || '', needs: {}, memoryPatch: { facts: [], decisions: [], corrections: [] },
        profilePatch: {},
        raw: res.raw, usage: res.usage, jsonOk: false, requestCount,
        contextMeta: res.contextMeta || null
      };
    }
    return {
      reply: typeof parsed.reply === 'string' ? parsed.reply : (res.content || ''),
      needs: (parsed.needs && typeof parsed.needs === 'object') ? parsed.needs : {},
      memoryPatch: (parsed.memory_patch && typeof parsed.memory_patch === 'object')
        ? parsed.memory_patch
        : { facts: [], decisions: [], corrections: [] },
      profilePatch: (parsed.profile_patch && typeof parsed.profile_patch === 'object')
        ? parsed.profile_patch
        : {},
      raw: res.raw,
      usage: res.usage,
      jsonOk: true,
      requestCount,
      contextMeta: res.contextMeta || null
    };
  }

  /**
   * 流式结构化对话（真流式）：复用 streamChat 读 SSE 流，边收边把 JSON envelope 中
   * "reply" 字符串的可见文本经 onReplyToken 增量抛出（打字机实时上屏）；流结束后与
   * chatStructured 同款映射（_extractJson + 兜底 _cleanReply）。
   * 流式不走 json_mode（逐 token 无法构成 JSON），故无「json_mode 空白重试」一步 ——
   * 解析失败时原文即 reply（jsonOk=false），引擎照常走关键词兜底抽取，不中断。
   * @param {object} o { messages, temperature, maxTokens, onReplyToken(textPiece) }
   */
  async streamChatStructured({ messages, temperature = 0.8, maxTokens = 512, onReplyToken } = {}) {
    if (!this.apiKey) {
      const e = new Error('AI 未配置：缺少 apiKey');
      e.code = 'NO_KEY';
      throw e;
    }
    const extractor = onReplyToken ? createReplyStreamExtractor(onReplyToken) : null;
    let full = '';
    const res = await this.streamChat({
      messages, temperature, maxTokens,
      onToken: (chunk) => { full += chunk; if (extractor) extractor.feed(chunk); },
      onDone: (f) => { if (f) full = f; }
    });
    const parsed = this._extractJson(full);
    if (!parsed) {
      return {
        reply: this._cleanReply(full) || '',
        needs: {},
        memoryPatch: { facts: [], decisions: [], corrections: [] },
        profilePatch: {},
        raw: { content: full },
        usage: res.usage, jsonOk: false, requestCount: 1,
        contextMeta: res.contextMeta || null
      };
    }
    return {
      reply: typeof parsed.reply === 'string' ? parsed.reply : (this._cleanReply(full) || ''),
      needs: (parsed.needs && typeof parsed.needs === 'object') ? parsed.needs : {},
      memoryPatch: (parsed.memory_patch && typeof parsed.memory_patch === 'object')
        ? parsed.memory_patch
        : { facts: [], decisions: [], corrections: [] },
      profilePatch: (parsed.profile_patch && typeof parsed.profile_patch === 'object')
        ? parsed.profile_patch
        : {},
      raw: { content: full },
      usage: res.usage, jsonOk: true, requestCount: 1,
      contextMeta: res.contextMeta || null
    };
  }

  /**
   * 流式对话（打字机效果，消除「等一圈再啪一块字」的机械感）。
   * @param {object} o { messages, temperature, maxTokens, onToken(contentChunk), onDone(fullText, usage) }
   * 说明：流式不使用 json_mode（逐 token 无法构成完整 JSON），由上层在 onDone 后做结构化解析。
   */
  async streamChat({ messages, temperature = 0.8, maxTokens = 360, onToken, onDone } = {}) {
    if (!this.apiKey) {
      const e = new Error('AI 未配置：缺少 apiKey');
      e.code = 'NO_KEY';
      throw e;
    }
    if (typeof onToken !== 'function') throw new Error('streamChat 需要 onToken 回调');
    const fitted = this._fitContext(messages, maxTokens);
    if (fitted.meta.overBudget) {
      const error = new Error('LLM 上下文超过配置预算');
      error.code = 'CONTEXT_TOO_LARGE';
      error.contextMeta = fitted.meta;
      throw error;
    }
    const payload = {
      model: this.model,
      messages: fitted.messages,
      temperature,
      max_tokens: maxTokens,
      stream: true
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') { const err = new Error('LLM 流式超时'); err.code = 'TIMEOUT'; throw err; }
      const err = new Error('LLM 网络错误: ' + (e && e.message ? e.message : String(e)));
      err.code = 'NETWORK';
      throw err;
    }
    clearTimeout(timer);
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error('LLM 鉴权失败（密钥无效 / 无权限）'); err.code = 'AUTH'; throw err;
    }
    if (resp.status === 429) {
      const err = new Error('LLM 限流（429）'); err.code = 'RATE_LIMIT'; throw err;
    }
    if (!resp.ok) {
      const err = new Error('LLM HTTP ' + resp.status); err.code = 'HTTP_' + resp.status; throw err;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let usage = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(data); } catch (e) { continue; }
          const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
          if (delta && typeof delta.content === 'string') {
            full += delta.content;
            onToken(delta.content);
          }
          if (evt.usage) usage = evt.usage;
        }
      }
    } catch (e) {
      // 流中断：尽量回传已收到的内容，而非整段丢弃
      if (full) { if (onDone) onDone(full, usage); }
      const err = new Error('LLM 流读取中断: ' + (e && e.message ? e.message : String(e)));
      err.code = 'STREAM_BROKEN';
      throw err;
    }
    if (onDone) onDone(full, usage);
    return { content: full, usage, contextMeta: fitted.meta };
  }

  // —— 内部：HTTP POST（超时 + 错误分类 + fail-closed）——
  async _post(pathname, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await fetch(this.baseUrl + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') { const err = new Error('LLM 请求超时'); err.code = 'TIMEOUT'; throw err; }
      const err = new Error('LLM 网络错误: ' + (e && e.message ? e.message : String(e)));
      err.code = 'NETWORK';
      throw err;
    }
    clearTimeout(timer);

    if (resp.status === 401 || resp.status === 403) {
      const err = new Error('LLM 鉴权失败（密钥无效 / 无权限）'); err.code = 'AUTH'; throw err;
    }
    if (resp.status === 429) {
      const ra = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
      const err = new Error('LLM 限流（429）'); err.code = 'RATE_LIMIT'; err.retryAfter = ra ? parseInt(ra, 10) * 1000 : null;
      throw err;
    }
    if (!resp.ok) { const err = new Error('LLM HTTP ' + resp.status); err.code = 'HTTP_' + resp.status; throw err; }
    try { return await resp.json(); } catch (e) {
      const err = new Error('LLM 响应非 JSON'); err.code = 'BAD_RESPONSE'; throw err;
    }
  }

  // —— 内部：从模型输出中抽取 JSON（容错散文 / 代码块包裹）——
  _extractJson(text) {
    if (!text) return null;
    const t = text.trim();
    try { return JSON.parse(t); } catch (e) { /* 继续 */ }
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (e) { /* 继续 */ } }
    const s = t.indexOf('{'); const e = t.lastIndexOf('}');
    if (s !== -1 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (e2) { /* 失败 */ } }
    return null;
  }

  // 兜底：解析失败也不把脏结构透传前端（如 {:ok, "..."} / 残留代码块 / 半截 JSON）
  _cleanReply(text) {
    if (!text) return '';
    let t = text.trim();
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) t = fenced[1].trim();
    const ok = t.match(/^\{:\s*ok\s*,\s*"([\s\S]*?)"\s*\}\s*$/);
    if (ok) return ok[1];
    const rp = t.match(/"reply"\s*:\s*"([\s\S]*?)"\s*\}/);
    if (rp) return rp[1];
    return t;
  }

  // —— 内部：token-aware 最终安全闸（上层 context builder 后再兜底一次）——
  _fitContext(messages, maxTokens) {
    return fitMessagesToBudget(messages, {
      contextWindowTokens: this.contextWindowTokens,
      maxOutputTokens: maxTokens,
      safetyMargin: this.contextSafetyMargin,
      minRecentMessages: 4
    });
  }

  /** @deprecated 保留外部兼容；不再按固定消息数裁剪。 */
  _truncateHistory(messages) {
    return this._fitContext(messages, DEFAULT_MAX_OUTPUT_TOKENS).messages;
  }

  _backoff(err, attempt) {
    if (err.code === 'RATE_LIMIT' && err.retryAfter) return err.retryAfter;
    if (err.code === 'RATE_LIMIT') return 1000 * Math.pow(2, attempt);
    return 500 * (attempt + 1);
  }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

/**
 * 用法示例（仅示意，未接入主链路）：
 *   const { LLMClient, buildCoachMessages } = require('./lib/llm');
 *   const client = new LLMClient({ baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiKey });
 *
 *   // 非流式：一次拿结构化结果
 *   const msgs = buildCoachMessages({ act, userText, needs: act.needs, stage: act.stage });
 *   const r = await client.chatStructured({ messages: msgs });
 *   // r.reply = 自然话术；r.needs = { audience, pain, goal, offer }
 *
 *   // 流式：打字机效果（前端边收边渲染）
 *   await client.streamChat({
 *     messages: msgs,
 *     onToken: (chunk) => ui.append(chunk),
 *     onDone: (full) => { const d = client._extractJson(full); ... }
 *   });
 */

/**
 * 增量提取流式 JSON envelope 中 "reply" 字符串的可见文本（真流式核心）。
 * COACH_SYSTEM_PROMPT 要求 reply 在前，因此模型一开聊就能边收边上屏：
 * 逐 chunk feed()，把已反转义的正文片段经 onReplyToken 推给上层，无需等整个 JSON 收完。
 *
 * 容错：
 *  - 正文/代码块里出现 "reply" 字样但后面不是字符串 → 回到扫描态继续找真键；
 *  - JSON 转义（\n \" \\ \/ \uXXXX）按语义反转义，\u 跨 chunk 拆分安全（代理对分半
 *    各自成 lone surrogate，JS 字符串拼接时自然复合）；
 *  - 输出根本不含 "reply" 字符串（模型跑飞）→ 一个 token 都不流，上层走全量解析兜底。
 *
 * @param {(textPiece: string) => void} onReplyToken 已反转义的正文增量回调
 */
function createReplyStreamExtractor(onReplyToken) {
  if (typeof onReplyToken !== 'function') throw new Error('createReplyStreamExtractor 需要 onReplyToken 函数');
  const PHASE_SEEK_KEY = 0;   // 找 "reply" 键
  const PHASE_COLON = 1;      // 键后找冒号
  const PHASE_OPEN = 2;       // 冒号后找开引号
  const PHASE_BODY = 3;       // 字符串体内，边扫边反转义
  const PHASE_END = 4;        // 闭引号已见，reply 完整
  const UNESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
  let phase = PHASE_SEEK_KEY;
  let buf = '';
  let esc = false;   // 已见反斜杠，等待转义字符
  let hex = null;    // \uXXXX 的 hex 累计（null = 不在 \u 转义中）
  return {
    /** reply 是否已完整流出（之后可不再 feed） */
    get done() { return phase === PHASE_END; },
    feed(chunk) {
      if (phase === PHASE_END || !chunk) return;
      buf += chunk;
      let out = '';
      let i = 0;
      while (i < buf.length) {
        const c = buf[i];
        if (phase === PHASE_SEEK_KEY) {
          const idx = buf.indexOf('"reply"', i);
          if (idx === -1) {
            // 保留末尾 7 字符（"reply" 可能被 chunk 边界切断），其余可丢弃
            i = Math.max(i, buf.length - 7);
            break;
          }
          i = idx + 7;
          phase = PHASE_COLON;
          continue;
        }
        if (phase === PHASE_COLON) {
          if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
          if (c === ':') { i++; phase = PHASE_OPEN; continue; }
          // "reply" 只是正文里被引用的字样，不是键 → 从当前位置继续找下一个
          phase = PHASE_SEEK_KEY;
          continue;
        }
        if (phase === PHASE_OPEN) {
          if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
          if (c === '"') { i++; phase = PHASE_BODY; continue; }
          // reply 不是字符串（异常输出）→ 放弃流式，交给上层全量解析
          phase = PHASE_SEEK_KEY;
          continue;
        }
        // PHASE_BODY：字符串体内，按 JSON 转义语义反转义后增量抛出
        if (esc) {
          if (hex !== null) {
            hex += c; i++;
            if (hex.length >= 4) {
              const code = parseInt(hex, 16);
              out += Number.isNaN(code) ? '' : String.fromCharCode(code);
              hex = null; esc = false;
            }
            continue;
          }
          if (c === 'u') { hex = ''; i++; continue; }
          out += Object.prototype.hasOwnProperty.call(UNESC, c) ? UNESC[c] : c;
          esc = false; i++;
          continue;
        }
        if (c === '\\') { esc = true; i++; continue; }
        if (c === '"') { phase = PHASE_END; i++; break; }
        out += c; i++;
      }
      buf = buf.slice(i);
      if (out) onReplyToken(out);
    }
  };
}

module.exports = {
  LLMClient,
  buildCoachContext,
  buildCoachMessages,
  COACH_SYSTEM_PROMPT,
  MAX_HISTORY_MESSAGES,
  createReplyStreamExtractor
};
