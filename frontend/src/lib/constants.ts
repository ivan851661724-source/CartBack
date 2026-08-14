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

export const STAGE_TXT: Record<string, string> = {
  S0: 'S0 接入',
  S1: 'S1 澄清',
  S2: 'S2 对齐',
  S3: 'S3 执行',
};

export const CHAT_PLACEHOLDER = '说清楚你想挽回谁、为啥、要什么结果…';

/** 邮件生命周期进度段：[草稿完成, 发送完成, 触达完成]（recovering 第三段为 ok 色） */
export const SEG_MAP: Record<string, number[]> = {
  draft: [1, 0, 0],
  sending: [1, 0, 0],
  sent: [1, 1, 0],
  recovering: [1, 1, 1],
  timeout: [1, 1, 0],
  failed: [1, 0, 0],
};

/** 5 个模块 tab key → 顶栏面包屑文案 */
export const TAB_LABELS: Record<string, string> = {
  chat: '助手',
  mail: '邮件配置',
  data: '数据看板',
  aud: '受众',
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
