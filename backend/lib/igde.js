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
// Wave 5：I5 批次状态汇报（campaigns 单处口径）+ E1 冲动折扣拦截（impulse 单处口径）
const campaignsMod = require('./campaigns');
const impulse = require('./impulse');

// 槽位优先级即数组顺序：B4 选问 audience > reason > offer > goal
const NEEDED_FIELDS = SLOTS;
const FIELD_LABEL = { audience: '针对谁', reason: '为什么挽回', goal: '要什么结果', offer: '给什么钩子' };
const MAX_CORRECTIONS = 40;
const MAX_CONFLICTS = 4;

// 修正语气词（B2 冲突检测）：出现 → 新值视为明确纠正；不出现且与现值不同 → 冲突候选
const CORRECTION_TONE_RE = /(不是|不对|改成|改为|纠正|更新|换成|之前说错|改主意|应该是|说错|还是|rather|instead|actually|correction)/i;
// 注意：「其实」不进修正语气表——PRD 剧本 #4 明确「其实主要是年轻人」类表述是冲突澄清（追问一次），
// 不是静默覆盖；「其实」入表会让 demographic 冲突永远绕过 C6（真模型矩阵 m10 实测）。

// B2.3 同义重申豁免 · 词表（2026-10-03 裁决③「语义同义走词表判定」）：同组内互为同义，
// 命中按同值处理（不追问、不重复计数）。PRD 样例：「忘了付款」≈「忘记结账」。
// 只收同一口径的不同叫法；加购未付 ≠ 下单未付（剧本 #17 两批分立）、比价 ≠ 犹豫（话术方向不同），绝不并组。
const SEMANTIC_SAME_GROUPS = [
  // reason：忘记结账族（chips 选项「忘记结账」与口语「忘了付款/没来得及付」互为同义）
  ['忘记结账', '忘了结账', '忘记付款', '忘了付款', '忘记付', '忘了付', '没来得及结账', '没来得及付款', '忘记下单', '忘了下单'],
  // audience：老客唤醒族
  ['沉睡 / 流失老客', '沉睡老客', '很久没来的老客', '很久没来的客户', '老客户', '流失老客', '老客'],
  // audience：加购未付族
  ['加购未付客户', '加购没付客户', '加购未付款', '加购了没付款', '加购没付款'],
  // audience：下单弃付族
  ['弃购 / 下单未付客户', '弃购未付', '弃购', '下单未付', '下单没付'],
  // audience：浏览未买族
  ['浏览未买客户', '浏览没买', '浏览未下单', '逛了没买', '看了没买'],
  // goal：跑通流程族（chips 选项「跑通流程」与口语「先试发一封/先跑起来」互为同义——
  // 10-05 GUI 实测「先试发一封」被当新目标追问 → 原样重问循环）
  ['先跑通流程', '跑通流程', '先跑起来', '先试发一封', '试发一封', '先发一封'],
];

// —— Wave 4 F2 算账意图（对话内问「这批人值多少钱 / 值不值」→ 确定性算账，与账本同口径）——
const LEDGER_RE = /(值多少|值不值|划不划算|能赚多少|赚多少|能回多少|值几个钱|算.{0,4}账)/i;
// —— Wave 4 A3 复用意图（新会话首条消息「照上次的来」→ prefs 预填）/ 否认复用（清预填）——
const REUSE_RE = /(照上次的?来?|跟(上次|上回)一样|和(上次|上回)一样|上个月那套|上次那套|按上次的?|照旧)/i;
const REUSE_DENY_RE = /(别用|不用|不要用|别照|不照|别按|不按|别跟|不跟|别拿|不拿|不是照|不是跟|不是|没照|没跟|不对，?不是).{0,3}(上次|上回|上个月|那套)/i;

// —— F1 出口意图（2026-10-03 重写）：「好，帮我写一封」→ 缺槽 C6 推断补满 → D1（不给缺槽直出邮件开口）。
//    整句锚定：带业务内容的「帮我写一封…挽回邮件」不算出口意图，走正常采集。——
const WRITE_INTENT_RE = /^(?:好[，,]?)?(?:帮我写一封|直接写一封|开始写吧|就按这些写吧)[。.！!～~\s]*$/;

// —— 防呆与强制终止循环（2026-10-05）：S1 采集期触发任一条件 → 不再追问，缺槽按常见打法
//    推断补满（全 inferred，卡上「我推断的，可改」）→ 强制弹确认卡：
//    ① 触发不耐烦关键词（「别问了/直接生成/就这样吧…」——PRD：用户说别问了必须停止追问）
//    ② S1 轮数超限（S1_TURN_LIMIT，防无限采集）
//    ③ 循环熔断 ≥2 次（ _forceBreakLoop 计数，防兜底话术也兜不住的顽固循环） ——
const IMPATIENCE_RE = /(别问了|不用问了|别啰嗦|直接生成|直接出方案|直接配一?封|直接给我出|赶紧(的|生成|发|配)|快点(的|生成|发|配)|别磨叽|确认吧|就这样(吧|定)|先这样吧)/;
const S1_TURN_LIMIT = 12;
const LOOP_BREAK_LIMIT = 2;

// —— F5 功能导览流（2026-10-03 新增 · P1 · 独立旁路）：全程不写槽、不动 needs、不推进 stage、
//    不触发 E5 离题判定；商家中途输入业务内容 → 导览立即让路（pending_tour 下一轮即清）。——
//    触发收紧：「介绍…功能」必须带「其他/其它」（PRD 触发语「介绍一下其他功能」），
//    防「介绍一下产品功能」类业务句被劫持进导览。
const TOUR_TRIGGER_RE = /(介绍|看看|讲讲|了解).{0,6}(其他|其它).{0,2}功能|功能介绍|有什么功能|都有(什么|哪些)功能|能做(什么|哪些)/i;
// 菜单与左侧导航同源（助手除外）；PRD 口径：与左侧导航同源（406-2671 第 5 项「订单」与 616-7875「设置」两帧不一致，以导航为准）
const TOUR_MENU = ['邮件配置', '数据看板', '用户', '竞品', '设置'];
// 讲解话术 = 设计稿定稿逐字收录（句子不改，标点随排版微调）；blocked 段依赖另立更新项
//（邮件页：发送策略编辑 / 按条件检索；看板页：报告检索与行动建议）——能力落地前对应气泡不播放。
const TOUR_SCRIPTS = {
  '邮件配置': {
    lines: [
      '点击左侧邮件tab查看所有生成的历史邮件。',
      '生成邮件预览后会出现对应的详情卡片，点击底部按钮选择你想进行的操作。',
    ],
    blocked: [
      '预览和编辑功能支持编辑文本内容和样式，调整图片提示词，以及调整发送策略。',
      '也可以直接询问我来查找特定的邮件。',
      '我会提供相应的邮件清单并协助您进行相关的查找和发送等操作。',
    ],
    exampleChips: [], // 检索能力落地后随「也可以直接询问我…」段挂示例问句 chips
  },
  '数据看板': {
    lines: [
      '点击左侧数据看板来查看过往邮件获单效果的数据统计。',
      '优先关注这一行，初步判断近期邮件获单效果。',
      '转化漏斗哪一栏的百分比掉得最多，就优先优化哪一环。',
      '回流GMV，这个量化投放指标。',
    ],
    blocked: [
      '也可以直接询问我来查找特定的报告，或是下一步的行动建议。',
    ],
    exampleChips: [], // 报告检索落地前该气泡不播放（示例问句 chips 不可点，随段挂起）
  },
};


// —— Wave 5 I5 批次状态汇报意图（「现在都在跑啥」「几个批次怎么样了」「批次状态」）——
const BATCH_STATUS_RE = /(现在都在跑啥|都在跑啥|在跑啥|批次状态|批次怎么样|几个批次|批次都怎么样|批次情况|汇报一下批次|批次汇报)/i;
// —— Wave 5 E4 对话内语种越权（#12）：要求把邮件正文/主题写成指定语种 → 拒绝 + 解释语种跟随收件人 ——
const LOCALE_FORCE_RE = /((邮件|正文|内容|文案|标题|主题行?|信)[^。；;？?！!]{0,16}?(直接用|用|改成|换成|写成|翻译成|以)\s*(中文|英文|英语|法语|德语|西班牙语|日语|韩语|意大利语|俄语|葡萄牙语)(写|发|来写)?)|((直接用|就用|用)(中文|英文|英语|法语|德语|西班牙语|日语|韩语)(写|发|给))/;

// —— D 类（私人生活/无关话题）重定向池：引擎级双保险的话术口径（与 lib/llm.js COACH_SYSTEM_PROMPT D 类一致）——
// 首句先「接住」用户刚说的（哪怕只是"哈哈这个我帮不上~"），再拉回邮件营销主业；不追问字段、不复读同一句。
const D_REDIRECT_POOL = [
  '哈哈这个我帮不上～我是专门做邮件营销的，你要是想挽回流失客人、发封挽回邮件，我随时在。',
  '这个咱就不聊啦，我主攻邮件营销挽回。你那拨想捞回来的客人，咱接着聊？',
  '这块我接不住哈，我的专长是帮你发挽回邮件。想聊聊弃购挽回不？'
];

// —— 兜底池（替代旧 SAFE_TEMPLATE 复读机）：均符合"接住 + 拉回主业"口径，轮换 + 去重避免连续相同 ——
// 注意：这些是「完整句」兜底（内嵌问受众的问句），只用于无 chips 的场景；
// 护栏替换主回复的场合一律改用 FALLBACK_CATCH_POOL + _fallbackWithProbe（问句按 B4 缺口生成，与 chips 同源）。
const FALLBACK_POOL = [
  '我这边可能卡了一下，不过你刚说的我接住了。咱接着聊邮件挽回——你最想先捞哪拨客人？',
  '刚才有点断片，但咱别跑偏。想挽回哪拨客人、为啥、希望他们回来干啥，你挑一个说？',
  '我这边没接稳，你刚说的我记着。回到正题：弃购没付的、还是好久没来的老客，你想先聊哪拨？'
];

// —— 护栏替换兜底的「接住语」池（无问句；问句由 _fallbackWithProbe 按当前缺口单点追加）——
// 09-30 报告 P1-3：护栏把主回复换成 FALLBACK_POOL 后，问句恒为「问受众」且与 B4 chips 错位。
const FALLBACK_CATCH_POOL = [
  '我这边可能卡了一下，不过你刚说的我接住了。',
  '刚才有点断片，但你的意思我记着，咱继续。',
  '这轮我没接稳，重来——'
];

// —— S2 满卡待确认期的闲聊/不识别输入专用池（10-05 截图循环连带修复）：原非确认输入轮换到
//    FALLBACK_POOL 完整句——内嵌罐头接住语（「卡了一下」）且重问已填满的受众。满卡态既不追问
//    也不该装掉线，一律引向确认卡/自由改。NO_CARD 变体：降级轮确认卡尚未产出（剧本 #13），
//    话术不得引用不存在的卡（10-05 用户实测反馈）。 ——
const S2_IDLE_POOL = [
  '方案四样都在下面确认卡里了，想改哪样直接说，没问题就点确认。',
  '你在下面的确认卡上核对就行——哪样不对点哪样改，想补细节（比如发送时段）也可以直接打字。',
  '配置都在下面确认卡里。要调哪里说一声，都 OK 就点确认。'
];
const S2_IDLE_POOL_NO_CARD = [
  '四样我都记齐了，想改哪样直接打字说，改完等我这边恢复稳了就给你出确认卡。',
  '这几样先记着——要调整直接说改哪样；确认卡等我恢复稳了摆出来，你过目点确认就行。',
  '先这样记下了。想补细节（比如发送时段）或改哪样，直接打字说就行。'
];

