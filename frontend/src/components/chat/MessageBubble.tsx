'use client';

import type { Message } from '@/lib/types';
import { NavChat } from '@/components/ui/icons';

/** 单条对话气泡：agent（品牌橙头像）或 user（靛蓝头像「我」）；badge 可选（如 E1 拦截轮「建议」角标） */
export default function MessageBubble({ m, badge }: { m: Message; badge?: string }) {
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
      </div>
    </div>
  );
}
