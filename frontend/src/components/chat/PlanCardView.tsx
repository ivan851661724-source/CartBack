'use client';

import type { PlanCard } from '@/lib/types';
import { Arrow, Globe } from '@/components/ui/icons';

/** 方案卡（进对话流）—— 对应 app.js pushPlan。确认发送 → 生成草稿 + 发信 + sent banner。 */
export default function PlanCardView({
  card, onEdit, onSend, sending,
}: {
  card: PlanCard;
  onEdit: () => void;
  onSend: () => void;
  sending?: boolean;
}) {
  return (
    <div className="plan">
      <div className="p-top">
        <span className="pt-ic"><Arrow /></span>
        <span className="pt-t">{card.audience || ''} · 方案已生成</span>
        <span className="pt-s">{card.sendTiming || ''}</span>
      </div>
      <div className="p-body">
        <div className="p-subj">
          <svg className="pen" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          主题：{card.subject || ''}
        </div>
        <div className="p-body-text">{card.body || ''}</div>
        <div className="p-meta">
          <div className="pm"><div className="l">收件人</div><div className="v">{card.matchedCount || 0} 人</div></div>
          <div className="pm"><div className="l">折扣</div><div className="v">{card.discount || ''}</div></div>
          <div className="pm"><div className="l">优惠码</div><div className="v brand">{card.coupon || ''}</div></div>
        </div>
      </div>
      <div className="p-foot">
        <span className="lang"><Globe />语种跟随收件人：{(card.locale || 'en').toUpperCase()}</span>
        <button className="btn ghost sm" onClick={onEdit}>微调</button>
        <button className="btn primary sm" onClick={onSend} disabled={sending}>确认发送</button>
      </div>
    </div>
  );
}
