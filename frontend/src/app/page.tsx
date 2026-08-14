'use client';

import type { ReactNode } from 'react';
import { AppProvider, useApp, type Tab } from '@/state/AppProvider';
import Topbar from '@/components/shell/Topbar';
import Sidebar from '@/components/shell/Sidebar';
import Toast from '@/components/ui/Toast';
import ChatView from '@/components/chat/ChatView';
import MailView from '@/components/mail/MailView';
import DataView from '@/components/data/DataView';
import AudienceView from '@/components/audience/AudienceView';
import SettingsView from '@/components/settings/SettingsView';
import AudienceDrawer from '@/components/audience/AudienceDrawer';
import ImportModal from '@/components/audience/ImportModal';
import EditModal from '@/components/mail/EditModal';
import AuthModal from '@/components/auth/AuthModal';

function Shell() {
  const { activeTab } = useApp();
  // 全部视图常驻挂载（仅 .active 切换），保 tab 间内存态（对话/输入/滚动不丢）—— 与原 SPA 一致。
  const views: [Tab, ReactNode][] = [
    ['chat', <ChatView key="chat" />],
    ['mail', <MailView key="mail" />],
    ['data', <DataView key="data" />],
    ['aud', <AudienceView key="aud" />],
    ['set', <SettingsView key="set" />],
  ];
  return (
    <>
      <Topbar />
      <div className="shell">
        <Sidebar />
        <main className="main">
          {views.map(([key, node]) => (
            <section key={key} className={`view${activeTab === key ? ' active' : ''}`} id={`view-${key}`}>
              {node}
            </section>
          ))}
        </main>
      </div>
      {/* 全局浮层 */}
      <AudienceDrawer />
      <ImportModal />
      <EditModal />
      <AuthModal />
      <Toast />
    </>
  );
}

export default function Page() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
