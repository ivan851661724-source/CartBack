'use client';

import { useId, useMemo } from 'react';

function createSeededRandom(seed: number) {
  let state = (Math.trunc(seed) >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** KPI 迷你趋势线 —— 固定种子确保服务端渲染与客户端 hydration 完全一致。 */
export default function Sparkline({ seed, color }: { seed: number; color: string }) {
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const data = useMemo(() => {
    const random = createSeededRandom(seed);
    const pts: number[] = [];
    let v = seed;
    for (let i = 0; i < 11; i++) { v = v * (0.84 + random() * 0.32); pts.push(Math.round(v)); }
    const min = Math.min(...pts), max = Math.max(...pts), w = 64, h = 22;
    const step = (max - min) || 1;
    const coords = pts.map((p, i) => `${(i / (pts.length - 1)) * w},${h - 3 - ((p - min) / step) * (h - 9)}`);
    const last = coords[coords.length - 1].split(',');
    return { coords, last };
  }, [seed]);

  return (
    <svg className="spark" width={64} height={22} viewBox="0 0 64 22">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={color} stopOpacity=".45" />
          <stop offset="100%" stopColor={color} stopOpacity="1" />
        </linearGradient>
      </defs>
      <polyline points={data.coords.join(' ')} fill="none" stroke={`url(#${gradientId})`} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={data.last[0]} cy={data.last[1]} r="2.2" fill={color} stroke="#fff" strokeWidth="1" />
    </svg>
  );
}
