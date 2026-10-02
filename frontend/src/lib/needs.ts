/**
 * needs 三态取值助手 —— 唯一允许读取 act.needs 槽位的地方。
 * 新契约：每槽 null | { value, source: 'explicit'|'inferred', at }；
 * 兼容旧数据：槽位可能是纯字符串（typeof 判断），读取一律走 needsValue()。
 * 槽位名已随后端契约 pain→reason（PlanCard.pain 除外，那是方案卡字段）。
 */
import type { Needs } from './types';

/** 四槽固定顺序与中文槽名（missingSlots 返回该数组） */
export const SLOT_ORDER = ['audience', 'reason', 'offer', 'goal'] as const;
export type SlotKey = (typeof SLOT_ORDER)[number];
export const SLOT_LABELS: Record<SlotKey, string> = {
  audience: '受众',
  reason: '挽回原因',
  offer: '优惠',
  goal: '目标',
};

/** 取槽位文本值：兼容 { value } 对象与旧纯字符串；空槽/空值返回 '' */
export function needsValue(slot: unknown): string {
  if (!slot) return '';
  if (typeof slot === 'string') return slot;
  if (typeof slot === 'object' && typeof (slot as { value?: unknown }).value === 'string') {
    return (slot as { value: string }).value;
  }
  return '';
}

/** 取槽位来源：新契约对象才有（'explicit' | 'inferred'），旧字符串/空槽返回 null */
export function needsSource(slot: unknown): 'explicit' | 'inferred' | null {
  if (slot && typeof slot === 'object') {
    const s = (slot as { source?: unknown }).source;
    if (s === 'explicit' || s === 'inferred') return s;
  }
  return null;
}

function filledKeys(needs?: Needs | null): SlotKey[] {
  if (!needs) return [];
  return SLOT_ORDER.filter((k) => Boolean(needsValue((needs as Record<string, unknown>)[k])));
}

/** 已填槽数（0-4）：空对象/空字符串值都算未填 */
export function filledCount(needs?: Needs | null): number {
  return filledKeys(needs).length;
}

/** 未填槽位的中文槽名数组，如 ['优惠', '目标']；全满返回 [] */
export function missingSlots(needs?: Needs | null): string[] {
  if (!needs) return SLOT_ORDER.map((k) => SLOT_LABELS[k]);
  return SLOT_ORDER
    .filter((k) => !needsValue((needs as Record<string, unknown>)[k]))
    .map((k) => SLOT_LABELS[k]);
}

/** 槽位状态段（无数字）：如「受众✅挽回原因✅」；全空返回 '' */
function filledMarks(needs?: Needs | null): string {
  return filledKeys(needs)
    .map((k) => `${SLOT_LABELS[k]}✅`)
    .join('');
}

/**
 * 任务式进度全文（Topbar HintPill title / aria 用）：
 * 「已收集 2/4：受众✅挽回原因✅，还差：优惠、目标」；全满收尾「信息齐了」。
 */
export function progressText(needs?: Needs | null): string {
  const filled = filledCount(needs);
  const marks = filledMarks(needs);
  const missing = missingSlots(needs);
  const tail = missing.length ? `，还差：${missing.join('、')}` : '，信息齐了';
  return `已收集 ${filled}/4：${marks}${tail}`;
}

/** 任务式进度去数字版（Topbar 展开态正文用，数字 n/4 由 hp-n 单独承担，避免重复） */
export function progressTail(needs?: Needs | null): string {
  return progressText(needs).replace(/^已收集 \d\/4：/, '');
}

/**
 * 会话列表用无数字状态文案（HistoryModal 用）：
 * 「受众✅ · 挽回原因✅ · 还差：优惠、目标」/「需求已齐」/「尚未收集」。
 */
export function slotStatusText(needs?: Needs | null): string {
  const missing = missingSlots(needs);
  if (missing.length === 0) return '需求已齐';
  const filledLabels = filledKeys(needs).map((k) => `${SLOT_LABELS[k]}✅`);
  if (filledLabels.length === 0) return '尚未收集';
  return `${filledLabels.join(' · ')} · 还差：${missing.join('、')}`;
}
