'use client';

import { useEffect, useRef, useState } from 'react';
import type { Kpis } from '@/lib/types';
import Sparkline from './Sparkline';

/** 数字滚动：仅「¥前缀 + 纯整数」生效（移植 countUp，cubic ease-out 850ms）。 */
function CountUp({ value, brand }: { value: string; brand: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    const m = String(value).match(/^(\D*)([\d,]+)$/);
    if (!m) { setDisplay(value); return; }
    const prefix = m[1];
    const target = parseInt(m[2].replace(/,/g, ''), 10);
    if (isNaN(target) || target <= 0) { setDisplay(value); return; }
    let raf = 0; const t0 = performance.now(); const dur = 850;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const v = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (ref.current) ref.current.textContent = prefix + v.toLocaleString();
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <div ref={ref} className={`k-n num${brand ? ' brand' : ''}`} data-count={value}>{display}</div>;
}

/** KPI 六宫格 + 迷你趋势线 + 数字滚动 —— 对应 app.js renderData 的 kpis 段。 */
export default function KpiGrid({ k }: { k: Kpis }) {
  const kpis = [
    { l: '触达', v: String(k.sent || 0), dot: '#FF7F4D', brand: false, sparkSeed: 40 },
    { l: '打开率', v: ((k.openRate || 0) * 100).toFixed(1) + '%', dot: '#16A34A', brand: false, sparkSeed: 57 },
    { l: '点击率', v: ((k.clickRate || 0) * 100).toFixed(1) + '%', dot: '#16A34A', brand: false, sparkSeed: 74 },
    { l: '转化订单', v: String(k.convert || 0), dot: '#16A34A', brand: false, sparkSeed: 91 },
    { l: '回流 GMV', v: '¥' + (+k.gmv || 0).toFixed(0), dot: '#FF7F4D', brand: true, sparkSeed: 108 },
    { l: 'ROI', v: (k.roi || 0).toFixed(1) + '×', dot: '#FF7F4D', brand: true, sparkSeed: 125 },
  ];
  return (
    <div className="kpi-grid" id="kpis">
      {kpis.map((kp) => (
        <div className="kpi glass-card" key={kp.l}>
          <div className="k-l"><span className="kdot" style={{ background: kp.dot }} />{kp.l}</div>
          <CountUp value={kp.v} brand={kp.brand} />
          <div className="k-d">·</div>
          <Sparkline seed={kp.sparkSeed} color={kp.brand ? '#FF7F4D' : '#16A34A'} />
        </div>
      ))}
    </div>
  );
}
