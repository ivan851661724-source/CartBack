'use client';

import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { FIELDS, TAB_LABELS } from '@/lib/constants';
import { initial } from '@/lib/format';

/** 顶栏：logo / 面包屑 / needs 进度提示 / 模式徽章 / 登录·头像 / 重置 —— 对应 flow.html .topbar */
export default function Topbar() {
  const { status, act, me, drafts, switchTab, setAuthOpen, setAuthMode, authLogout, resetData, onboardingStep, onboardingSkipped, skipOnboarding, setOnboardingStep, guideStyle } = useApp();
  const real = status?.mode === 'real';
  const n = act?.needs ? (Object.values(act.needs) as string[]).filter(Boolean).length : 0;

  // 引导风格：demo 由 GuideOverlay 接管，顶栏 HintPill 仅在非引导态显示 needs 进度；
  //            safe 由顶栏 HintPill 串联引导（状态感知文案，手动下一步）。
  const isDemoGuide = guideStyle === 'demo';
  const showOnboarding = !onboardingSkipped && onboardingStep < 4;
  const isLastStep = onboardingStep >= 3;

  // safe 模式引导文案：陈述当前真实状态（有草稿/已发送从数据判断），绝不提前宣告「已跑通」（走查 P0-3）
  const hasDraft = (drafts || []).length > 0;
  const hasSentDraft = (drafts || []).some((d) => ['queued', 'sending', 'sent', 'recovering'].includes(d.status));
  const SAFE_ONBOARDING_TEXTS: Record<number, string> = {
    0: '点下方快捷描述或直接打字：告诉助手你想挽回谁、为啥、要什么结果。',
    1: '信息收集中——助手会一项项问，也可以直接补充。',
    2: hasDraft
      ? '草稿已生成——去「邮件配置」核对后点「发送」。'
      : '需求齐了——对话里核对确认卡，点「可以，去发」生成草稿。',
    3: hasSentDraft
      ? '邮件已发出！切到「数据看板」看点击 / 转化 / GMV / ROI。'
      : '下一步：去「邮件配置」核对草稿后点「发送」。',
  };

  const needsText = n === 4
    ? '信息齐了！看一下对话里的确认卡，点「可以，去发」就能生成邮件方案。'
    : n === 0
      ? '跟助手聊聊想挽回谁、为啥、要什么结果，信息齐了自动出方案。'
      : `已收集 ${n} 项，继续聊（还差：${FIELDS.filter(([k]) => !(act?.needs?.[k])).map(([, l]) => l).join('、')}）`;

  // demo：非引导态显示 needs 进度；safe：引导态显示状态感知文案、否则 needs 进度
  const hpText = (!isDemoGuide && showOnboarding)
    ? (SAFE_ONBOARDING_TEXTS[onboardingStep] || SAFE_ONBOARDING_TEXTS[0])
    : needsText;

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

  // demo：引导期不显示顶栏 HintPill（GuideOverlay 接管）；safe：始终显示（引导态串联）
  const showHint = isDemoGuide ? !showOnboarding : true;

  return (
    <header className="topbar">
      <div className="logo">
        <span className="logo-name">Cart<b>Back</b></span>
      </div>

      {showHint && (
        <HintPill
          n={(!isDemoGuide && showOnboarding) ? onboardingStep + 1 : n}
          text={hpText}
          onboarding={!isDemoGuide && showOnboarding}
          nextLabel={isLastStep ? '完成' : '下一步 →'}
          onNext={() => {
            if (isLastStep) { setOnboardingStep(4); return; }
            const next = onboardingStep + 1;
            setOnboardingStep(next);
            if (next === 2) switchTab('mail');
            else if (next === 3) switchTab('data');
          }}
          onSkip={skipOnboarding} />
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
