'use client';

import { useApp } from '@/state/AppProvider';
import Modal from '@/components/ui/Modal';
import { Arrow } from '@/components/ui/icons';
import type { Act } from '@/lib/types';

const STAGE_LABEL: Record<string, string> = {
  S0: '刚开聊', S1: '收集中', S2: '收集中', S3: '方案就绪',
};

/** 会话摘要：首条用户消息截断；没有用户消息时用开场白兜底 */
function actTitle(act: Act): string {
  const firstUser = act.messages?.find(m => m.role === 'user');
  const text = (firstUser?.content || act.messages?.[0]?.content || '新对话').trim();
  return text.length > 26 ? text.slice(0, 26) + '…' : text;
}

function timeAgo(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 多会话 #2：历史会话列表 + 新建。当前会话高亮，streaming 中切换由 switchAct 自行拦截。 */
export default function HistoryModal() {
  const { acts, act, historyOpen, setHistoryOpen, switchAct, newConversation } = useApp();
  const sorted = [...acts].sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));

  return (
    <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="历史会话" width={480}>
      <div className="m-body">
        <button className="btn ghost sm hist-new" onClick={() => newConversation()}>
          <Arrow /> 新建会话
        </button>
        <div className="hist-list" role="list">
          {sorted.map(a => (
            <button
              key={a.id}
              role="listitem"
              className={`hist-item${a.id === act?.id ? ' cur' : ''}`}
              onClick={() => switchAct(a.id)}
            >
              <span className="hist-title">{actTitle(a)}</span>
              <span className="hist-meta">
                <em>{STAGE_LABEL[a.stage] || a.stage}</em>
                <span>{Object.values(a.needs || {}).filter(Boolean).length}/4</span>
                <span>{timeAgo(a.updated_at || a.created_at)}</span>
              </span>
            </button>
          ))}
          {sorted.length === 0 && <p className="hist-empty">还没有会话记录</p>}
        </div>
      </div>
    </Modal>
  );
}
