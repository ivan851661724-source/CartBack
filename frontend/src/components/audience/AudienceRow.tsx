'use client';

import type { Audience } from '@/lib/types';
import Tag from '@/components/ui/Tag';

/** 受众机会行：画像摘要 + 弃购/预估 + 「去聊这拨人」—— 对应 app.js renderAud 内 .opp。 */
export default function AudienceRow({ a, onOpen, onGo }: { a: Audience; onOpen: () => void; onGo: () => void }) {
  const urg = a.urgencyDays != null ? `${a.urgencyDays} 天紧迫` : '—';
  return (
    <div className="opp" onClick={onOpen}>
      <div className="av">{(a.name || '?').slice(0, 1)}</div>
      <div className="who">
        <div className="n">{a.name || '—'}</div>
        <div className="e">{a.email || ''}</div>
      </div>
      <div className="sig">
        <Tag kind="intent">{a.intent || ''}</Tag>
        <Tag kind={a.risk === '高' ? 'risk' : 'gray'}>风险 {a.risk || ''}</Tag>
        <Tag kind="price">价敏 {a.price || ''}</Tag>
        <Tag kind="brand"><span className="tdot" />{urg}</Tag>
      </div>
      <div className="money">
        <div className="ab">弃购额 ¥{(+a.abandoned_value || 0).toFixed(0)}</div>
        <div className="gmv">¥{(+a.estGmv || 0).toFixed(0)}</div>
        <div className="ab" style={{ fontSize: '9.5px' }}>预估回流</div>
      </div>
      <button className="btn sm primary go" onClick={(e) => { e.stopPropagation(); onGo(); }}>去聊这拨人</button>
    </div>
  );
}
