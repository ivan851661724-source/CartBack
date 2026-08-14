'use client';

import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { FIELDS, TAB_LABELS } from '@/lib/constants';
import { initial } from '@/lib/format';

/** 顶栏：logo / 面包屑 / needs 进度提示 / 模式徽章 / 登录·头像 / 重置 —— 对应 flow.html .topbar */
export default function Topbar() {
  const { status, act, activeTab, me, switchTab, setAuthOpen, setAuthMode, authLogout, resetData } = useApp();
  const real = status?.mode === 'real';
  const n = act?.needs ? (Object.values(act.needs) as string[]).filter(Boolean).length : 0;

  const hpText = n === 4
    ? '信息齐了！看一下对话里的确认卡，点「可以，去发」就能生成邮件方案。'
    : n === 0
      ? '跟助手聊聊想挽回谁、为啥、要什么结果，信息齐了自动出方案。'
      : `已收集 ${n} 项，继续聊（还差：${FIELDS.filter(([k]) => !(act?.needs?.[k])).map(([, l]) => l).join('、')}）`;

  const onUser = () => {
    if (me?.user) {
      if (window.confirm('退出登录？')) authLogout();
    } else {
      setAuthMode('login');
      setAuthOpen(true);
    }
  };

  const onReset = () => {
    if (window.confirm('确定重置全部数据？假种子受众会重新生成。')) resetData();
  };

  return (
    <header className="topbar">
      <div className="logo">
        <img className="mark" src="/logo.svg" alt="CartBack" />
        <span className="logo-name">Cart<b>Back</b></span>
      </div>
      <span className="crumb">/ {TAB_LABELS[activeTab] || activeTab}</span>

      <HintPill n={n} text={hpText} />

      <span className="spacer" />
      <span className={`mode-pill${real ? ' real' : ''}`}>{real ? '真实' : '演示'}</span>
      <button className="tbtn" onClick={onUser} title={me?.user ? (me.user.name || me.user.email) : ''}>
        {me?.user ? '登出' : '登录'}
      </button>
      {me?.user && (
        <div
          className="t-avatar"
          title={me.user.name || me.user.email}
          style={{ display: 'flex' }}
        >
          {initial((me.user.name || me.user.email)).toUpperCase()}
        </div>
      )}
      <button className="tbtn" onClick={onReset}>重置</button>
    </header>
  );
}

/** needs 进度提示条（可收起） */
function HintPill({ n, text }: { n: number; text: string }) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button
        type="button"
        className="hint-pill is-collapsed"
        aria-expanded="false"
        aria-label={`助手进度 ${n}/4，展开提示`}
        onClick={() => setCollapsed(false)}
      >
        <span className="hp-n"><b>{n}</b><small>/4</small></span>
        <span className="hp-compact-label">助手进度</span>
        <span className="hp-expand">展开</span>
      </button>
    );
  }
  return (
    <div className="hint-pill" aria-label={`助手进度 ${n}/4`}>
      <span className="hp-n"><b>{n}</b><small>/4</small></span>
      <span className="hp-t">{text}</span>
      <span className="hp-actions">
        <button type="button" className="hp-skip" aria-expanded="true" onClick={() => setCollapsed(true)}>收起</button>
      </span>
    </div>
  );
}
