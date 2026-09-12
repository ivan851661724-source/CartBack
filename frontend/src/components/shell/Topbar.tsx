'use client';

import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { FIELDS, TAB_LABELS } from '@/lib/constants';
import { initial } from '@/lib/format';

/** 顶栏：logo / 面包屑 / needs 进度提示 / 模式徽章 / 登录·头像 / 重置 —— 对应 flow.html .topbar */
export default function Topbar() {
  const { status, act, me, setAuthOpen, setAuthMode, authLogout, resetData, onboardingStep, onboardingSkipped, skipOnboarding } = useApp();
  const real = status?.mode === 'real';
  const n = act?.needs ? (Object.values(act.needs) as string[]).filter(Boolean).length : 0;

  // 引导期由 GuideOverlay（蒙层+气泡）接管，顶栏 HintPill 仅在非引导态显示 needs 进度
  const showOnboarding = !onboardingSkipped && onboardingStep < 4;

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
        <span className="logo-name">Cart<b>Back</b></span>
      </div>

      {!showOnboarding && (
        <HintPill n={n} text={hpText} onSkip={skipOnboarding} />
      )}

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

/** needs 进度提示条（可收起 / 引导模式） */
function HintPill({ n, text, onboarding, nextLabel, onNext, onSkip }: { n: number; text: string; onboarding?: boolean; nextLabel?: string; onNext?: () => void; onSkip?: () => void }) {
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
        {onboarding ? (
          <>
            <button type="button" className="hp-btn" onClick={onNext} style={{background:'#FF7F4D',color:'#fff',borderRadius:'6px',padding:'3px 9px',fontSize:'11px',fontWeight:600,fontFamily:'var(--font-disp)'}}>{nextLabel ?? '下一步 →'}</button>
            <button type="button" className="hp-skip" onClick={onSkip}>跳过</button>
          </>
        ) : (
          <button type="button" className="hp-skip" aria-expanded="true" onClick={() => setCollapsed(true)}>收起</button>
        )}
      </span>
    </div>
  );
}
