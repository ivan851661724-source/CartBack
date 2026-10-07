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
  // 时段外 / 频控全员被触达（带 retryAt）→ 服务端会自动预约到未来时刻，不算阻断：
  // 核对单内展示为「定时发送」通过项，按钮变「确认定时发送」（提交后 202 预约）
  const scheduled = Boolean(
    checklist.items.some(i => i.gate === 'window' && !i.pass) ||
    checklist.items.some(i => i.gate === 'frequency' && !i.pass && i.retryAt)
  );
  const items = checklist.items.filter(i => i.gate !== 'unsubscribe').map(i => {
    if (i.gate === 'window' && !i.pass) return { ...i, pass: true, label: '定时发送', reason: undefined };
    if (i.gate === 'frequency' && !i.pass && i.retryAt) return { ...i, pass: true, label: '定时发送（频控解除后自动发送）', reason: undefined };
    return i;
  });
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
  // 2026-10-07 话术对齐 UX 481-7578：出口 chips 以后端下发为准（开场与中段都带出口，不再按就绪态过滤）。
  // 保留两处既有契约的抑制：① 未解决冲突（C6.5② 裁决：澄清轮不引导确认，不混出口）；
  // ② 故障恢复态（v6 resource_error / S2 建码失败——恢复选项接管，不出出口）。
  // 就绪兜底：齐槽 + S2 + 有卡 + 本轮无追问 + 后端未发 chips 时注入出口三项。
  if (hasUnresolvedConflicts(act) || confirmationRecoveryFor(act)) {
    return chips.filter(c => !EXIT_CHIPS.includes(c));
  }
  const ready = filledCount(act?.needs) === 4;
  const nonExit = chips.filter(c => !EXIT_CHIPS.includes(c));
  if (ready && act?.stage === 'S2' && act.planCard && !askedSlot && nonExit.length === 0) return EXIT_CHIPS;
  return chips;
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

/** F5 导览配图（2026-10-07）：导览话术句 → 静态示意图映射（UX 406-2671 / 616-7875）。
 *  切图由设计导出放入 public/tour/ 即生效；缺图时 MessageBubble onError 隐藏不留白。
 *  只做展示映射——TOUR_SCRIPTS 与 blocked 挂起逻辑零改动。 */
export const TOUR_IMG: Record<string, string> = {
  '点击左侧邮件tab查看所有生成的历史邮件。': '/tour/mail-sidebar.png',
  '生成邮件预览后会出现对应的详情卡片，点击底部按钮选择你想进行的操作。': '/tour/mail-card.png',
  '点击左侧数据看板来查看过往邮件获单效果的数据统计。': '/tour/data-sidebar.png',
  '优先关注这一行，初步判断近期邮件获单效果。': '/tour/data-banner.png',
  '转化漏斗哪一栏的百分比掉得最多，就优先优化哪一环。': '/tour/data-funnel.png',
  '回流GMV，这个量化投放指标。': '/tour/data-trend.png',
};
