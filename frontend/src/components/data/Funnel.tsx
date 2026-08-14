'use client';

import type { Kpis } from '@/lib/types';

/** 转化漏斗：发送 → 打开 → 点击 → 转化 —— 对应 app.js renderData 的 funnel 段。 */
export default function Funnel({ k }: { k: Kpis }) {
  const steps: [string, number][] = [['发送', k.sent || 0], ['打开', k.open || 0], ['点击', k.click || 0], ['转化', k.convert || 0]];
  const max = Math.max(k.sent || 0, 1);
  return (
    <div className="funnel" id="funnel">
      {steps.map(([l, v]) => {
        const pct = (v / max * 100).toFixed(0);
        return (
          <div className="f-row" key={l}>
            <span className="f-label">{l}</span>
            <div className="f-track">
              <div className="f-fill" style={{ width: `${Math.max(+pct, 4)}%` }}><span>{pct}%</span></div>
            </div>
            <span className="f-val num">{v}</span>
          </div>
        );
      })}
    </div>
  );
}
