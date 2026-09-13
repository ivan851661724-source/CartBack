/**
 * CartBack v3 前端常量与纯函数 —— 1:1 移植自 app.js 顶部（与引擎 extractNeeds / server matchAudienceByDesc 口径对齐）。
 */

/** 4 项需求字段：[key, 中文标签]（IGDE 静默采集） */
export const FIELDS: [keyof import('./types').Needs, string][] = [
  ['audience', '针对谁'],
  ['pain', '为什么挽回'],
  ['goal', '要什么结果'],
  ['offer', '给什么钩子'],
];

/**
 * 初始引导：品牌基础信息 10 项（快捷描述 chip + 右侧需求收集 checklist 共用）。
 * - msg：点击 chip 时发给助手的那句完整话（驱动 LLM 对话）
 * - val：checklist 右侧展示的短值（具体填充内容，对齐 Figma NEED_POINTS.val）
 */
export const BRAND_POINTS: { key: string; label: string; msg: string; val: string }[] = [
  { key: 'brandName', label: '品牌名称', msg: '我的品牌叫 Leo\'s PhoneCase，专门做手机壳的', val: "Leo's PhoneCase" },
  { key: 'category', label: '品牌类目', msg: '我们主要做手机配件，主打手机壳和贴膜', val: '手机配件 · 手机壳/贴膜' },
  { key: 'aov', label: '客单价', msg: '客单价大概 30-50 美元，手机壳为主', val: '$30-50' },
  { key: 'sendTime', label: '发送时段', msg: '我想在晚上 8 点发送挽回邮件', val: '20:00' },
  { key: 'audience', label: '目标受众', msg: '我要挽回加购未付的客户，主要是 25-35 岁年轻人', val: '加购未付 · 25-35岁' },
  { key: 'pain', label: '挽回原因', msg: '他们加购了但没付款，可能是价格或运费问题', val: '价格/运费阻碍' },
  { key: 'discount', label: '折扣力度', msg: '我想给 8 折优惠，再加免邮费', val: '8折 + 免邮' },
  { key: 'product', label: '产品特色', msg: '我们手机壳主打防摔设计，有 50 多种图案可选', val: '防摔 · 50+图案' },
  { key: 'goal', label: '营销目标', msg: '希望他们回来完成购买，顺便看看新品', val: '回访复购' },
  { key: 'frequency', label: '发送频率', msg: '先发一封试试，效果好的话 3 天后再发第二封', val: '首封 + 3天追发' },
];

/**
 * 初始引导：纯意图快捷词 10 项（guideStyle='safe' 用，真实商家版）。
 * 只表达挽回意图，不带任何具体品牌/品类/价格，避免示例数据覆盖商家真实品牌（P0-4）。
 * 点击行为由 ChatView 控制：全新会话直发，已有上下文只填入输入框待确认。
 */
export const INTENT_POINTS: { key: string; label: string; msg: string }[] = [
  { key: 'target', label: '挽回对象', msg: '我想挽回加购了还没付款的客户' },
  { key: 'reason', label: '流失原因', msg: '他们加购后一直没付款，可能是忘了或者还在犹豫' },
  { key: 'goal', label: '挽回目标', msg: '希望他们回来把订单完成' },
  { key: 'hook', label: '优惠钩子', msg: '想给个折扣或者免邮的钩子，具体力度你帮我建议' },
  { key: 'browse', label: '浏览召回', msg: '也想召回看过商品但没下单的人' },
  { key: 'dormant', label: '老客唤醒', msg: '还有一批很久没来的老客，想唤醒一下' },
  { key: 'timing', label: '发送时机', msg: '发送时机什么时候合适？' },
  { key: 'tone', label: '话术风格', msg: '语气自然一点，别太像促销' },
  { key: 'cadence', label: '发送节奏', msg: '先发一封试试，效果好再安排跟进' },
  { key: 'objective', label: '效果目标', msg: '主要目标是把流失的订单捞回来' },
];


export const STAGE_TXT: Record<string, string> = {
  S0: 'S0 接入',
  S1: 'S1 澄清',
  S2: 'S2 对齐',
  S3: 'S3 执行',
};

export const CHAT_PLACEHOLDER = '说清楚你想挽回谁、为啥、要什么结果…';

/**
 * 初始引导各步气泡文案（与原 Topbar HintPill 一致）。onboardingStep 0-3 对应步骤 1-4。
 * 由 GuideOverlay 复用。
 */
export const ONBOARDING_TEXTS: Record<number, string> = {
  0: '点击左侧 10 个快捷描述，告诉助手你的品牌信息。',
  1: '需求已收集完整！点「可以，去发」生成邮件',
  2: '点左侧「数据看板」查看点击 / 转化 / GMV / ROI。',
  3: '完整闭环已跑通！',
};


/** 邮件生命周期进度段：[草稿完成, 发送完成, 触达完成]（recovering 第三段为 ok 色） */
export const SEG_MAP: Record<string, number[]> = {
  draft: [1, 0, 0],
  queued: [1, 0, 0],   // 202 已入队，发送中
  sending: [1, 0, 0],
  sent: [1, 1, 0],
  recovering: [1, 1, 1],
  timeout: [1, 1, 0],
  failed: [1, 0, 0],
};

/** 模块 tab key → 顶栏面包屑文案 */
export const TAB_LABELS: Record<string, string> = {
  chat: '助手',
  mail: '邮件配置',
  data: '数据看板',
  aud: '受众',
  comp: '竞品',
  set: '设置',
};

/** 意向 → 方案卡受众标签（与引擎 extractNeeds 口径对齐） */
export function intentToAudience(intent: string | undefined): string {
  const t = intent || '';
  if (/加购/.test(t)) return '加购未付客户';
  if (/弃购|未付/.test(t)) return '弃购 / 下单未付客户';
  if (/浏览/.test(t)) return '浏览未买客户';
  if (/沉睡|流失/.test(t)) return '沉睡 / 流失老客';
  return '高意向流失人群';
}

/** 受众意向是否匹配方案卡受众描述（与 server matchAudienceByDesc 一致） */
export function matchAudienceDesc(intent: string, desc: string | undefined): boolean {
  const d = (desc || '').toLowerCase();
  if (/弃购|未付/.test(d)) return /弃购|未付|下单未付/.test(intent);
  if (/加购/.test(d)) return /加购/.test(intent);
  if (/浏览/.test(d)) return /浏览/.test(intent);
  if (/老客|沉睡|流失/.test(d)) return /老客|沉睡|流失/.test(intent);
  return true;
}
