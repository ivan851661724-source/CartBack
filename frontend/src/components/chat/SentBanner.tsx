'use client';

import type { Draft, SendResult } from '@/lib/types';
import { Check } from '@/components/ui/icons';

/** 发送成功横幅（进对话流）—— 对应 app.js pushSent */
export default function SentBanner({
  res, draft, onSeeFlow,
}: {
  res: SendResult;
  draft: Draft;
  onSeeFlow: () => void;
}) {
  const cost = +((res && (res as any).cost) || draft.cost || 0).toFixed(2);
  const gmv = +(draft.estGmv || 0).toFixed(2);
  const cur = draft.currency === 'USD' ? '$' : '¥';   // 新契约 estGmv 为 USD；旧数据缺省按 ¥
  return (
    <div className="sent-banner">
      <div className="sb-ic"><Check /></div>
      <div>
        <div className="sb-t">已触达 {(res && (res as any).recipients) || 0} 位顾客</div>
        <div className="sb-s">预计捞回 <b className="num">{cur}{gmv}</b> · 花费 ¥{cost} · 去看看回流 →</div>
      </div>
      <button className="btn sm primary sb-cta" onClick={onSeeFlow}>看回流</button>
    </div>
  );
}
