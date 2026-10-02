'use client';

/**
 * 顶栏通知铃铛（Wave4 Z7）：
 *  - 未读数角标（GET /api/notifications 的 unread；接口缺失/旧后端 404 → 无角标、空列表，安全降级）
 *  - 下拉列表：title / body / 时间 / type 徽标（t0=T+0 发送 · t24=T+24h 回流 · recover=报喜 · system=系统）
 *  - 打开即全部已读：POST /api/notifications/read（缺省 ids=全部；本地先行置灰，不阻塞不回滚）
 *  - 60s 轮询一次；回合末 loadState 也会顺带刷新（AppProvider）
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { Bell } from '@/components/ui/icons';
import { fmtTime } from '@/lib/format';
import type { NotificationItem } from '@/lib/types';

/** type 徽标：文案 + 色调（recover 报喜用 ok 绿，其余黑白灰） */
const TYPE_BADGE: Record<string, { label: string; tone: 'ok' | 'gray' }> = {
  t0: { label: 'T+0 发送', tone: 'gray' },
  t24: { label: 'T+24h 回流', tone: 'gray' },
  recover: { label: '报喜', tone: 'ok' },
  system: { label: '系统', tone: 'gray' },
};

export default function NotificationBell() {
  const { notifications, unread, refreshNotifications, markNotificationsRead } = useApp();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 60s 轮询（挂载即拉一次；AppProvider.loadState 末尾另有顺带刷新，双路保活）
  useEffect(() => {
    refreshNotifications();
    const t = setInterval(() => { refreshNotifications(); }, 60000);
    return () => clearInterval(t);
  }, [refreshNotifications]);

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // 打开即全部已读（有未读才 POST，避免无谓请求）
    if (next && unread > 0) markNotificationsRead();
  };

  const items = notifications || [];

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className="tbtn ntf-btn"
        onClick={toggle}
        aria-label={unread > 0 ? `通知（${unread} 条未读）` : '通知'}
        aria-expanded={open}
        title="通知"
      >
        <Bell />
        通知
        {unread > 0 && (
          <span className="ntf-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="ntf-panel" role="dialog" aria-label="通知列表">
          <div className="ntf-head">
            通知
            {items.length > 0 && <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>共 {items.length} 条</span>}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: '26px 14px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              暂无通知——发送挽回邮件后，回执和回流会出现在这里
            </div>
          ) : (
            items.map((nt) => <NotificationRow key={nt.id} nt={nt} />)
          )}
        </div>
      )}
    </div>
  );
}

/** 单条通知行：type 徽标 + 标题 + 时间 + 正文（未读小圆点） */
function NotificationRow({ nt }: { nt: NotificationItem }) {
  const badge = TYPE_BADGE[nt.type] || { label: '通知', tone: 'gray' as const };
  return (
    <div className="ntf-item">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {!nt.read && <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--brand)', flexShrink: 0 }} />}
        <span style={{
          fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '1px 8px', flexShrink: 0,
          ...(badge.tone === 'ok'
            ? { color: 'var(--ok2)', background: 'var(--ok-bg)', border: '.5px solid var(--ok-line)' }
            : { color: 'var(--muted)', background: 'var(--bg-input)', border: '.5px solid var(--line)' }),
        }}>{badge.label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E293B', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nt.title}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--soft)', flexShrink: 0 }}>{fmtTime(nt.created_at)}</span>
      </div>
      {nt.body && (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {nt.body}
        </div>
      )}
    </div>
  );
}
