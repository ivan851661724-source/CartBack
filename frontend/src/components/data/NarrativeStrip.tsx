'use client';

import type { Kpis } from '@/lib/types';
import { Arrow } from '@/components/ui/icons';

/** 叙事条：本周回流 GMV / ROI / 明细 / 模式标签 —— 对应 flow.html .narrative + renderData。 */
export default function NarrativeStrip({ k, real }: { k: Kpis; real: boolean }) {
  const net = (+k.gmv || 0) - (+k.cost || 0);
  const sub = `${k.sent || 0} 封邮件 · 触达 ${k.sent || 0} 人 · 花费 ¥${(+k.cost || 0).toFixed(0)} · 净赚 ¥${net.toFixed(0)}`;
  return (
    <div className="narrative">
      <div className="nv-ic"><Arrow /></div>
      <div>
        <div className="nv-t">本周回流营收 <span className="big num">¥{(+k.gmv || 0).toFixed(0)}</span> · ROI <span className="big num">{(k.roi || 0).toFixed(1)}×</span></div>
        <div className="nv-s">{sub}</div>
      </div>
      <span className="tag tag-brand nv-tag"><span className="tdot" />{real ? '真实数据' : '演示数据'}</span>
    </div>
  );
}
