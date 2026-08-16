'use client';

import type { Message } from '@/lib/types';
import { NavChat } from '@/components/ui/icons';

/** 单条对话气泡：agent（品牌橙头像）或 user（靛蓝头像「我」） */
export default function MessageBubble({ m }: { m: Message }) {
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
      <div className="bubble">{m.content}</div>
    </div>
  );
}