// —— 业务关键词（邮件营销/店铺生意），命中即非离题（D 类/离题判断的排除项，统一复用）——
// Wave 3：批次域动作词（批次/停发/全停/暂停/恢复/重发）也是业务词 —— 运维话术不得被离题路由劫持
// Wave 4：算账问句 / 复用意图（F2/A3）同为业务词，桩模式下不得被离题兜底吞掉
// Wave 5：I5 批次状态问句（都在跑啥/批次状态/几个批次）同上
// P0-N3（复测 10-03）：引擎自家词表（SLOT_CHIPS/CONFLICT_CHIPS 全部选项）必须在白名单里——
// 商家点自己刚拿到的 chip（挽回订单/具体金额/忘记结账/免邮/小赠品/我自己定…）被 _offTopicWeak
// 判成离题拒答（「挽回」二字都不在表内），降级窗口期主链当场卡死。年龄段短答（25-34）一并放行。
const BIZ_RE = /(店铺|网店|开店|店|生意|电商|卖货|卖东西|客户|邮件|营销|弃购|转化|下单|加购|购物车|浏览|老客|老顾客|会员|vip|优惠|折扣|包邮|限时|复购|回流|唤醒|沉睡|流失|挽回|订单|金额|目标|结账|价格|对比|免邮|赠品|跑通|我来说|我自己定|钩子|客群|gmv|销量|库存|发货|物流|退款|售后|批次|停发|全停|暂停|恢复|重发|值多少|值不值|划不划算|能赚|能回多少|算账|照上次|跟上次|和上次|上个月那套|上次那套|按上次|照旧|都在跑啥|在跑啥|批次状态|几个批次|批次怎么样|\d{1,3}\s*[-~到至]\s*\d{1,3})/i;

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
  // 人群画像兜底（PRD C1 同义触发词：人群词+年龄段）：「25-40 岁的美国女性」类原话截取入槽——
  // 在线模型漏交 slot_update 时的词表护栏（真模型 GUI 联调实测模型偶发漏交）
  else if (/\d{1,3}\s*[-~到至]\s*\d{1,3}\s*岁/.test(tAud) && /女|男|人|客|妈/.test(tAud)) {
    const dm = tAud.match(/[\d一二两三]{1,3}\s*[-~到至]\s*[\d一二两三]{1,3}\s*岁[^，。；！？、]*/);
    if (dm) out.audience = dm[0].trim();
  }
  // reason（中英文双匹配；旧 pain 槽）
  if (!out.reason) {
    // 「忘记结账/忘了付款」是 reason 选项的用户原话（chips 文案/口语）：按原话采集并从文本消费，
    // 防止残词「结账」再误触发 goal 罐头、「忘了」落入「太久没动静」罐头（真模型 GUI/30 轮实测）
    const forgotM = t.match(/忘(?:了|记)?(?:结账|付款)/);
    if (forgotM) { out.reason = forgotM[0]; t = t.replace(forgotM[0], ' '); }
    else if (/太久|很久|好久|不活跃|没动静|沉默|忘了|忘记|没人管|被忽略/.test(t)) out.reason = '太久没动静、快被遗忘';
    else if (/竞品|别家|对手|别人家|别的牌子|其他牌子|别的品牌|competitor|rival/i.test(t)) out.reason = '可能被竞品勾走';
    else if (/运费太贵|运费贵|运费高|运费偏贵|shipping.*(expensive|cost|price)|too expensive|high? cost/i.test(t)) out.reason = '嫌运费贵、临门犹豫';
    else if (/贵|价格|预算|划算|expensive|price|cost|budget/i.test(t)) out.reason = '觉得贵、犹豫价格';
    else if (/犹豫|纠结|再想想|考虑|hesitat|unsure|thinking/i.test(t)) out.reason = '还在犹豫';
  }
  // goal（中英文双匹配）。PRD C4：禁止罐头默认值、宁缺不编——裸动词「付款/结账/结算」
  // 撤出匹配（GUI 联调 Bug-1：chip 文案「忘记结账」的「结账」曾把用户没说的 goal 填成罐头），
  // 只认完成式意图语境；降级路径抓不到就留空等 B4 追问
  // P0-N3/G-6（复测 10-03）：降级轮也要能接住可验收目标——「本月挽回 100 单」「挽回 500 美金」
  // 原话截取入槽（带数值 = 可验收）；裸 chip「挽回订单」不含数值，留空等 B4 追问具体值。
  // 两个正则分开跑、挽回锚定优先：合并 alternation 会让左扫描先命中「目标是…」分支，前缀剥离吃掉动词
  const goalRecoverM = t.match(/挽回[^。；;！!?？,，]{0,8}?\d+\s*(?:单|美金|美元|元)/);
  const goalTargetM = goalRecoverM ? null : t.match(/(?:目标|希望|想要|结果)[^。；;！!?？,，]{0,10}?\d+\s*(?:单|美金|美元|元)/);
  if (goalRecoverM) out.goal = goalRecoverM[0];
  else if (goalTargetM) out.goal = goalTargetM[0].replace(/^(?:目标|希望|想要|结果)(?:是|就是|就|要|想)?/, '').trim();
  else if (/完成付款|完成下单|complete\s+the\s+purchase|complete.*payment|checkout|pay\s+(for|the)/i.test(t)) out.goal = '促使完成付款 / 结账';
  // 「先试发一封/先跑起来」= 跑通流程族口语（10-05 截图循环：被当无效回答原样重问）；
  // 「发一封」裸词不收（「帮我写一封/发一封」是写意图不是目标）
  else if (/跑通|试发|先发一封|发一封试试|先跑起来/.test(t)) out.goal = '先跑通流程';
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
    // 一句双改难题（10-05 PRD 矩阵）：「10% off，不对，还是 15% off」——句中带改口词时取最后一个百分比
    const pcts = t.match(/\d+\s*%/g) || [];
    const m = (pcts.length > 1 && /(不对|还是|改成|换成|换|改为)/.test(t)) ? t.match(/(\d+)\s*%(?!.*\d+\s*%)/) : t.match(/(\d+)\s*%/);
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
  // 重发（频次护栏确认流）；Wave 5 I5：「换主题行再打」是低打开率建议的承接动作（同 resend 语义）
  if (/再打一轮|重发|再发一轮|没打开的再|换主题行再打/.test(t)) {
    return { kind: 'resend', target: extractOpsTarget(t), subject: (t.match(/主题[行为]?\s*[「『]([^」』]+)[」』]/) || [])[1] || '' };
  }
  // 单批折扣：「改成 15%」
  const dm = t.match(/(?:改成|改为|换成|调整为?)\s*(\d{1,2}(?:\.\d+)?)\s*%/);
  if (dm) return { kind: 'op', op: 'discount', target: extractOpsTarget(t), params: { percent_off: +dm[1] } };
  // 单批暂停/恢复
  if (/暂停/.test(t)) return { kind: 'op', op: 'pause', target: extractOpsTarget(t) };
  if (/恢复/.test(t)) return { kind: 'op', op: 'resume', target: extractOpsTarget(t) };
  // 建批（I1）：≥2 批的明确说法
  if (/两个批次|两批|分别建批|分别做(成)?(两|2|一|1|三|3)?批|拆(成)?(两|2)批|建两个|三个批次|三批|几批|多个批次/.test(t)) {
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
    [/老客|沉睡|流失/, '老客'],
    [/新客|新用户|新人/, '新客']
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

  /** 缺失字段的引导问句（教练式：问多于说、极简）。
   *  话术口径 = PRD C1–C4 定稿（2026-09-30）：选项由 SLOT_CHIPS 下发、不写进问句；
   *  C1/C3 的「有店铺数据 / 有历史数据」变体由 opening() 数据式开场与 F2 历史建议承载。 */
  probeFor(field) {
    const map = {
      audience: '这批信你想先召回谁？说个大概就行，比如「上个月加购没付的」。',
      reason: '你认为顾客流失的原因是哪一个？',
      goal: '你希望拿到什么结果？挽回多少单、多少金额，还是先跑通流程？',
      offer: '这封给客人什么钩子？'
    };
    return map[field];
  }

  s0Open() {
    return '请按照引导填充品牌基础信息，完成初始设置。';
  }

  /** 会话创建时一次性下发 S0 开场白（不推进阶段）。
   *  Wave 4 F1 零配置开场 · 2026-10-03 重写（更新摘要「初始引导对话流化」+ 剧本 #23）：
   *  - 首条气泡 = 欢迎语（仅首次：hasAnyAct=false，欢迎语一生只在首次出现）
   *    + 数据开场句（已连接有数据时数据先于提问）或无数据一句话开场
   *    + 「我还需要的信息」清单（缺失四槽、价值化话术、无进度数字；extras 可选项以附注呈现）
   *    + 「需要现在就编写邮件吗？」出口；
   *  - 出口 chips 3 项：好，帮我写一封 / 介绍一下其他功能 / 其他需求（自由输入出口）。
   *    「好，帮我写一封」→ C6 推断补满 → D1（_writeIntentTurn 承接，不给缺槽直出邮件开口）；
   *    「介绍一下其他功能」→ F5 功能导览（独立旁路）。
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
    if (hasData) {
      if (banner.store_name) parts.push(`已连接${banner.store_name}。`);
      if (count > 0) {
        const fmt = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
        parts.push(`本周${count}个加购未付（客单${cur}${fmt(aov)}，弃购总额${cur}${fmt(total)}）。`);
      }
    } else {
      // 无店铺数据：开场改问一句话（不弹表单、不硬编数据），清单照常
      parts.push('这批信你想先召回谁？说个大概就行，比如「上个月加购没付的」。');
    }
    // 「我还需要的信息」清单：缺失四槽按 B4 价值优先级排列，价值化话术、只列文字状态（无进度数字）
    parts.push('我还需要的信息：');
    parts.push('· 发给谁——想召回哪拨客人');
    parts.push('· 为什么流失——顾客卡在了哪一步');
    parts.push('· 给什么钩子——折扣、免邮还是小赠品');
    parts.push('· 想拿到什么结果——挽回多少单，还是先跑通流程');
    parts.push('（发送时段、产品特色这些想说也可以说——可选，能提升回流率。）');
    parts.push('需要现在就编写邮件吗？');
    const chips = ['好，帮我写一封', '介绍一下其他功能', '其他需求'];
    return { reply: parts.join('\n'), stage: 'S0', chips, welcome: !opts.hasAnyAct };
  }

  /** 防呆强制确认卡（2026-10-05）：缺槽推断补满（复用出口意图的 C6 补满）→ 进 S2。
   *  reason 仅用于话术分型；与 WRITE_INTENT 共用补满口径（0 编造数值，全 inferred 可改）。
   *  卡感知（10-05 用户实测）：卡在本函数内产出——能出卡（aiEnabled 档位）才用「确认卡核对」话术；
   *  出不了卡（无 key 桩引擎，剧本 #13）改用诚实的无卡话术，绝不引用不存在的卡。返回 { reply, card }。 */
  _forceConfirmTurn(act, opts = {}, reason = 'impatient') {
    const now = Date.now();
    act.memory = ensureMemory(act.memory, now);
    const banner = (opts.storeBanner && typeof opts.storeBanner === 'object') ? opts.storeBanner : null;
    const count = Math.max(0, Number(banner && banner.weekly_abandoned_count) || 0);
    const put = (slot, value) => {
      if (!value || act.needs[slot]) return;
      act.needs[slot] = { value: clampNeedValue(value), source: 'inferred', at: now };
    };
    put('audience', count > 0 ? `加购未付客户（约 ${count} 人）` : '加购未付客户');
    put('reason', '忘记结账');
    put('offer', '待定');
    put('goal', '先跑通流程');
    this._advanceStage(act, '');
    let card = null;
    if (this.aiEnabled && opts.previewAvailable !== false && act.stage === 'S2' && this.missingFields(act).length === 0) {
      card = this.producePlanCard(act, { locale: opts.locale, code: null });
    }
    const lines = card ? {
      impatient: '好，不磨叽了——缺的几样我按常见打法先补上（都是我推断的，可改），你直接在下面的确认卡里核对、改完点确认。',
      overflow: '咱聊了不少轮啦，剩下几样我先按常见打法补齐（推断的，可改），你直接在确认卡上核对，哪样不对点哪样改。',
      loop: '咱俩想法对上了，就是说法绕了点——缺的我先补齐（推断的，可改），你看下面的确认卡，不行在上面改。',
      stalled: '行，具体数不急着定——先按「先跑通流程」跑起来也行。缺的我先补齐（推断的，可改），你在下面的确认卡上核对，哪样不对点哪样改。'
    } : {
      impatient: '好，不磨叽了——缺的几样我按常见打法先补上（都是我推断的，可改），哪样不对直接跟我说；等我恢复稳了就把确认卡给你摆出来。',
      overflow: '咱聊了不少轮啦，剩下几样我先按常见打法补齐（推断的，可改），哪样不对直接说；确认卡等我恢复稳了摆出来。',
      loop: '咱俩想法对上了，就是说法绕了点——缺的我先补齐（推断的，可改），哪样要改直接说；等我恢复稳了就给你出确认卡。',
      stalled: '行，具体数不急着定——先按「先跑通流程」跑起来也行。缺的我先补齐（推断的，可改），哪样不对直接说；确认卡等我恢复稳了摆出来。'
    };
    return { reply: lines[reason] || lines.impatient, card };
  }

  /** F5 功能导览（独立旁路，2026-10-03 新增 P1 可裁）。
   *  返回 null = 本轮无导览语义（含让路：pending_tour 挂起但输入非菜单项 → 清挂起、回正常流水线）。
   *  剧本 #22：菜单 chips ≤5 且与导航同源；讲解含操作路径；needs / stage / 清单零变化；
   *  被依赖标注挡住的话术段（发送策略 / 检索能力未落地）不出现在导览序列里。 */
  _tourTurn(act, userText) {
    const t = String(userText || '').trim();
    if (TOUR_TRIGGER_RE.test(t)) {
      act.pending_tour = true;
      return { reply: '你需要了解哪个功能？', chips: TOUR_MENU.slice() };
    }
    // ① 菜单挂起轮：命中菜单项 → 讲解；否则让路
    if (act.pending_tour) {
      act.pending_tour = null;
      const picked = TOUR_MENU.find(m => t === m || t.replace(/[的吗呢吧。.！!？?\s]+$/g, '') === m);
      if (!picked) return null; // 业务内容 → 导览立即让路
      const script = TOUR_SCRIPTS[picked];
      const lines = script ? [...script.lines] : [];
      const reply = lines.length
        ? `${picked}是这样用的：\n${lines.map(l => `· ${l}`).join('\n')}`
        : `${picked}在左侧导航里，点开就能用。`;
      return { reply, chips: (script && script.exampleChips) || [] };
    }
    return null;
  }

  /** F1 出口意图「好，帮我写一封」（2026-10-03 重写）：缺槽 C6 推断补满 → 进 S2 出确认卡。
   *  推断口径（全部标 inferred，卡上「我推断的，可改」；绝不编造数值目标）：
   *  audience=店铺加购未付（有数据带人数）/ prefs / 加购未付客户；reason=忘记结账（行业最常见）；
   *  offer=待定（C3：无数值不编默认值）；goal=先跑通流程（C4 合法非数值目标）。 */
  _writeIntentTurn(act, opts = {}) {
    const now = Date.now();
    act.memory = ensureMemory(act.memory, now);
    const banner = (opts.storeBanner && typeof opts.storeBanner === 'object') ? opts.storeBanner : null;
    const count = Math.max(0, Number(banner && banner.weekly_abandoned_count) || 0);
    const put = (slot, value) => {
      if (!value || act.needs[slot]) return;
      act.needs[slot] = { value: clampNeedValue(value), source: 'inferred', at: now };
    };
    put('audience', count > 0 ? `加购未付客户（约 ${count} 人）` : '加购未付客户');
    put('reason', '忘记结账');
    put('offer', '待定');
    put('goal', '先跑通流程');
    this._advanceStage(act, '');
    return {
      reply: '好，缺的几样我先按常见打法补上——都是我推断的，哪样不对在下面的确认卡里直接改，改完再确认。',
      chips: []
    };
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

  /** 字段追问示例（第 4 次仍未采集到时给例子引导，避免无限复读）。口径 = PRD C1–C4 定稿（2026-09-30） */
  _probeExample(field) {
    const map = {
      audience: '加购没付款的、浏览没买的、还是很久没来的老客',
      reason: '忘了结账、被别家勾走、还是单纯没需求',
      goal: '挽回多少单、多少金额，还是先跑通流程',
      offer: '9 折、满减、还是免邮'
    };
    return map[field] || '加购未付的客户';
  }

  /** 复读/同值判定（B2.3 豁免硬规则①②）：去空白/标点/虚词（的/了/是/吧…）/区间连词（到/至）后
   *  全文相等，或一方（≥12 字符）被另一方完整包含——12 字守卫防「10% off ⊂ 110% off」类数字包含误豁免。 */
  _similarEnough(a, b) {
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/[\s\p{P}\p{S}]+|[的了吗呢吧啊嘛哦呀哈是]|那批人|这批人|那拨人|这拨人|那批|这批|那拨|这拨|的客户|的客人|的人群|客户|客人|顾客|人群|为主|到|至/gu, '');
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y));
  }

  /** B2.3 同义重申豁免 · 词表判定（2026-10-03 裁决）：同组内互为同义 → 按同值处理
   *  （不追问、不重复计数、不复述为新信息、不产冲突候选）。
   *  只收明显同义组，拿不准的不收——宁可真冲突当面核实，不静默吞掉真改口。 */
  _sameSemantic(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (!x.trim() || !y.trim()) return false;
    for (const g of SEMANTIC_SAME_GROUPS) {
      if (g.some(w => x.includes(w)) && g.some(w => y.includes(w))) return true;
    }
    return false;
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

  /** B4 决策（B2 合并后调用）：真冲突澄清优先于一切——S1 常规追问、S2 引导确认都让位。
   *  C6.5（2026-10-03 裁决）：S2 全满态真冲突的澄清优先于引导确认（澄清是核验不是采集）；
   *  误伤源（同义重申）已在 B2 豁免，能到这里的是真冲突——原「S2 不挂冲突」的回退门就此重启。 */
  _decideQuestion(act, turnResult) {
    const newConflict = (turnResult.conflictsNew || [])[0];
    if (newConflict) {
      return { slot: newConflict.slot, chips: conflictChips(newConflict.slot), kind: 'conflict' };
    }
    const miss = this.missingFields(act);
    if (!miss.length) return { slot: null, chips: [], kind: 'none' };
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
    if (act.flow_version === 6) return require('./conversation-v6').handle(this, act, userText, opts);
    const guardrailHits = [];
    act.needs = migrateNeeds(act.needs);
    act.messages = act.messages || [];
    act.memory = normalizeMemory(act.memory || createEmptyMemory());
    act.summary_cursor = Number(act.summary_cursor) || 0;
    act.context_version = Number(act.context_version) || 1;
    // 防呆计数：S1 采集期每轮 +1（超阈值触发强制确认卡）
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

    // —— F5 功能导览（独立旁路 · 2026-10-03 新增 P1）：菜单轮 pending_tour 挂起，下一轮
    //    命中菜单项 → 讲解；输入任何业务内容 → 立即让路（清 pending_tour 回正常流水线）。
    //    全程不写槽、不动 needs、不推进 stage、不触发 E5 离题判定；话术为设计稿定稿，不进护栏改写。
    //    engine 按配置档位上报（短轮未调模型，徽标不得因此谎报降级）——
    if (act.pending_tour || TOUR_TRIGGER_RE.test(String(userText || '').trim())) {
      const tourTurn = this._tourTurn(act, userText);
      if (tourTurn) {
        act.messages.push({ role: 'user', content: userText, ts: nowMs });
        act.messages.push({ role: 'assistant', content: tourTurn.reply, ts: nowMs });
        act.updated_at = nowMs;
        await doPersist();
        return {
          reply: tourTurn.reply, stage: act.stage, needs: act.needs, planCard: null,
          guardrailHits: [], engine: this._engineOf(this.aiEnabled),
          chips: tourTurn.chips, askedSlot: null, agentMeta: this._agentMeta(runtime)
        };
      }
    }

    // 只统计采集轮；导览不会耗尽防呆预算。
    if (act.stage === 'S1') act.memory.s1_turns = (Number(act.memory.s1_turns) || 0) + 1;
    const forceReason = act.stage === 'S1' && this.missingFields(act).length > 0
      ? (IMPATIENCE_RE.test(String(userText || '')) ? 'impatient'
        : act.memory.s1_turns >= S1_TURN_LIMIT ? 'overflow'
          : act.memory.loop_breaks >= LOOP_BREAK_LIMIT ? 'loop' : null)
      : null;
    const writeIntent = WRITE_INTENT_RE.test(String(userText || '').trim());

    // —— F1 出口意图「好，帮我写一封」：缺槽 C6 推断补满（推断项卡上标「我推断的，可改」）
    //     → D1 确认卡（不给「缺槽直出邮件」开口）；四槽已齐则交回正常 S2 流程。——
    if (writeIntent && this.missingFields(act).length > 0 && !act.memory.conflicts.length && !act.pending_ops?.e1) {
      const writeTurn = this._writeIntentTurn(act, opts);
      act.messages.push({ role: 'user', content: userText, ts: nowMs });
      act.messages.push({ role: 'assistant', content: writeTurn.reply, ts: nowMs });
      act.updated_at = nowMs;
      // F1 处理逻辑 4：推断补满 → D1 确认卡——在线档位产出 S2 无码预览卡（确认卡数据源，
      // 推断项带「我推断的，可改」）；降级档位不出卡（剧本 #13，S2 停住明示方案生成暂停）
      // 卡感知（10-05）：出不了卡时话术不得引用「确认卡」（用户实测反馈：降级话术撒谎）
      let writePlanCard = null;
      if (this.aiEnabled && act.stage === 'S2' && this.missingFields(act).length === 0) {
        writePlanCard = this.producePlanCard(act, { locale: opts.locale, code: null });
      }
      let writeReply = writeTurn.reply;
      if (!writePlanCard && /确认卡/.test(writeReply)) {
        writeReply = writeReply.replace(/哪样不对在下面的确认卡里直接改，改完再确认。?/, '哪样不对直接跟我说；等我恢复稳了就把确认卡给你摆出来。');
      }
      await doPersist();
      return {
        reply: writeReply, stage: act.stage, needs: act.needs, planCard: writePlanCard,
        guardrailHits: [], engine: this._engineOf(this.aiEnabled),
        chips: writeTurn.chips, askedSlot: null, agentMeta: this._agentMeta(runtime)
      };
    }

    // —— goal 槽自家 chips / 口标应答（2026-10-05 截图循环根治）：引擎下发的 goal chips 里
    //    「挽回订单/具体金额」按 C4 是待具体化的类目（无数值不入槽），但点它绝不能换来原样重问——
    //    首点 → 收窄成数值追问；再点（停滞）→ 防呆强制确认卡。「跑通流程」是 C4 合法非数值目标，
    //    口语变体（先试发一封/先跑起来）直接入槽收口；「我自己定」引导自由输入。
    //    仅在 goal 是当前追问目标（B4 探问指向 goal，即 chips 正挂着 goal 项）时触发——
    //    采集早期聊别的槽时说「跑起来」不该被误吞成目标。 ——
    if (act.stage === 'S1' && !act.memory.conflicts.length && this.missingFields(act).includes('goal') && this._nextProbeSlot(act) === 'goal') {
      const raw = String(userText || '').trim();
      const tRun = /^(?:先跑通流程|跑通流程|先跑起来|跑起来|先试发一封|试发一封|先发一封(?:试试|看看)?|发一封试试)[。.！!～~\s]*$/.test(raw);
      const tBare = /^(?:挽回订单|具体金额)[。.！!～~\s]*$/.test(raw);
      const tSelf = /^(?:我自己定|我自己来定|我来说|我来说目标)[。.！!～~\s]*$/.test(raw);
      if (tRun || tBare || tSelf) {
        act.memory = ensureMemory(act.memory, nowMs);
        // 顺序硬约束（B3「先落库后回复」的镜像：先记账后落库）：earlyReturn 先把本轮
        // user/assistant 消息 push 进 act，再 doPersist 序列化——SSE done 帧的 act 才带得上
        // 本轮两条消息（10-05 GUI 全功能测试抓到：先 persist 后 push → 前端丢本轮气泡）。
        const earlyReturn = (replyText, chipsOut, cardOut) => {
          act.messages.push({ role: 'user', content: userText, ts: nowMs });
          act.messages.push({ role: 'assistant', content: replyText, ts: nowMs });
          act.updated_at = nowMs;
          return { reply: replyText, stage: act.stage, needs: act.needs, planCard: cardOut || null, guardrailHits: [], engine: this._engineOf(this.aiEnabled), chips: chipsOut || [], askedSlot: null, agentMeta: this._agentMeta(runtime) };
        };
        if (tRun) {
          act.needs.goal = { value: clampNeedValue('先跑通流程'), source: 'explicit', at: nowMs };
          this._advanceStage(act, '');
          const miss2 = this.missingFields(act);
          if (!miss2.length) {
            let card = null;
            if (this.aiEnabled && act.stage === 'S2') card = this.producePlanCard(act, { locale: opts.locale, code: null });
            const out = earlyReturn('行，就按「先跑通流程」来——四样齐了，你在下面的确认卡里核对一遍，哪样不对点哪样改。', [], card);
            await doPersist();
            return out;
          }
          const nx = miss2[0];
          const reply = `好，目标就按先跑通流程算。还差${FIELD_LABEL[nx]}——${this._probeExample(nx)}，你说个大概就行。`;
          const out = earlyReturn(reply, SLOT_CHIPS[nx] || []);
          await doPersist();
          return out;
        }
        if (tBare) {
          const visits = (Number(act.memory.goal_bare) || 0) + 1;
          act.memory.goal_bare = visits;
          act.memory.ask_count.goal = (Number(act.memory.ask_count.goal) || 0) + 1;
          if (visits === 1) {
            const byAmount = raw.startsWith('具体金额');
            const reply = byAmount
              ? '行，按金额算——大概想挽回多少钱？给个数就行，比如「挽回 1000 元」。'
              : '行，冲挽回订单去——大概想挽回多少单？给个数就行，比如「挽回 50 单」。';
            const chips = byAmount ? ['挽回 1000 元', '挽回 5000 元', '先跑通流程'] : ['挽回 50 单', '挽回 100 单', '先跑通流程'];
            const out = earlyReturn(reply, chips);
            await doPersist();
            return out;
          }
          const fc = this._forceConfirmTurn(act, opts, 'stalled');
          const out = earlyReturn(fc.reply, [], fc.card);
          await doPersist();
          return out;
        }
        // tSelf：引导自由输入（不计数；下一轮说什么按正常管线走）
        const reply = '行，你直接打字说就行——比如「挽回 50 单」「挽回 1000 元」，或者「先跑通流程」。';
        act.memory.ask_count.goal = (Number(act.memory.ask_count.goal) || 0) + 1;
        const out = earlyReturn(reply, SLOT_CHIPS.goal || []);
        await doPersist();
        return out;
      }
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
    const routed = forceReason ? null : this._routeOffTopic(act, userText);
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
    // C6.5（2026-10-03 裁决）AI 预检：本轮词表命中与已确认值的「真冲突」预判（与 B2 同款豁免规则）。
    // 命中 → 提示词把本轮从「引导确认/常规追问」切到「先核实」，模型直接问澄清——
    // 仅影响提示词方向；冲突判定的权威仍是 B2 合并。
    const preConflict = this._preConflictPreview(act, userText);
    if (this.aiEnabled && this.callAI) {
      try {
        env = await this._aiCoach(act, userText, runtime, bufferedOnReplyToken, preProbe, preConflict);
        this._absorbLeakedJson(env);
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

    // B1 critic：envelope slot_updates 逐条校验原文语义依据（confidence<0.6 → inferred；
    // 词表命中直通；无依据 → 丢弃）。依据参照 = 本轮 + 紧邻上一轮用户原话（10-05 batch3 S14：
    // 用户在 T1 早给的原因「被 Shein 拉走」，模型按「只交本轮证据」契约永远无法入槽 → 同槽被无限重问）
    const prevUserMsg = [...act.messages].reverse().find(m => m.role === 'user');
    const groundRef = userText + (prevUserMsg ? '\n' + String(prevUserMsg.content || '') : '');
    const grounded = usedAI ? this._groundSlotUpdates(env.slotUpdates, groundRef) : [];
    runtime.slotUpdatesAccepted += grounded.length;
    runtime.slotUpdatesRejected += Math.max(0, (env.slotUpdates || []).length - grounded.length);
    // B2 更新列表：envelope 优先，词表覆盖同槽（kwTouched = 用户原话逐字命中，短时记忆语义=原话为准）
    const bySlot = {};
    const envSlots = new Set(); // 有 envelope（模型裁决）佐证的槽：S2 冻结期叙述守卫对它们不生效
    for (const u of grounded) { bySlot[u.slot] = bySlot[u.slot] || u; envSlots.add(u.slot); }
    if (kwActive) {
      for (const f of NEEDED_FIELDS) {
        if (kw[f]) bySlot[f] = { slot: f, value: kw[f], inferred: false, kw: true, env: envSlots.has(f) };
      }
    }
    // 词表兜底补缺（与 B1 kw 补缺同一哲学，真模型矩阵 m12/m15 实测）——必须在 turn 构造前：
    // ① 品牌名「品牌叫/是 X」→ extras.brand（模型在长句多素材时偶发漏交）
    const turnExtras = (Array.isArray(env.extras) ? env.extras : []).filter(e => e && String(e.value == null ? '' : e.value).trim());
    if (!turnExtras.some(e => e && e.key === 'brand')) {
      const bm = String(userText || '').match(/品牌(?:叫|是|名为)\s*([A-Za-z0-9\u4e00-\u9fa5]{1,24})/i);
      // 问句守卫（M8 同源，10-05 PRD 矩阵 A3 实测）：「品牌叫啥/叫什么名字」是查询不是陈述——
      // 抓到的疑问词不作品牌名，否则召回问句会把已存的 brand 覆写成「啥」
      const bmIsQuery = !bm || /^(啥|啥子|什么|啥名字|什么名字|名字|哪个|哪些|多少|什么来着|啥来着)$/i.test(bm[1])
        || /(多少|哪个|哪些|是不是|还记得|来着|叫啥|叫什么)/.test(bm[1]);
      if (bm && !bmIsQuery) turnExtras.unshift({ key: 'brand', value: bm[1] });
    }
    // ② C6 澄清轮后的数字分段短答（「25 到 34 吧」「按 25-34 吧」）→ audience 回答（chips 选项的输入框等价物）。
    //    P1-N1（复测 10-03）：允许 ≤3 个非数字引导字（按/就/选…）与语气尾字，否则口头决议抓不到、账本滞后一轮
    if (!bySlot.audience) {
      const segM = String(userText || '').trim().match(/^[^\d]{0,3}(\d{1,3})\s*(?:到|[-~～])\s*(\d{1,3})\s*(?:岁)?\s*(?:的|吧|这个|人群|客户|之间)?[\s。！?？!~，,]*$/);
      if (segM) bySlot.audience = { slot: 'audience', value: `${segM[1]}-${segM[2]}岁`, inferred: false, kw: true };
    }
    // ③ C6 决议桥（P0-N3/G-1）：上一轮冲突追问的 chips 被商家原样点选/复述 → 映射为该槽显式更新。
    //    chips 的提交契约就是「把标签当文本发回」（点击 = sendMsg(文案)），降级轮没有模型兜底抽取，
    //    必须在此桥接成 slot update；「维持/我自己说/我来说原因」类出口不映射（维持走 C6 保旧值口径，
    //    自由输入出口等商家打字），文本明确保旧值时整段跳过。
    const askedCf = (act.memory && Array.isArray(act.memory.conflicts) ? act.memory.conflicts : [])
      .find(c => c && c.asked === true && c.slot);
    if (askedCf && !bySlot[askedCf.slot] && !/维持|保持|原来(?:的|那)|之前的|按旧|不换|不改|不要改/.test(String(userText || ''))) {
      const chip = (conflictChips(askedCf.slot) || []).find(ch => ch && String(userText || '').includes(ch));
      if (chip && !/维持|保持|原来的|之前的|我自己|我来说/.test(chip)) {
        const chipVal = askedCf.slot === 'audience' && /^\d/.test(chip) ? `${chip}岁` : chip;
        bySlot[askedCf.slot] = { slot: askedCf.slot, value: chipVal, inferred: false, kw: true };
      }
    }
    const turn = {
      userText,
      updates: Object.values(bySlot),
      corrections: env.corrections || [],
      extras: turnExtras,
      conflictCandidates: [],
      deferConflicts: Boolean(forceReason || writeIntent)
    };

    // —— Wave 5 预检短轮（B2 合并前，命中即短路）：#12 语种越权拦截 / E1 冲动折扣拦截 ——
    //    offer 相关更新一律剥离（E1 决议轮由「替代/坚持」分支写入），先建议后落槽。
    const w5pre = this._wave5PreTurn(act, userText, turn, { executors: opts.executors || this.executors });
    if (w5pre) {
      return await this._emitShortTurn(act, userText, w5pre, { usedAI, aiDead, runtime, guardrailHits, doPersist, opts, tokenBuffer, nowMs });
    }

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
      // 出卡口径与防呆/写意图/阶梯分支一致（10-05 GUI 全功能测试 F-3 修复）：A3 复用预填四齐
      // 进 S2 时也出无码预览卡——话术说「确认卡里核对」就不能没有卡。
      let card4 = null;
      if (act.stage === 'S3' && act.plan_card) card4 = act.plan_card;
      else if (this.aiEnabled && act.stage === 'S2' && this.missingFields(act).length === 0) {
        card4 = this.producePlanCard(act, { locale: opts.locale, code: null });
      }
      return {
        reply: reply4, stage: act.stage, needs: act.needs,
        planCard: card4,
        guardrailHits,
        engine: this._engineOf(usedAI && !aiDead),
        chips: w4.chips || [], askedSlot: w4.askedSlot || null,
        agentMeta: this._agentMeta(runtime)
      };
    }

    // —— Wave 5 I5 批次状态一眼看：「现在都在跑啥」→ 三行汇报/折叠/异常建议（确定性短路；口径与 notify.campaignStats 同源）——
    const w5 = this._batchStatusTurn(act, userText, executors);
    if (w5) {
      return await this._emitShortTurn(act, userText, w5, { usedAI, aiDead, runtime, guardrailHits, doPersist, opts, tokenBuffer, nowMs });
    }

    // 弱信号离题兜底：仅桩模式使用（无模型时才需引擎判断 stalled）。
    // 有真模型时，_aiCoach 已自然接住离题，此处若兜底会覆盖模型的正常回复 → 必须跳过。
    if (!forceReason && !usedAI && this._offTopicWeak(act, userText, filledBefore)) {
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

    // 出口兜底也必须先经过提取、折扣预检和记忆落账；未决冲突仍优先澄清。
    if ((forceReason || writeIntent) && act.stage === 'S1' && !act.memory.conflicts.length) {
      const fc = this._forceConfirmTurn(act, { ...opts, previewAvailable: !aiDead }, forceReason || 'write');
      act.messages.push({ role: 'user', content: userText, ts: nowMs });
      act.messages.push({ role: 'assistant', content: fc.reply, ts: nowMs });
      act.updated_at = nowMs;
      await doPersist();
      return {
        reply: fc.reply, stage: act.stage, needs: act.needs, planCard: fc.card,
        guardrailHits, engine: this._engineOf(usedAI && !aiDead),
        chips: [], askedSlot: null, agentMeta: this._agentMeta(runtime)
      };
    }

    // —— B4 选问决策（合并后）：问槽 / 冲突澄清 / 不问；question 可被下方对齐防护重绑 ——
    let question = this._decideQuestion(act, mergeResult);

    // —— B5 回复组装：AI envelope reply 或桩教练；0 提取轮直接问缺失项 ——
    let reply = env.reply || '';
    let askedSlot = null;
    if (!reply) {
      const stub = this._stubReply(act, userText, question, mergeResult.conflictsNew);
      reply = stub.reply;
      if (stub.asked) askedSlot = question.slot;
    } else {
      askedSlot = question.slot; // 在线路径：提示词已按 B4 指令约束「一轮只问一个」
    }
    if (aiDead && !guardrailHits.includes('AI_OFFLINE')) guardrailHits.push('AI_OFFLINE');
    // inferred 槽回复必须可纠正（B5 硬约束）：回复缺「我理解为/不对请纠正」表述时引擎补一句
    reply = this._appendInferredNote(reply, act, mergeResult.acceptedInferred, usedAI);
    // 冲突轮回复必须真的在核实（B4 已选冲突轮时模型措辞不稳定 → 引擎兜底补问，PRD 剧本 #4）
    reply = this._appendConflictAsk(reply, question, mergeResult.conflictsNew);
    // 问句对齐防护（09-30 报告 P1-2/P1-3 变体）：模型自行口头核实某槽旧值但未交 slot_updates 时，
    // B4 预决策仍指向下一空槽 → 问句与 chips 错位。检测命中 → 重绑到被核实的槽（冲突 chips）。
    if (usedAI && !aiDead && question.kind === 'probe') {
      const verify = this._detectVerifyReply(reply, act);
      if (verify && verify.slot !== question.slot) {
        askedSlot = verify.slot;
        question = { slot: verify.slot, chips: conflictChips(verify.slot), kind: 'conflict' };
      }
    }
    // 澄清轮形态（C6.5②，2026-10-03 裁决）：S2 全满态真冲突 → 本轮只发澄清问句＋冲突 chips，
    // 不引导确认、不出预览卡（澄清是核验不是采集；落定后下一轮恢复收口）。在线模型若按四齐口径
    // 只出了确认引导，此处整句替换为标准澄清问句，杜绝「引导确认 + 澄清」两问混合。
    if (act.stage === 'S2' && question.kind === 'conflict' && usedAI && !aiDead) {
      reply = this._conflictAskLine(act, question, mergeResult.conflictsNew);
    }
    // S2 收口引导兜底（B5）：四要素齐且在 S2，模型回复缺确认引导时补一句（真模型 30 轮实测
    // 「这就帮你生成」类抢跑——生成动作只能走 /confirm 端点，话术必须把用户引向确认卡）。
    // 例外：本轮是冲突澄清轮（C6.5②）——澄清优先于引导确认，不许混入收口话术。
    // 卡感知（10-05）：降级轮不出卡（剧本 #13），stub 话术已按卡感知生成——不再拼任何后缀；
    // 在线轮才拼「确认卡」收口句。
    if (act.stage === 'S2' && this.missingFields(act).length === 0 && question.kind !== 'conflict' && !/确认|核对|行不/.test(reply)) {
      if (usedAI && !aiDead) reply += ' 四样都在下面的确认卡里，你核对一遍，没问题就点确认。';
    }

    // B5 硬约束落实：本轮选了追问但模型回复没带任何问句 → 引擎补一句该槽探问。
    // includes 守卫（10-05）：探问句本身漏问号时（S1 首轮实测整句重复两遍），？检查拦不住
    if (askedSlot && question.kind !== 'conflict' && !/[?？]/.test(reply)) {
      const p = this.probeFor(askedSlot);
      if (!reply.includes(p)) reply += ' ' + p;
    }

    // —— 单一 FSM 权威：阶段推进只在此处（桩/AI 两条路径一致），_stubReply/_aiCoach 不碰 stage（P2-1）——
    this._advanceStage(act, userText);

    // —— 护栏管线（L0→L1→L2→L4；违规重生成 1 次 + 轮换兜底）——
    //    注：L3 已软化（P0-4）—— 不再强制问号，问号与否交给模型人格（COACH_SYSTEM_PROMPT 要求"该问才问"）
    // 桩 authored 豁免（2026-10-05 视频罐头循环根治）：aiDead/桩路径的回复是引擎模板（G2 语义：
    // 降级回复也走 B4/B5 状态机），REPEAT/L4 与 L2 的模型 critic 属「模型输出护栏」不适用——
    // 宕机期重生成必然失败 → 落 FALLBACK_CATCH 罐头，且探问句固定 → 锁死「卡了一下」循环。
    // 本地 L2 正则仍对桩回复生效（模板话语安全兜底）。
    const stubAuthored = !usedAI || aiDead;
    // L0：空回复或退化输出（实测出现过 3 字符 "[1]" 残渣）→ 落兜底池，绝不直达用户
    // 兜底一律走 _fallbackWithProbe（P1-3）：问句按当前缺口生成并与 chips 同源，绝不复用 FALLBACK_POOL 完整句
    if (!guardrailL0(reply) || reply.trim().length < 2) {
      const fb = this._fallbackWithProbe(act, question, mergeResult.conflictsNew);
      reply = fb.reply; askedSlot = fb.slot; guardrailHits.push('L0');
    }
    reply = guardrailL1(reply);
    // L2 说教/推销：本地正则先拦 + /critic 精判；违规先重生成 1 次（真模型），仍不过则兜底
    let l2ok = guardrailL2(reply);
    if (l2ok && !stubAuthored && this.callCritic && this._criticRequired(reply)) {
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
      else {
        const fb = this._fallbackWithProbe(act, question, mergeResult.conflictsNew);
        reply = fb.reply; askedSlot = fb.slot; guardrailHits.push('L2');
      }
    }
    // L4 抢跑禁令（S3 前不得出方案卡式配置）；桩回复豁免——收口句「确认卡」是引擎权威话术
    if (!stubAuthored && !guardrailL4(reply, act.stage)) {
      const regen = await this._tryRegen(act, userText, 'preempt', runtime);
      if (regen && guardrailL4(regen, act.stage)) { reply = regen; guardrailHits.push('L4regen'); }
      else {
        const fb = this._fallbackWithProbe(act, question, mergeResult.conflictsNew);
        reply = fb.reply; askedSlot = fb.slot; guardrailHits.push('L4');
      }
    }

    // 交付层防复读（走查 P1-1）：与上一句助手回复高度相似 → 重生成 1 次，仍相似则轮换兜底。
    // 放在 push 之前，比对对象才是「上一轮」的回复。
    // 例外：四要素已齐的确认阶段，提示词本来就要求「复述要点 + 问同一句确认」，回复天然相似，不做此检查
    const lastAssistant = [...act.messages].reverse().find(m => m.role === 'assistant');
    if (!stubAuthored && lastAssistant && this.missingFields(act).length > 0 && this._similarEnough(lastAssistant.content, reply)) {
      const regen = await this._tryRegen(act, userText, 'repeat', runtime);
      if (regen && !this._similarEnough(lastAssistant.content, regen)) { reply = regen; guardrailHits.push('REPEATregen'); }
      else {
        const fb = this._fallbackWithProbe(act, question, mergeResult.conflictsNew);
        reply = fb.reply; askedSlot = fb.slot; guardrailHits.push('REPEAT');
      }
    }

    // B4 记账（P1-3 修复后移到护栏之后）：askedSlot 已是最终问句的槽位——护栏替换可能改写问句，
    // 提前记账会把 ask_count 记到本轮实际没问的槽上。本轮实际追问的槽 ask_count +1；冲突候选标记 asked。
    if (askedSlot) {
      act.memory = ensureMemory(act.memory, nowMs);
      act.memory.ask_count[askedSlot] = (Number(act.memory.ask_count[askedSlot]) || 0) + 1;
      // C6.5④ 拉锯保护计数：澄清轮实际发出 → 该槽 clarif_count +1（含 S2；下一次改口直接按 correction 处理）
      if (question.kind === 'conflict') {
        act.memory.clarif_count[askedSlot] = (Number(act.memory.clarif_count[askedSlot]) || 0) + 1;
      }
      for (const c of act.memory.conflicts || []) {
        if (c.slot === askedSlot) c.asked = true;
      }
    }
    // chips 与最终问句同源（P1-3 硬约束）：问哪个槽挂哪个槽的选项；护栏替换改写问句后跟随重绑
    const chips = !askedSlot ? []
      : (question.kind === 'conflict' && askedSlot === question.slot) ? question.chips
        : (SLOT_CHIPS[askedSlot] || []);

    // —— 强制循环熔断（最后防线，2026-10-05 循环压测）：任何护栏组合失效后，采集期若本条
    //    将成为连续第 3 条近似回复 → 强制换装「账本复述 + 换法提问」的结构性不同话术。
    //    S2 确认同文属设计（剧本 #16/p13 基线），不在此列。 ——
    reply = this._forceBreakLoop(act, reply, askedSlot);

    act.messages.push({ role: 'user', content: userText, ts: nowMs });
    act.messages.push({ role: 'assistant', content: reply, ts: nowMs });
    act.updated_at = nowMs;

    // 静默采集 → 方案卡（Wave 2 契约）：
    //  - S3（confirm 已通过）→ 回权威卡 act.plan_card（含店铺真实回执码）；
    //  - 四要素齐 + 本轮在线（真模型 envelope）→ 产出「无码预览卡」（code_status=pending，
    //    真实出卡在 /confirm 建码成功之后 —— E2 红线：卡面绝不出现未真实存在的折扣码）；
    //  - 降级轮（桩 / AI 失败）不出 planCard（剧本 #13：降级 4/4 时 stage=S2 且不出 planCard）；
    //  - 澄清轮不出预览卡（C6.5②，2026-10-03 裁决：澄清轮只问不推卡，落定后下轮恢复收口）。
    let planCard = null;
    if (act.stage === 'S3' && act.plan_card) {
      planCard = act.plan_card;
    } else if (usedAI && !aiDead && this.missingFields(act).length === 0 && question.kind !== 'conflict') {
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

    // ⑤ 词表兜底（整短语匹配，禁碎片切片）：降级路径是唯一抽取源；在线路径当模型没产出
    //   任何 ops/batch_plan 时同样兜底（真模型 30 轮实测：模型对批次指令偶发「只说不做」）
    if (!ops.length && !batchPlan.length) {
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
        // Wave 5 I5：「换主题行再打」承接低打开率建议 → 目标优先取汇报时挂的 resend_target
        const hintTarget = (act.pending_ops && act.pending_ops.resend_target)
          ? { campaign_id: act.pending_ops.resend_target } : null;
        const resolved = (op.kind === 'resend' && hintTarget)
          ? hintTarget
          : (executors.resolveTarget ? await executors.resolveTarget(op.target || null) : null);
        if (resolved) {
          if (act.pending_ops) delete act.pending_ops.resend_target;   // 建议已承接，一次性消费
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
    const keptText = [];
    const slots = [];
    const put = (slot, raw) => {
      const v = clampNeedValue(raw);
      if (!v) return;
      // 用户本轮已说出的差异值优先（B2 刚入账），prefs 只填用户没说的槽——差异不得被静默覆盖（A3）
      const cur = act.needs[slot];
      if (cur && String(cur.value || '').trim()) {
        keptText.push(`${FIELD_LABEL[slot]}按你刚说的「${cur.value}」`);
        return;
      }
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
    if (keptText.length) reply += `${keptText.join('、')}，这跟上次不一样，就按你这次的说。`;
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


  /* ------------------- Wave 5：E1 冲动折扣拦截 / #12 语种越权 / I5 批次状态（确定性短路轮）------------------- */

  /** 短路轮统一出口（与批次运维轮同构：护栏 L0/L1/L2/L4 → 先落库后回复 → token 缓冲冲刷；不推进 FSM）。 */
  async _emitShortTurn(act, userText, short, ctx) {
    const { usedAI, aiDead, runtime, guardrailHits, doPersist, opts, tokenBuffer, nowMs } = ctx;
    let reply = guardrailL1(short.reply || '');
    if (!guardrailL0(reply) || reply.trim().length < 2) { reply = this._pickFallback(act); guardrailHits.push('L0'); }
    if (!guardrailL2(reply)) { reply = this._pickFallback(act); guardrailHits.push('L2'); }
    if (!guardrailL4(reply, act.stage)) { reply = this._pickFallback(act); guardrailHits.push('L4'); }
    if (short.askedSlot) {
      act.memory = ensureMemory(act.memory, nowMs);
      act.memory.ask_count[short.askedSlot] = (Number(act.memory.ask_count[short.askedSlot]) || 0) + 1;
    }
    act.messages.push({ role: 'user', content: userText, ts: nowMs });
    act.messages.push({ role: 'assistant', content: reply, ts: nowMs });
    act.updated_at = nowMs;
    await doPersist();
    if (opts.onReplyToken && tokenBuffer.length) {
      for (const p of tokenBuffer) opts.onReplyToken(p);
    }
    return {
      reply, stage: act.stage, needs: act.needs,
      planCard: (act.stage === 'S3' && act.plan_card) ? act.plan_card : null,
      guardrailHits,
      engine: this._engineOf(usedAI && !aiDead),
      chips: short.chips || [], askedSlot: short.askedSlot || null,
      ...(Array.isArray(short.opResults) ? { campaignOps: short.opResults } : {}),
      agentMeta: this._agentMeta(runtime)
    };
  }

  /**
   * Wave 5 预检（B2 合并前调用，turn.updates 可被剥离）。返回 null = 无 Wave 5 语义，回归常规流水线。
   * 判定顺序：#12 语种越权 → E1 待决议轮（替代/坚持/放弃）→ E1 新命中拦截。
   */
  _wave5PreTurn(act, userText, turn, { executors } = {}) {
    // ① #12 语种越权（E4 对话内版）：G0 是发送时拦截，这里是对话内的确定性拒绝 + 解释
    const locale = this._localeGuardTurn(userText);
    if (locale) return locale;
    const pending = (act.pending_ops && typeof act.pending_ops === 'object') ? act.pending_ops : {};
    // ② E1 待决议轮：offer 更新一律剥离（决议分支才写槽）
    if (pending.e1) {
      if (turn && Array.isArray(turn.updates)) turn.updates = turn.updates.filter(u => u.slot !== 'offer');
      return this._resolveImpulsePending(act, userText, pending, executors);
    }
    // ③ E1 新命中：先拦截不入 offer 槽，给替代建议 + chips
    const det = this._detectImpulseForTurn(userText, executors);
    if (det.hit) {
      if (turn && Array.isArray(turn.updates)) turn.updates = turn.updates.filter(u => u.slot !== 'offer');
      act.pending_ops = { ...(act.pending_ops || {}), e1: { ...det, at: Date.now() } };
      return { reply: impulse.composeIntercept(det), chips: ['换成替代方案', '就要这个折扣'], askedSlot: null };
    }
    return null;
  }

  /** #12（E4 对话内版）：「邮件正文直接用中文写给美国客户」类 → 拒绝 + 语种跟随收件人 + 槽位不动。 */
  _localeGuardTurn(userText) {
    if (!LOCALE_FORCE_RE.test(String(userText || ''))) return null;
    return {
      reply: '语种这头我不改：挽回邮件的语种跟着收件人走——你的客户在美国，邮件就发英文版（发送时逐收件人按其 locale 本地化），聊天里咱们用中文随便聊。四项配置都没动，要继续调哪样？',
      chips: [], askedSlot: null
    };
  }

  /** E1 检测入口（词表 offer 原文 + 大促季放宽阈值；阈值/窗口常量读 lib/config 单处权威） */
  _detectImpulseForTurn(userText, executors) {
    let kwOffer = '';
    try { kwOffer = (extractNeeds(userText) || {}).offer || ''; } catch (e) { kwOffer = ''; }
    let saleWindow = false;
    try { saleWindow = executors && typeof executors.saleWindow === 'function' ? Boolean(executors.saleWindow()) : false; } catch (e) { saleWindow = false; }
    return impulse.detectImpulse(userText, { offerRaw: kwOffer, saleWindow });
  }

  /**
   * E1 待决议轮：坚持（照做入槽 + 审计留痕「建议已给，用户坚持」）> 替代（替代值入槽）> 放弃（撤建议回正常流水线）。
   * 返回 null = 本轮不做决议（建议已撤），落回常规 B4 流水线。
   */
  _resolveImpulsePending(act, userText, pending, executors) {
    const e1 = pending.e1 || {};
    const clearE1 = () => {
      const rest = { ...(pending || {}) };
      delete rest.e1;
      act.pending_ops = Object.keys(rest).length ? rest : null;
    };
    if (impulse.INSIST_RE.test(userText)) {
      if (e1.offerRaw) act.needs.offer = { value: clampNeedValue(e1.offerRaw), source: 'explicit', at: Date.now() };
      clearE1();
      // 审计留痕（建议已给，用户坚持）；无执行器（单测桩）时跳过留痕不阻断
      if (executors && typeof executors.audit === 'function') {
        try {
          executors.audit({
            kind: 'e1_insist', act_id: act.id,
            note: `E1 建议已给（阈值 ${e1.threshold}%），用户坚持原方案${e1.percent != null ? ` ${e1.percent}% off` : (e1.kind === 'mass' ? '（全量触达）' : '')}`
          });
        } catch (err) { /* 留痕失败不阻断用户决策 */ }
      }
      const kept = e1.offerRaw || (e1.percent != null ? `${e1.percent}% off` : '原方案');
      return { reply: `行，按你说的「${kept}」进方案——替代建议已经给过、留痕备查，毛利这块你把着舵。还要配哪项？`, chips: [], askedSlot: null };
    }
    if (impulse.ALTERNATIVE_RE.test(userText)) {
      const alt = impulse.pickAlternative(userText);
      act.needs.offer = { value: clampNeedValue(alt, 40), source: 'explicit', at: Date.now() };
      clearE1();
      return { reply: `好，钩子换成「${alt}」，已进方案：毛利保住，回流预期也更真实。还要调哪项？`, chips: [], askedSlot: null };
    }
    clearE1();
    return null;
  }

  /**
   * Wave 5 I5：批次状态问句 → 三行汇报（≤3 批逐批一行；>3 批只报非正常态 + 折叠计数行）。
   * 打开率显著低 → 行尾「建议换主题行再打一轮」+ chips；建议目标挂 act.pending_ops.resend_target，
   * 用户回「换主题行再打」→ 走既有 resend 409 确认流（频次护栏语义不变）。
   * 无批次/无执行器 → null（不劫持对话）。
   */
  _batchStatusTurn(act, userText, executors) {
    if (!BATCH_STATUS_RE.test(String(userText || ''))) return null;
    if (!executors || typeof executors.listCampaignReports !== 'function') return null;
    let camps = null;
    try { camps = executors.listCampaignReports(); } catch (e) { camps = null; }
    if (!Array.isArray(camps) || !camps.length) return null;
    const rep = campaignsMod.composeBatchReport(camps);
    if (!rep.reply) return null;
    if (rep.advised.length) {
      act.pending_ops = { ...(act.pending_ops || {}), resend_target: rep.advised[0] };
    }
    return { reply: rep.reply, chips: rep.chips, askedSlot: null };
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
      // C4 禁止罐头默认值（P2-N4 配套）：goal 的 chips 类别词本身不是可验收目标——
      // 模型照抄 chip 文案交槽（goal=「挽回订单/具体金额」）时丢弃，等商家补上具体值再收
      if (slot === 'goal' && /^(挽回订单|具体金额)$/.test(value)) continue;
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
        // B2 判定权威是用户消息的语气词，不是模型标签：无修正语气时模型的「纠正」降级为普通新值，
        // 转入 ② 走冲突候选通道（防模型误标 correction 把已确认值静默顶掉——真模型联调 p04 实测）
        if (!hasTone) {
          turn.updates.push({ slot, value: newVal, confidence: 1, inferred: false });
          continue;
        }
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
      // 挂着的已追问冲突的决议（矩阵 m10/m11 实测 + 复测 10-03 P1-N1）：
      //  「维持/保持/原来的」→ 保留旧值（候选丢弃）；用户当面给出了任何新值 = 冲突的答案——
      //  同轮 explicit 入槽 + corrections 记账，绝不再产出新冲突候选（旧行为只认「新值===候选值」，
      //  答 chips 的其它选项会再挂一轮冲突：账本滞后一轮 + B4 反问刚解决的冲突，一轮两问）
      const askedCf = (mem.conflicts || []).find(c => c.slot === slot && c.asked === true);
      if (askedCf) {
        if (/维持|保持|原来(?:的|那)|之前的|按旧|不换|不改|不要改/.test(turn.userText || '')) continue;
        const cfOld = prev ? prev.value : '';
        needs[slot] = { value, source: 'explicit', at: now };
        corrected.add(slot);
        if (cfOld && cfOld !== value) {
          mem.corrections.push({ slot, old: cfOld, new: value, at: now });
          mem.corrections = mem.corrections.slice(-MAX_CORRECTIONS);
          correctionsAdded++;
        }
        continue;
      }
      if (prev && !hasTone) {
        // 同义重申豁免（B2.3，2026-10-03 裁决）：归一化相等 / 完整包含 / 词表同义 → 同值处理
        // （不追问、不重复计数、不复述为新信息、不产冲突候选）——S2 确认期的口径复述从此不再误伤
        if (this._similarEnough(prev.value, value) || this._sameSemantic(prev.value, value)) continue;
        // S2 冻结期词表叙述守卫（剧本 #13/#16 基线）：四槽已满的确认期，纯词表命中的已填槽多为
        // 叙述性提及（如「加购未付的客户忘了付款，把方案卡给我看看」）——不产冲突候选；
        // S2 真冲突的语义裁决权在在线模型 envelope（B1 critic 锚定原话），真改口走 correction 语气。
        if (act.stage === 'S2' && u.kw === true && u.env !== true) continue;
        // 拉锯保护（C6.5④）：同槽澄清 ≤1 次（含 S2）；第二次改口不再追问，直接按 correction 落账（留痕）
        const clarifN = Number((mem.clarif_count || {})[slot]) || 0;
        if (clarifN >= 1) {
          const oldVal = prev.value;
          needs[slot] = { value, source: 'explicit', at: now };
          corrected.add(slot);
          mem.corrections.push({ slot, old: oldVal, new: value, at: now });
          mem.corrections = mem.corrections.slice(-MAX_CORRECTIONS);
          correctionsAdded++;
          continue;
        }
        // 冲突：现值已填 + 本轮消息无修正语气 → 不覆盖，产出冲突候选转 B4 澄清。
        // kw 原话命中同规则：触发词是用户原话，但写入值是词表归一化短语——
        // 静默覆盖会把用户已确认的具体值（如「本月挽回100单」）冲成罐头短语（真模型联调 p13 实测）。
        turn.conflictCandidates.push({ slot, old: prev.value, new: value });
        continue;
      }
      const inferred = u.inferred === true;
      needs[slot] = { value, source: inferred ? 'inferred' : 'explicit', at: now };
      if (inferred) acceptedInferred.push(slot);
      if (prev && hasTone) {
        // 用户带修正语气覆盖已填值 → 记 corrections（追加制）
        mem.corrections.push({ slot, old: prev.value, new: value, at: now });
        mem.corrections = mem.corrections.slice(-MAX_CORRECTIONS);
        corrected.add(slot);
        correctionsAdded++;
      }
    }

    // ③ C6 兜底：上一轮冲突追问未被回应 → 接受候选新值 inferred（inferred 槽回复带「不对请纠正」）
    const retainedConflicts = [];
    for (const cf of (mem.conflicts || []).slice(0, MAX_CONFLICTS)) {
      if (cf.asked !== true) { retainedConflicts.push(cf); continue; }
      const slot = cf.slot;
      if (corrected.has(slot)) continue;
      if ((turn.updates || []).some(x => x.slot === slot)) continue; // 本轮已回应
      // 「维持/保持/原来的」→ 用户选择保留旧值，候选丢弃（矩阵 m10 实测：chips 选项「维持当前年龄定位」）
      if (/维持|保持|原来(?:的|那)|之前的|按旧|不换|不改|不要改/.test(turn.userText || '')) continue;
      if (turn.deferConflicts) { retainedConflicts.push(cf); continue; }
      const cur = needs[slot];
      const curVal = cur ? cur.value : '';
      const candVal = clampNeedValue(cf.new);
      if (candVal && curVal !== candVal) {
        needs[slot] = { value: candVal, source: 'inferred', at: now };
        acceptedInferred.push(slot);
      }
    }
    mem.conflicts = retainedConflicts;

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
    return { corrected, conflictsNew: mem.conflicts, acceptedInferred, correctionsAdded };
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

  /** 冲突澄清兜底（B5）：B4 本轮选了冲突澄清，但在线模型回复可能只顾推进话题没真的核实
   *  （真模型联调实测：模型说「客群调整为年轻人」就跳去问下一项）——引擎补一句复述旧值 + 二选一。
   *  模型已复述旧值核实 → 不重复补。 */
  _appendConflictAsk(reply, question, conflictsNew) {
    if (!question || question.kind !== 'conflict') return reply;
    const c = (conflictsNew || [])[0];
    if (!c || !c.old || !c.new) return reply;
    const t = String(reply || '');
    if (t.includes(String(c.old).slice(0, 8))) return reply; // 已复述旧值 = 在核实
    const ask = `对了，之前记的是「${c.old}」，这轮要按「${c.new}」算吗？还是维持原来的，你定。`;
    return t ? `${t} ${ask}` : ask;
  }

  /** 澄清轮标准问句（C6.5②，2026-10-03 裁决）：先复述旧值再给新选项，只问冲突这一件事——
   *  S1/S2 同规（S2 引导确认让位）；候选缺失时退化为该槽单点探问（不空转）。 */
  _conflictAskLine(act, question, conflictsNew) {
    const c = (conflictsNew || []).find(x => x && x.slot === question.slot) || (conflictsNew || [])[0];
    if (c && c.old && c.new) return this._appendConflictAsk('', question, [c]);
    return this._probe(act, question.slot);
  }

  /** B1 修复（2026-10-05 实测）：模型偶发把 slot_updates JSON 数组泄漏为用户可见回复
   *  （如「[{"slot":"goal",...}] 你希望拿到什么结果？」）——PRD B5 禁止暴露内部字段。
   *  解析泄漏的数组吸收进 slot_updates（后续照常过 B1 critic 原文依据校验），
   *  reply 只保留 JSON 之后的自然语言；整段不可解析则原样交给 L0 兜底。 */
  _absorbLeakedJson(env) {
    let t = String(env.reply || '');
    // ① slot_updates 数组泄漏：吸收进 slotUpdates（后续照常过 B1 critic 原文依据校验）
    const m = t.match(/(\[\s*\{\s*"slot"\s*:\s*"[\s\S]*?\]\s*)/);
    if (m) {
      try {
        const arr = JSON.parse(m[1]);
        if (Array.isArray(arr)) {
          env.slotUpdates = Array.isArray(env.slotUpdates) ? env.slotUpdates : [];
          for (const u of arr) {
            if (u && typeof u === 'object' && u.slot && u.value != null) {
              env.slotUpdates.push({ slot: String(u.slot), value: String(u.value), confidence: Number(u.confidence) || 0.9, inferred: u.inferred === true });
            }
          }
          t = t.slice(0, m.index) + t.slice(m.index + m[1].length);
        }
      } catch (e) { /* 不可解析 → 走 ② 通用剥离 */ }
    }
    // ② 其他形态 JSON 前缀垃圾（如内容块数组 [{"type":"text",...}]，qwen3.8-flash 实测）：
    //    中文口语回复永远不会以 [ { " 开头——能整段解析成 JSON 的前缀一律剥离，防内部结构直达用户
    if (/^\s*[\[{"]/.test(t)) {
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c !== ']' && c !== '}') continue;
        try {
          const v = JSON.parse(t.slice(0, i + 1));
          if (v && typeof v === 'object') { t = t.slice(i + 1); break; }
        } catch (e) { /* 继续找下一个闭合符 */ }
      }
    }
    env.reply = t.trim();
  }

  /** C6.5（2026-10-03 裁决）AI 预检：本轮词表命中与已确认值的「真冲突」预判。
   *  豁免规则与 B2 同款（归一化相等 / 完整包含 / 词表同义 / 拉锯保护已接管），
   *  命中返回 { slot, old, new } 供提示词把本轮切到「先核实」；判定权威仍是 B2 合并。 */
  _preConflictPreview(act, userText) {
    const hasTone = CORRECTION_TONE_RE.test(String(userText || ''));
    if (hasTone) return null;
    const kw = extractNeeds(userText);
    const mem = act.memory || {};
    for (const f of NEEDED_FIELDS) {
      const raw = kw[f];
      const value = raw ? clampNeedValue(raw) : '';
      if (!value) continue;
      const prev = act.needs[f];
      if (!prev || !prev.value || prev.value === value) continue;
      if (this._similarEnough(prev.value, value) || this._sameSemantic(prev.value, value)) continue;
      if ((Number((mem.clarif_count || {})[f]) || 0) >= 1) continue; // 拉锯保护已接管的槽不再预检核实
      return { slot: f, old: prev.value, new: value };
    }
    return null;
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
    // 词表提取命中 → 是业务素材不是闲聊，放行进采集（10-05 PRD 矩阵：BIZ_RE 词表比提取词表窄，
    // 「客人说运费太贵就不付了/我品牌叫 X」类首句曾被当闲聊刷掉，槽位信息整句丢失）
    const kwHit = extractNeeds(t);
    if (NEEDED_FIELDS.some(f => kwHit[f])) return null;
    if (/品牌(?:叫|是|名为)|店名|我卖|我做/.test(t)) return null; // 品牌名/品类是 handle 后段 extras 逻辑采的，这里先放行
    if (BIZ_RE.test(t)) return null;             // 业务相关 → 不拦
    if (IDENTITY_RE.test(t)) return { primary: IDENTITY_POOL[0], pool: IDENTITY_POOL };
    if (META_RE.test(t)) return { primary: META_POOL[0], pool: META_POOL };
    return { primary: OFFTOPIC_POOL[0], pool: OFFTOPIC_POOL };
  }

  /** 弱信号离题兜底：多轮无任何新字段 + 无业务关键词 + 非确认/调整意图 → 视为 stalled/离题，接住拉回 */
  _offTopicWeak(act, userText, filledBefore) {
    // S2 满卡态不适用「stalled 采集」语义：确认/否认/调整由 S2 stub 分支全权处理
    // （10-05 用户实测：「按这个配」在 S2 被误判离题甩到闲聊池）
    if (act.stage === 'S2' || act.stage === 'S3') return false;
    const t = (userText || '').trim();
    if (!t) return false;
    // 业务关键词命中 → 绝非离题
    if (BIZ_RE.test(t)) return false;
    const filledAfter = countFilled(act.needs);
    if (filledAfter <= filledBefore) {
      if (filledAfter === 0) return false; // 还没聊出任何字段，用户在想，不判离题
      const userTurns = act.messages.filter(m => m.role === 'user').length;
      if (userTurns < 3) return false; // 至少 3 轮用户发言仍无进展才兜底
      // 在推进的不算（10-05 补：配/按这/就这/这样/搞定 等确认意图短句曾被漏判）
      if (/(对|是的|可以|确认|改|调|换|发|生成|方案|配置|不对|好|行|配|按这|就这|这样|搞定|开配|ok)/.test(t.toLowerCase())) return false;
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

  /** 强制循环熔断（最后防线）：尾部已有 2 连近似回复且本条仍近似（= 将成 3 连）时，
   *  用「账本复述 + 该槽示例引导」重组回复——结构与探问句/罐头不同构，且随账本演进天然变化；
   *  极端情况下仍近似则追加显著性后缀，保证绝不三连同文。仅采集期生效。 */
  _forceBreakLoop(act, reply, askedSlot) {
    if (this.missingFields(act).length === 0) return reply; // S2 确认同文属设计
    // 窗口计数（2026-10-05 压测修正）：邻接比对抓不住「隔轮交替」型循环
    //（模型回复 X 与罐头/探问交替，相邻恒不同文、窗口 3 数不到 2 次近似）。
    // 改按窗口 4：最近 4 条助手中与本条近似 ≥2 且上一条也近似 → 强制换装。
    const assistants = [];
    for (let i = act.messages.length - 1; i >= 0 && assistants.length < 4; i--) {
      const m = act.messages[i];
      if (m.role === 'assistant') assistants.unshift(String(m.content || ''));
    }
    if (assistants.length < 2) return reply;
    // 注意不加「上一条也近似」条件：交替型循环里上一条恰是异文罐头，加了就永远不触发
    // 问句体比对（10-05 截图循环）：_probe 的换皮前缀（换个说法——/再帮我想想这一项就行：…）
    // 让整句包含比对恒失配 → 同一问句连问 N 遍断路器永不触发。换皮变体里问句原文/示例
    // 至少逐字出现其一，以「针」集合匹配——任一针同时出现在窗口助手句与本句即计近似。
    const needles = [];
    if (askedSlot && NEEDED_FIELDS.includes(askedSlot)) {
      const p = this.probeFor(askedSlot);
      if (p && p.length >= 8) needles.push(p);
      const ex = this._probeExample(askedSlot);
      if (ex && ex.length >= 8) needles.push(ex);
    }
    const bodyHit = needles.length
      ? (a) => { const A = String(a), R = String(reply); return needles.some(n => A.includes(n) && R.includes(n)); }
      : () => false;
    const hits = assistants.filter(a => this._similarEnough(a, reply) || bodyHit(a)).length;
    if (hits < 2) return reply;
    act.memory.loop_breaks = (Number(act.memory.loop_breaks) || 0) + 1; // 防呆：熔断计数
    const known = NEEDED_FIELDS.filter(f => act.needs[f] && act.needs[f].value)
      .map(f => `「${act.needs[f].value}」`).join('、');
    const recite = known ? `咱对下账：目前记下的是${known}。` : '目前还没记下啥，从头说也行。';
    const slot = askedSlot && NEEDED_FIELDS.includes(askedSlot) ? askedSlot : this.missingFields(act)[0];
    const ask = slot ? `就差${FIELD_LABEL[slot]}还没定——${this._probeExample(slot)}，挑一个或者直接打字。` : '';
    const broken = `${recite}${ask}`;
    if (this._similarEnough(assistants[assistants.length - 1], broken)) return `${broken}（换个方式说：你只要回我答案本身就行）`;
    return broken;
  }

  /** 兜底选择器：从 FALLBACK_POOL 轮换（用于 L0/L2/L4 兜底与异常兜底） */
  _pickFallback(act) {
    return this._rotateReply(act, null, FALLBACK_POOL);
  }

  /** 接住语轮换（2026-10-05 循环压测修复）：_rotateReply 比对的是「catch+问句」整条合成串，
   *  池内短句永远 ≠ 合成串 → 每轮都选回同一条 → 四连同文罐头。改按前缀比对：
   *  上一条回复以某接住语开头 → 换下一条。 */
  _rotateCatchLine(act) {
    const last = act.messages[act.messages.length - 1];
    const lastContent = last && last.role === 'assistant' ? String(last.content || '') : '';
    const hit = FALLBACK_CATCH_POOL.find(p => !lastContent.startsWith(p));
    return hit || FALLBACK_CATCH_POOL[act.messages.length % FALLBACK_CATCH_POOL.length];
  }

  /**
   * 护栏替换兜底（09-30 报告 P1-3 修复）：旧 FALLBACK_POOL 完整句内嵌「问受众」固定问句，
   * 替换主回复后与 B4 chips 错位、且重复问已填槽。改为：无问句接住语 + 按 B4 当前缺口单点追问
   * （ask_count 感知，不重复问已填槽），返回 { reply, slot } 供调用方重挂同源 chips。
   * 冲突轮保持冲突槽（C6 核实语义不丢）；四槽全满 → 收口引导（不问）。
   */
  _fallbackWithProbe(act, question, conflictsNew) {
    if (question && question.kind === 'conflict' && question.slot) {
      const c = (conflictsNew || [])[0];
      const ask = (c && c.old && c.new)
        ? this._appendConflictAsk('', question, [c])
        : this._probe(act, question.slot);
      return { reply: `${this._rotateCatchLine(act)}${ask}`, slot: question.slot };
    }
    const miss = this.missingFields(act);
    if (!miss.length) return { reply: this._replyFresh(act, this._readyLine(act), FALLBACK_CATCH_POOL), slot: null };
    const slot = this._nextProbeSlot(act);
    return { reply: `${this._rotateCatchLine(act)}${this._probe(act, slot)}`, slot };
  }

  /**
   * 检测「模型自行核实旧值」（09-30 报告 P1-2/P1-3 变体）：模型在回复里口头核实某槽旧值
   * 却未提交 slot_updates 时，B4 预决策仍指向下一空槽 → 问句与 chips 错位。
   * 判定（窄口径防误伤）：回复的问句分句提到某已填槽的旧值（归一化子串），且带核实口吻词
   * （以哪个为准/刚说/又说/不一致/差别/冲突）。命中返回该槽，否则 null。
   */
  _detectVerifyReply(reply, act) {
    const norm = normalizeForGround;
    // lookbehind 切分保留终止符（？是分句依据，不能被 split 吃掉——否则问句分句恒为空）
    const sentences = String(reply || '').split(/(?<=[。！？；;!?])/);
    const qs = sentences.filter(s => /[?？]\s*$/.test(s));
    if (!qs.length) return null;
    const qText = qs.join(' ');
    if (!/(哪个为准|以哪个|哪个对|刚说|又说|不一致|不一样|差别|冲突|为准)/.test(qText)) return null;
    for (const s of NEEDED_FIELDS) {
      const cur = act.needs[s];
      const v = cur && cur.value ? norm(cur.value) : '';
      if (v.length < 4) continue;
      if (qs.some(q => norm(q).includes(v))) return { slot: s };
    }
    return null;
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
  _stubReply(act, userText, question, conflictsNew) {
    // 澄清轮形态（C6.5②，2026-10-03 裁决）：真冲突轮只发澄清问句＋冲突 chips——
    // 不复述全量、不引导确认、同轮不再问别的（B4 一轮一问；S1/S2 同规，S2 引导确认让位）
    if (question && question.kind === 'conflict' && question.slot) {
      return { reply: this._conflictAskLine(act, question, conflictsNew), asked: true };
    }
    const nonInfo = isNonInfo(userText);
    const probeSlot = question && question.slot;
    if (act.stage === 'S0') {
      // 阶段推进统一由 _advanceStage 负责；此处只产出首轮澄清话术
      if (probeSlot) return { reply: this._probe(act, probeSlot), asked: true };
      return { reply: this._replyFresh(act, this._readyLine(act), FALLBACK_POOL), asked: false };
    }
    if (act.stage === 'S1') {
      if (nonInfo) {
        return { reply: this._replyFresh(act, '没事，这块本来就乱。你就想着「谁快丢了、想让他们回来干啥」就行，别的我来帮你理。', FALLBACK_POOL), asked: false };
      }
      if (!probeSlot) return { reply: this._replyFresh(act, this._readyLine(act), FALLBACK_POOL), asked: false };
      return { reply: this._probe(act, probeSlot), asked: true };
    }
    if (act.stage === 'S2') {
      // 对齐 / 确认 / 否认；对话里不暴露字段（字段只在确认标签出现）
      // Wave 2：确认动作走 /confirm 端点（先建码后出卡），聊天里的「对/生成」只做引导
      // 卡感知（10-05）：act.plan_card 存在 = 卡在屏上可引用；降级轮卡未产出（剧本 #13），
      // 话术不得引用不存在的卡/按钮——诚实说等恢复再摆卡。
      const hasCard = Boolean(act.plan_card);
      const idlePool = hasCard ? S2_IDLE_POOL : S2_IDLE_POOL_NO_CARD;
      const t = userText.trim();
      const deny = /不对|错了|说错|弄错|搞错|改|不是|纠正|重新|等下|等等|再想想/.test(t);
      if (deny) return { reply: hasCard
        ? '好，哪点要改？四样都在下面确认卡里，说改哪样就行，其它对的我留着。'
        : '好，哪点要改？直接说改哪样、改成啥，其它对的我先留着。', asked: false };
      if (this.missingFields(act).length === 0) {
        const confirm = /对|是的|可以|确认|没问题|ok|好|行|就这样|按这|配吧|就这么?配|generate|生成|出方案|方案|配置/.test(t.toLowerCase());
        if (confirm) return { reply: hasCard
          ? '好，四样都核对齐了。点下面的「确认」按钮，我去你的店铺创建折扣码并生成方案卡。'
          : '好，四样我都记下了，哪样想再改直接说。等我这边恢复稳了，就把确认卡给你摆出来，到时点确认就开配。', asked: false };
        // 满卡非确认输入 → 待确认专用池（10-05：原 FALLBACK_POOL 完整句带罐头接住语且重问已填槽）
        return { reply: this._replyFresh(act, idlePool[0], idlePool), asked: false };
      }
      if (nonInfo) {
        return { reply: this._replyFresh(act, '没事，咱不急。' + (hasCard ? '方案在下面确认卡里，想调哪样直接说。' : '哪样想调直接说，等我恢复稳了就给你出确认卡。'), idlePool), asked: false };
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
  _readyLine(act) {
    // 卡感知（10-05 用户实测：降级会话整段引用「确认卡」但剧本 #13 降级不出卡 → 话术撒谎）。
    // act.plan_card 存在 = 之前在线轮已产出、卡在屏上 → 可引用；否则诚实说等恢复再摆卡。
    if (act && act.plan_card) return '四样都齐了。我帮你按这个配一封挽回邮件，你在下面确认卡里核对一遍，没问题就点确认。';
    return '四样都齐了——受众、挽回原因、钩子、目标我都记下了。哪样想改直接说；等我这边恢复稳了，就把确认卡给你摆出来。';
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
  async _aiCoach(act, userText, runtime, onReplyToken, preProbe, preConflict = null) {
    const promptNeeds = plainNeeds(act.needs);
    if (!promptNeeds.offer && runtime.agentProfile.default_offer) {
      promptNeeds.offer = runtime.agentProfile.default_offer;
    }
    const missing = preConflict ? [] : (preProbe ? [preProbe] : []);
    const context = buildCoachContext({
      act,
      userText,
      needs: promptNeeds,
      stage: act.stage,
      missing,
      conflict: preConflict,
      chips: preConflict
        ? conflictChips(preConflict.slot)
        : (preProbe ? (SLOT_CHIPS[preProbe] || []) : []),
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
  CORRECTION_TONE_RE, SLOT_CHIPS, valueGroundedInText, clampNeedValue, looksLikeInjection,
  BATCH_STATUS_RE, LOCALE_FORCE_RE
};
