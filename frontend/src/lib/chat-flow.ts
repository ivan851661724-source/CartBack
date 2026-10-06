import type { Act, Chips, Checklist } from './types';
import { filledCount } from './needs';

const EXIT_CHIPS = ['好，帮我写一封', '介绍一下其他功能', '其他需求'];

export function conversationNumber(acts: Pick<Act, 'id' | 'created_at'>[], id?: string) {
  return [...acts].sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || a.id.localeCompare(b.id)).findIndex(a => a.id === id) + 1;
}

export function planSendState(checklist?: Checklist | null) {
  // 复测 10-06 P2：无核对单（刷新恢复尚未拉回 / 拉取失败）不放行发送——fail-safe，
  // 由 AppProvider 恢复后用 GET /api/act/:id/checklist 现算补齐
  if (!checklist || !Array.isArray(checklist.items)) {
    return { items: [], failItems: [], canSend: false as const, scheduled: false };
  }
  const scheduled = Boolean(checklist.items.some(i => i.gate === 'window' && !i.pass));
  const items = checklist.items.filter(i => i.gate !== 'unsubscribe').map(i => i.gate === 'window'
    ? { ...i, pass: true, label: '定时发送', reason: undefined }
    : i);
  const failItems = items.filter(i => !i.pass && i.blocking !== false);
  return { items, failItems, canSend: !failItems.length, scheduled };
}

export function hasUnresolvedConflicts(act?: Act | null): boolean {
  return Boolean(act?.memory?.conflicts?.length);
}

export function preparedStateFor(act?: Act | null) {
  return act?.flow_version === 6 && act.stage === 'S3' && act.planCard
    ? { actId: act.id, planCard: act.planCard, checklist: null, holdout: null }
    : null;
}

export function confirmationRecoveryFor(act?: Act | null): { reason: string; options: string[] } | null {
  if (act?.flow_version === 6 && act.flow_state?.resource_error) return { reason: act.flow_state.resource_error, options: ['重试建码', '改用店内现成码', '改发无钩子提醒信'] };
  if (act?.stage !== 'S2' || act.code_status !== 'failed' || act.planCard || hasUnresolvedConflicts(act)) return null;
  return { reason: '上次折扣码创建失败，请重试、使用店内现成码，或改发无钩子提醒信。', options: ['重试建码', '改用店内现成码', '改发无钩子提醒信'] };
}

export function replyChipsFor(act: Act | null, chips: Chips, askedSlot: string | null): Chips {
  if (act?.flow_version === 6) return chips.filter(c => !EXIT_CHIPS.includes(c));
  const ready = filledCount(act?.needs) === 4 && !hasUnresolvedConflicts(act);
  const filtered = chips.filter(c => ready || !EXIT_CHIPS.includes(c));
  return ready && act?.stage === 'S2' && act.planCard && !askedSlot && filtered.length === 0
    ? EXIT_CHIPS : filtered;
}

export function mergeReplyAct(act: Act, reply: { reply: string; act?: Act; stage?: Act['stage']; needs?: Act['needs']; planCard?: Act['planCard'] }): Act {
  const current = reply.act?.id === act.id ? reply.act : act;
  return {
    ...current,
    stage: reply.stage ?? current.stage,
    needs: reply.needs ?? current.needs,
    messages: current !== act ? current.messages : [...act.messages, { role: 'assistant', content: reply.reply }],
    planCard: reply.planCard === undefined ? current.planCard : reply.planCard,
  };
}
