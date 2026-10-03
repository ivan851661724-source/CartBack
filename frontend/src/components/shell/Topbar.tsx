'use client';

import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { TAB_LABELS } from '@/lib/constants';
import { filledCount, progressText, progressTail } from '@/lib/needs';
import { initial } from '@/lib/format';
import NotificationBell from './NotificationBell';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

/** 顶栏：logo / 面包屑 / needs 进度提示 / 停发徽标 / 引擎徽标 / 模式徽章 / 登录·头像 / 重置 —— 对应 flow.html .topbar */
export default function Topbar() {
  const { status, act, me, drafts, engine, global_paused, blackout, switchTab, setAuthOpen, setAuthMode, authLogout, resetData, onboardingStep, onboardingSkipped, skipOnboarding, setOnboardingStep, guideStyle } = useApp();
  const real = status?.mode === 'real';
  // needs 进度：数字 n/4 全屏仅此处（HintPill）出现；槽位状态一律走 needs.ts 助手
  const filled = filledCount(act?.needs);
  const progressFull = progressText(act?.needs);

  // 引擎健康态（done 帧与 GET /api/state 更新；缺省 online）：degraded 时提示去设置页检查模型 Key
  const degraded = engine === 'degraded';

  // Wave3 停发徽标（PRD I2「看得见才不会忘」）：全局停发（红）/ 停发日历命中（橙）常驻顶栏，
  // 两者并存时都显示；解除方式只有对话里明说（title 提示），顶栏不给解除按钮（防误触恢复发送）。
  const paused = Boolean(global_paused);
  const bo = blackout && blackout.active ? blackout : null;
  // 徽标文案取第一个命中区间：停发日历 · {label} {from}~{to}
  const boRange = bo?.ranges?.[0];
  const boLabel = [boRange?.label, boRange?.from && boRange?.to ? `${boRange.from}~${boRange.to}` : ''].filter(Boolean).join(' ');

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

  // 非引导态：任务式进度文案（progressText 去数字前缀版作正文，完整全文放 title；数字由 hp-n 承担，避免重复）
  const needsTail = progressTail(act?.needs);

  // demo：非引导态显示 needs 进度；safe：引导态显示状态感知文案、否则 needs 进度
  const hpText = (!isDemoGuide && showOnboarding)
    ? (SAFE_ONBOARDING_TEXTS[onboardingStep] || SAFE_ONBOARDING_TEXTS[0])
    : needsTail;

  // 自定义确认弹层（09-30 报告 P2-2：原生 window.confirm 阻塞自动化点击且风格不一）：
  // 登出 / 重置两类确认统一走 ConfirmDialog
  const [confirmAsk, setConfirmAsk] = useState<'logout' | 'reset' | null>(null);

  const onUser = () => {
    if (me?.user) {
      setConfirmAsk('logout');
    } else {
      setAuthMode('login');
      setAuthOpen(true);
    }
  };

  const onReset = () => {
    setConfirmAsk('reset');
  };

  // F4 进度唯一口径（09-30 报告）：n/4 进度全屏仅顶栏一处——demo 引导期也显示顶栏进度，
  // 右栏重复的 0/10 checklist 已移除（ChatView）
  const showHint = true;

  return (
    <header className="topbar">
      <div className="logo">
        <span className="logo-name">Cart<b>Back</b></span>
      </div>

      {showHint && (
        <HintPill
          n={filled}
          text={hpText}
          fullText={progressFull}
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
      {/* 停发徽标（常驻）：全局停发红 / 停发日历橙，位于引擎徽标旁；点击提示解除方式（对话里明说） */}
      {paused && (
        <span className="pause-pill" title="全局停发生效中：所有批次暂停发送。对话里说『恢复吧』/『撤掉停发』可解除">
          <span className="dot" />
          全局停发中
        </span>
      )}
      {bo && (
        <span className="blackout-pill" title={`停发日历生效中${boLabel ? `（${boLabel}）` : ''}：命中区间内批次顺延。对话里说『恢复吧』/『撤掉停发』可解除`}>
          <span className="dot" />
          停发日历{boLabel ? ` · ${boLabel}` : ''}
        </span>
      )}
      {/* Z7 通知铃铛：未读角标 + 下拉列表（打开即全部已读；60s 轮询 + loadState 顺带刷新） */}
      <NotificationBell />
      {/* 引擎徽标：在线（绿）/ 降级模式（橙，title 引导去设置页检查模型 Key） */}
      <span
        className={`engine-pill${degraded ? ' degraded' : ''}`}
        title={degraded ? 'AI 未连接：到设置 → AI 助手 检查模型 Key' : '引擎在线'}
      >
        <span className="dot" />
        {degraded ? '降级模式 · AI 未连接' : '在线'}
      </span>
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

      {/* 自定义确认弹层（P2-2）：登出 / 重置，ESC / 遮罩 / 取消均可关闭 */}
      <ConfirmDialog
        open={confirmAsk === 'logout'}
        title="退出登录"
        message="退出后需要重新登录才能继续使用，当前会话进度会保留在服务端。"
        confirmLabel="退出"
        onConfirm={() => { setConfirmAsk(null); authLogout(); }}
        onCancel={() => setConfirmAsk(null)}
      />
      <ConfirmDialog
        open={confirmAsk === 'reset'}
        title="重置全部数据"
        message="确定重置全部数据？对话 / 邮件 / 看板数据会被清空，假种子受众会重新生成。"
        confirmLabel="重置"
        danger
        onConfirm={() => { setConfirmAsk(null); resetData(); }}
        onCancel={() => setConfirmAsk(null)}
      />
    </header>
  );
}

/**
 * needs 进度提示条（可收起 / 引导模式）。
 * 数字 n/4 全屏唯一出现处：hp-n 一个元素（收起态与展开态互斥，各自只出现一次）；
 * 展开态正文为任务式槽位状态（progressTail），完整全文放 title/aria。
 */
function HintPill({ n, text, fullText, onboarding, nextLabel, onNext, onSkip }: { n: number; text: string; fullText: string; onboarding?: boolean; nextLabel?: string; onNext?: () => void; onSkip?: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button
        type="button"
        className="hint-pill is-collapsed"
        aria-expanded="false"
        aria-label={`助手进度：${fullText}`}
        onClick={() => setCollapsed(false)}
      >
        <span className="hp-n"><b>{n}</b><small>/4</small></span>
        <span className="hp-compact-label">助手进度</span>
        <span className="hp-expand">展开</span>
      </button>
    );
  }
  return (
    <div className="hint-pill" aria-label={`助手进度：${fullText}`} title={fullText}>
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
