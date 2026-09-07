'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/state/AppProvider';

interface TagEffectRow {
  tag_type: string; tag_value: string; sample: number;
  converts: number; gmv: number; convert_rate: number | null;
}

const TAG_TYPE_LABEL: Record<string, string> = {
  intent: '意向',
  price_sensitivity: '价格敏感',
  category_like: '品类偏好',
};

/** 标签效果区块（PRD §5 UI：标签飞轮资产的价值可见——Top 区块 + 样本数） */
export default function TagEffectPanel() {
  const [rows, setRows] = useState<TagEffectRow[]>([]);
  const booted = useApp().booted;

  // 视图常驻挂载：等 bootstrap（本地令牌）就绪再拉数据
  useEffect(() => {
    if (!booted) return;
    let alive = true;
    api<{ effect: TagEffectRow[] }>('/api/tags/effect')
      .then((r) => { if (alive) setRows((r.effect || []).slice(0, 5)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [booted]);

  if (!rows.length) return null; // 还没有标签数据时整块隐藏（不打扰）

  return (
    <div className="glass-card" style={{ padding: '17px 19px' }}>
      <div className="card-title"><span className="tline" />标签效果 · Top 5</div>
      <div style={{ fontSize: 12, opacity: 0.6, margin: '6px 0 10px' }}>
        转化的顾客自动给标签加权（越用越准）——样本不足的标签不显示转化率
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {rows.map((r) => (
          <div key={`${r.tag_type}=${r.tag_value}`} style={{ padding: '8px 10px', borderRadius: 10, background: 'rgba(125,125,125,.08)' }}>
            <div style={{ fontSize: 12, opacity: 0.65 }}>
              {TAG_TYPE_LABEL[r.tag_type] || r.tag_type} = {r.tag_value}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {r.convert_rate == null ? '—' : `${Math.round(r.convert_rate * 100)}%`}
              <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.6 }}> 转化率</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              样本 {r.sample} · 转化 {r.converts} · ¥{r.gmv}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
