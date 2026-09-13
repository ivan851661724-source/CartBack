'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { ONBOARDING_TEXTS } from '@/lib/constants';

/**
 * 分步聚焦式新手引导：蒙层 spotlight（box-shadow 镂空目标）+ 右侧气泡 + 步骤4 底部完成弹窗。
 * 锚点靠 data-guide-target（ChatView 的 chips+输入区、需求确认卡；Sidebar 的数据看板 项）。
 * 自动跳步：step1→2 由 ChatView 收集完成触发（确认卡出现）；step2→3 点确认卡「可以，去发」
 *           切到邮件 tab（activeTab=mail）触发；step3→4 点数据看板侧栏触发。
 * 蒙层色值 rgba(75,85,105,0.42)（#4B5569 @42%）；步骤1-3 蒙层 2 秒渐隐，步骤4 蒙层常驻。
 */

const TARGETS: Record<number, string> = {
  0: '[data-guide-target="guide-compose"]',
  1: '[data-guide-target="guide-confirm"]',
  2: '[data-guide-target="guide-nav-data"]',
};

const MASK_COLOR = 'rgba(75,85,105,0.42)';
const BUBBLE_W = 280;

export default function GuideOverlay() {
  const { onboardingStep, onboardingSkipped, activeTab, setOnboardingStep, skipOnboarding } = useApp();
  const show = !onboardingSkipped && onboardingStep < 4;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [faded, setFaded] = useState(false);
  const rafRef = useRef(0);

  // 重新计算目标 rect：step 变化时启动 rAF 轮询（兜底布局抖动），卸载时停
  useLayoutEffect(() => {
    if (!show || onboardingStep > 2) { setRect(null); return; }
    const sel = TARGETS[onboardingStep];
    const calc = () => {
      const el = sel ? document.querySelector(sel) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5
            && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5
            ? prev : r,
        );
      } else {
        setRect(null);
      }
      rafRef.current = requestAnimationFrame(calc);
    };
    calc();
    const onResize = () => calc();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(rafRef.current); window.removeEventListener('resize', onResize); };
  }, [show, onboardingStep]);

  // 蒙层 2 秒渐隐（仅步骤 1-3，即 onboardingStep 0-2）
  useEffect(() => {
    if (!show || onboardingStep > 2) return;
    setFaded(false);
    const t = setTimeout(() => setFaded(true), 2000);
    return () => clearTimeout(t);
  }, [show, onboardingStep]);

  // 自动跳步：step1→2（用户点邮件配置侧栏 → activeTab=mail）、step2→3（点数据看板侧栏 → activeTab=data）
  useEffect(() => {
    if (!show) return;
    if (onboardingStep === 1 && activeTab === 'mail') setOnboardingStep(2);
    else if (onboardingStep === 2 && activeTab === 'data') setOnboardingStep(3);
  }, [show, onboardingStep, activeTab, setOnboardingStep]);

  if (!show) return null;

  // 步骤 4（onboardingStep 3）：底部完成弹窗 + 常驻蒙层
  if (onboardingStep === 3) {
    return (
      <div className="guide-done-overlay">
        <div className="guide-done-modal">
          <div className="guide-done-body">
            <h3>引导已完成</h3>
          </div>
          <button className="btn primary" onClick={skipOnboarding} style={{ width: '100%', justifyContent: 'center', border: 'none' }}>
            开始使用
          </button>
        </div>
      </div>
    );
  }

  // 步骤 1-3（onboardingStep 0-2）：蒙层 spotlight + 右侧气泡
  const text = ONBOARDING_TEXTS[onboardingStep] || '';
  const flip = rect ? rect.right + 14 + BUBBLE_W > window.innerWidth : false;
  const bubbleLeft = rect ? (flip ? Math.max(8, rect.left - 14 - BUBBLE_W) : rect.right + 14) : 0;
  const bubbleTop = rect ? rect.top : 0;

  return (
    <>
      {rect && (
        <div
          aria-hidden
          style={{
            position: 'fixed', top: rect.top, left: rect.left, width: rect.width, height: rect.height,
            borderRadius: 14, background: 'transparent',
            boxShadow: `0 0 0 100vmax ${MASK_COLOR}`,
            zIndex: 60, transition: 'opacity .6s ease', opacity: faded ? 0 : 1, pointerEvents: 'none',
          }}
        />
      )}
      {rect && (
        <div
          role="tooltip"
          style={{
            position: 'fixed', top: bubbleTop, left: bubbleLeft, zIndex: 61, width: BUBBLE_W,
            background: 'var(--card)', border: '.5px solid var(--line-2)', borderRadius: 12,
            padding: '14px 16px', boxShadow: 'var(--shadow-card)',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand)', fontFamily: 'var(--font-disp)', marginBottom: 6, letterSpacing: '.4px' }}>
            步骤 {onboardingStep + 1}/4
          </div>
          <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 12 }}>{text}</div>
          <button
            onClick={skipOnboarding}
            style={{ background: 'transparent', border: 0, color: 'var(--muted)', fontSize: 11, cursor: 'pointer', padding: 0, fontWeight: 600 }}
          >
            跳过引导
          </button>
        </div>
      )}
    </>
  );
}
