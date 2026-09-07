'use client';

import { useEffect, useState } from 'react';
import type { PlanCard } from '@/lib/types';
import { api } from '@/lib/api';

/** 受众圈选条件（后端 /api/audience/preview：与发送端同一过滤口径） */
interface AudienceConditions {
  desc: string;
  filters: { field: string; op: string; value: string | number }[];
  matchedCount: number;
  estGmv: number;
}

/** 需求收集确认卡（进对话流）——含受众圈选条件核对（PRD §2：确认卡补受众圈选条件展示） */
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
  const [conditions, setConditions] = useState<AudienceConditions | null>(null);
  const [cardsCount, setCardsCount] = useState(0);

  useEffect(() => {
    let alive = true;
    // 受众圈选条件预览（失败静默：条件区隐藏，不阻塞确认）
    api<AudienceConditions>('/api/audience/preview', {
      method: 'POST',
      body: JSON.stringify({ audience: card.audience }),
    }).then((r) => { if (alive && r && r.filters) setConditions(r); }).catch(() => {});
    // 竞品套路卡数量（>0 时展示「生成时参考」提示）
    api<{ cards: unknown[] }>('/api/strategy-cards')
      .then((r) => { if (alive) setCardsCount((r.cards || []).length); })
      .catch(() => {});
    return () => { alive = false; };
  }, [card.audience]);

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

      {/* 受众圈选条件（与发送端同口径：真实邮箱 + 未退信 + 30 天挽回窗口） */}
      {conditions && (
        <div className="c-list" style={{ marginTop: 6, paddingTop: 8, borderTop: '1px dashed rgba(125,125,125,.25)' }}>
          <div className="c-row">
            <span className="ck">◎</span>
            <span className="k">圈选条件</span>
            <span className="v">{conditions.filters.map((f) => String(f.value)).join(' · ')}</span>
          </div>
          <div className="c-row">
            <span className="ck">◎</span>
            <span className="k">预计触达</span>
            <span className="v">{conditions.matchedCount} 人 · 预估可挽回 ¥{conditions.estGmv}（预估）</span>
          </div>
          <div className="c-row">
            <span className="ck">◎</span>
            <span className="k">变体</span>
            <span className="v">按 3 类人群生成 3 个变体（价格敏感 / 高意向 / 标准）</span>
          </div>
          {cardsCount > 0 && (
            <div className="c-row">
              <span className="ck">◎</span>
              <span className="k">打法参考</span>
              <span className="v">生成时将参考 {cardsCount} 张竞品套路卡</span>
            </div>
          )}
        </div>
      )}

      <div className="c-actions">
        <button className="btn primary" onClick={onConfirm}>可以，去发</button>
        <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
      </div>
    </div>
  );
}
