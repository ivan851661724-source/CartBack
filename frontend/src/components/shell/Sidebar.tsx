'use client';

import type { ReactNode } from 'react';
import { useApp, type Tab } from '@/state/AppProvider';
import { NavChat, NavMail, NavData, NavAud, NavSet, FootArrow } from '@/components/ui/icons';

const NAVS: { key: Tab; label: string; Icon: () => ReactNode }[] = [
  { key: 'chat', label: '助手', Icon: NavChat },
  { key: 'mail', label: '邮件配置', Icon: NavMail },
  { key: 'data', label: '数据看板', Icon: NavData },
  { key: 'aud', label: '用户', Icon: NavAud },
  { key: 'set', label: '设置', Icon: NavSet },
];

/** 侧栏：五模块导航 + 底部品牌 —— 对应 flow.html .sidebar */
export default function Sidebar() {
  const { activeTab, switchTab, drafts } = useApp();
  const badge = drafts.length;

  return (
    <aside className="sidebar">
      {NAVS.map(({ key, label, Icon }) => {
        const on = activeTab === key;
        return (
          <button
            key={key}
            className={`nav${on ? ' active' : ''}`}
            role="tab"
            aria-selected={on ? 'true' : 'false'}
            onClick={() => switchTab(key)}
          >
            <span className="nav-ic"><Icon /></span>
            <span className="txt">{label}</span>
            {key === 'mail' && (
              <span className={`badge${badge > 0 ? ' show' : ''}`}>{badge}</span>
            )}
          </button>
        );
      })}
      <div className="foot">
        <div className="foot-brand">
          <span className="fl"><FootArrow /></span>
          <b>CartBack</b>
        </div>
        把逛了没买的人<br />变成回头客
      </div>
    </aside>
  );
}
