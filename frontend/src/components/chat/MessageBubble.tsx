'use client';

import type { Message } from '@/lib/types';
import { NavChat } from '@/components/ui/icons';
import { TOUR_IMG } from '@/lib/chat-flow';

/** 单条对话气泡：agent（品牌橙头像）或 user（靛蓝头像「我」）；badge 可选（如 E1 拦截轮「建议」角标）
 *  agent 气泡支持 F5 导览配图：内容命中 TOUR_IMG 任一句 → 文本下方渲染对应示意图（缺图 onError 隐藏） */
export default function MessageBubble({ m, badge }: { m: Message; badge?: string }) {
  const tourImg = m.role === 'assistant' && m.content
    ? Object.entries(TOUR_IMG).find(([line]) => m.content.includes(line))?.[1]
    : undefined;
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="avatar user">我</div>
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="msg agent">
      <div className="avatar agent"><NavChat /></div>
      <div className="bubble">
        {badge && (
          <div style={{ marginBottom: 4 }}>
            <span style={{
              fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '1px 8px',
              color: 'var(--muted)', background: 'var(--bg-input)', border: '.5px solid var(--line)',
            }}>{badge}</span>
          </div>
        )}
        {m.content}
        {tourImg && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={tourImg}
            alt="导览示意图"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
            style={{ display: 'block', marginTop: 8, maxWidth: 300, borderRadius: 8, border: '.5px solid var(--line)' }}
          />
        )}
      </div>
    </div>
  );
}
