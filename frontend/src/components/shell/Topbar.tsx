'use client';

import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { FIELDS, TAB_LABELS } from '@/lib/constants';
import { initial } from '@/lib/format';

/** 顶栏：logo / 面包屑 / needs 进度提示 / 模式徽章 / 登录·头像 / 重置 —— 对应 flow.html .topbar */
export default function Topbar() {
  const { status, act, activeTab, me, switchTab, setAuthOpen, setAuthMode, authLogout, resetData, onboardingStep, onboardingSkipped, skipOnboarding, setOnboardingStep } = useApp();
  const real = status?.mode === 'real';
  const n = act?.needs ? (Object.values(act.needs) as string[]).filter(Boolean).length : 0;

  const showOnboarding = !onboardingSkipped && onboardingStep < 4 && activeTab === 'chat';

  const ONBOARDING_TEXTS: Record<number, string> = {
    0: '点击左侧「助手」，依次点上方 10 个快捷描述告诉助手你的品牌信息。',
    1: '太棒了！去「邮件配置」查看 10 个要点，选好受众和折扣后点「发送」。',
    2: '邮件已发出！切到「数据看板」查看点击 / 转化 / GMV / ROI。',
    3: '完整闭环已跑通！可切换受众重复发送，或关掉引导自由操作。',
  };

  const hpText = showOnboarding
    ? ONBOARDING_TEXTS[onboardingStep] || ONBOARDING_TEXTS[0]
    : n === 4
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

      <HintPill n={showOnboarding ? onboardingStep + 1 : n} text={hpText} onboarding={showOnboarding}
        onNext={() => {
          const next = onboardingStep + 1;
          setOnboardingStep(next);
          if (next === 2) switchTab('mail');
          else if (next === 3) switchTab('data');
        }}
        onSkip={skipOnboarding} />

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
function HintPill({ n, text, onboarding, onNext, onSkip }: { n: number; text: string; onboarding?: boolean; onNext?: () => void; onSkip?: () => void }) {
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
            <button type="button" className="hp-btn" onClick={onNext} style={{background:'#FF7F4D',color:'#fff',borderRadius:'6px',padding:'3px 9px',fontSize:'11px',fontWeight:600,fontFamily:'var(--font-disp)'}}>下一步 →</button>
            <button type="button" className="hp-skip" onClick={onSkip}>跳过</button>
          </>
        ) : (
          <button type="button" className="hp-skip" aria-expanded="true" onClick={() => setCollapsed(true)}>收起</button>
        )}
      </span>
    </div>
  );
}
