'use client';

import type { PlanCard } from '@/lib/types';
import { FIELDS } from '@/lib/constants';
import { Spark, Check } from '@/components/ui/icons';

/** 需求收集确认卡（进对话流）—— 对应 app.js pushConfirm */
export default function ConfirmCard({
  card, onConfirm, onReconsider,
}: {
  card: PlanCard;
  onConfirm: () => void;
  onReconsider: () => void;
}) {
  const rows = FIELDS.map(([k, label]) => {
    const v = (k === 'offer' ? (card.discount || card.offer) : (card as any)[k]) || '';
    return (
      <div className="c-row" key={k}>
        <span className="ck"><Check /></span>
        <span className="k">{label}</span>
        <span className="v">{v}</span>
      </div>
    );
  });
  const n = Object.values(card || {}).filter(v => v && typeof v === 'string').length;

  return (
    <div className="confirm">
      <div className="c-head">
        <span className="spark"><Spark /></span>
        <span className="ct">需求已收集完整！这样配置可以吗？</span>
        <span className="cnt"><b>{Math.max(4, n)}</b><span>/4</span></span>
      </div>
      <div className="c-progress"><i /></div>
      <div className="c-list">{rows}</div>
      <div className="c-actions">
        <button className="btn primary" onClick={onConfirm}>可以，去发</button>
        <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
      </div>
    </div>
  );
}
