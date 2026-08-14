'use client';

import type { Draft } from '@/lib/types';
import { SEG_MAP } from '@/lib/constants';
import Tag from '@/components/ui/Tag';

/** 邮件卡片（生命周期进度段）—— 对应 app.js renderDrafts 内卡片 */
export default function MailCard({ d, onOpen }: { d: Draft; onOpen: () => void }) {
  const seg = (SEG_MAP[d.status] || [1, 0, 0]).map((s, i) => (
    <div key={i} className={`seg${s ? ' fill' : ''}${s && d.status === 'recovering' ? ' ok' : ''}`} />
  ));
  return (
    <div className="mail-card glass-card" onClick={onOpen}>
      <div className="mc-top">
        <span className="mc-subj">{d.subject || ''}</span>
        <span className={`status-badge ${d.status}`}>{d.status}</span>
      </div>
      <div className="mc-meta">
        <span>触达 <b>{d.matchedCount || 0}</b> 人</span>
        <span>{d.sendTiming || '—'}</span>
      </div>
      <div className="mc-progress">{seg}</div>
      <div className="mc-step"><span>草稿</span><span>发送</span><span>触达</span><span>回流</span></div>
      <div className="mc-foot">
        <Tag kind="gray">{(d.locale || 'en').toUpperCase()} · 跟随收件人</Tag>
        <span className="mc-meta brand" style={{ margin: 0 }}><b>¥{(+(d.estGmv) || 0).toFixed(0)}</b></span>
      </div>
    </div>
  );
}
