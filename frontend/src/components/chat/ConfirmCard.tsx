'use client';

import type { PlanCard } from '@/lib/types';

/** 需求收集确认卡（进对话流） */
export default function ConfirmCard({
  card, onConfirm, onReconsider,
}: {
  card: PlanCard;
  onConfirm: () => void;
  onReconsider: () => void;
}) {
  const rows = [
    ['audience', '针对谁', card.audience],
    ['pain', '为什么挽回', card.pain],
    ['goal', '要什么结果', card.goal],
    ['offer', '给什么钩子', card.discount || card.offer],
  ];

  const n = Object.values(card || {}).filter(v => v && typeof v === 'string').length;

  return (
    <div className="confirm">
      <div className="c-head">
        <span className="spark">⚡</span>
        <span className="ct">需求已收集完整！这样配置可以吗？</span>
        <span className="cnt"><b>{Math.max(4, n)}</b><span>/4</span></span>
      </div>
      <div className="c-progress"><i /></div>
      <div className="c-list">
        {rows.map(([k, label, v]) => (
          <div className="c-row" key={k}>
            <span className="ck">✓</span>
            <span className="k">{label}</span>
            <span className="v">{v || '—'}</span>
          </div>
        ))}
      </div>
      <div className="c-actions">
        <button className="btn primary" onClick={onConfirm}>可以，去发</button>
        <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
      </div>
    </div>
  );
}