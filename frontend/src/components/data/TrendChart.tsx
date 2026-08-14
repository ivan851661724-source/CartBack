'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { TrendPoint } from '@/lib/types';

/** 7 日趋势 SVG 折线（面积 + 描线动画 + 末点脉冲）—— 对应 app.js renderTrendSVG。
 *  描线动画用 ref + getTotalLength；line 字符串作为 dep，trend 变化时重画。 */
export default function TrendChart({ trend }: { trend: TrendPoint[] | null }) {
  const lineRef = useRef<SVGPolylineElement>(null);

  const geo = useMemo(() => {
    const data = (trend || []).map((x) => x.gmv);
    if (!data || data.length < 2) return null;
    const max = Math.max(...data) || 1, w = 620, h = 150, pad = 8;
    const pts = data.map((v, i) => ({
      x: pad + (i * (w - pad * 2)) / (data.length - 1),
      y: h - (v / max) * (h - 30) - 10,
    }));
    const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${pad},${h} ${line} ${w - pad},${h}`;
    const last = pts[pts.length - 1];
    const grid: string[] = [];
    for (let g = 0; g < 4; g++) {
      const gy = h - ((g + 1) / 5) * (h - 26) - 10;
      grid.push(`<line x1="${pad}" y1="${gy.toFixed(1)}" x2="${w - pad}" y2="${gy.toFixed(1)}" stroke="rgba(148,163,184,.14)" stroke-width="1" stroke-dasharray="2 4"/>`);
    }
    return { line, area, last, grid, w, h, pad };
  }, [trend]);

  useEffect(() => {
    const ln = lineRef.current;
    if (!ln || !geo) return;
    const len = ln.getTotalLength();
    ln.style.strokeDasharray = String(len);
    ln.style.strokeDashoffset = String(len);
    ln.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)';
    requestAnimationFrame(() => requestAnimationFrame(() => { ln.style.strokeDashoffset = '0'; }));
  }, [geo]);

  if (!geo) return <div className="empty-note">暂无趋势数据</div>;
  return (
    <svg className="trend-chart" viewBox={`0 0 ${geo.w} ${geo.h}`} preserveAspectRatio="none" id="trendChart">
      <defs>
        <linearGradient id="aG4" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,127,77,.26)" />
          <stop offset="100%" stopColor="rgba(255,127,77,0)" />
        </linearGradient>
      </defs>
      <g dangerouslySetInnerHTML={{ __html: geo.grid.join('') }} />
      <polygon points={geo.area} fill="url(#aG4)" />
      <polyline ref={lineRef} id="trendLine" points={geo.line} fill="none" stroke="#FF7F4D" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1={geo.last.x} y1={geo.last.y} x2={geo.last.x} y2={geo.h} stroke="rgba(255,127,77,.35)" strokeWidth="1" strokeDasharray="3 3" />
      <circle cx={geo.last.x} cy={geo.last.y} r="3.5" fill="#FF7F4D" stroke="#fff" strokeWidth="2" />
      <circle cx={geo.last.x} cy={geo.last.y} r="8" fill="none" stroke="rgba(255,127,77,.25)" strokeWidth="1.5">
        <animate attributeName="r" values="5;11;5" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values=".8;0;.8" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
