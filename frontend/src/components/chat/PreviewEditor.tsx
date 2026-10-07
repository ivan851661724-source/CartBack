'use client';
import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import type { AvailableAction, PlanCard } from '@/lib/types';

export default function PreviewEditor({ card, action, choicesDirty = false }: { card: PlanCard; action?: AvailableAction; choicesDirty?: boolean }) {
  const { act, runAction, confirmPlan, confirmBusy } = useApp();
  const [subject, setSubject] = useState(card.subject || '');
  const [body, setBody] = useState(card.body || '');
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!confirmBusy) { setElapsed(0); return; }
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [confirmBusy]);
  if (!action) return <div style={{ whiteSpace: 'pre-wrap' }}><strong>{card.subject}</strong><p>{card.body}</p></div>;
  const dirty = subject !== (card.subject || '') || body !== (card.body || '');
  return <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
    <span>邮件语种：{card.locale || card.language || 'en'}（按店铺邮件语种设置）</span>
    {card.copy_warning && <p role="status">{card.copy_warning}</p>}
    {act?.flow_state?.prepare_error && <p role="alert" style={{ color: 'var(--danger)' }}>{act.flow_state.prepare_error}</p>}
    <label>主题*必填<input aria-label="预览邮件主题" value={subject} onChange={e => setSubject(e.target.value)} disabled={confirmBusy} style={{ width: '100%' }} /></label>
    <label>正文*必填<textarea aria-label="预览邮件正文" value={body} onChange={e => setBody(e.target.value)} disabled={confirmBusy} rows={7} style={{ width: '100%' }} /></label>
    {dirty && <><span>文案有未保存修改，请先保存，再准备发送方案。</span><button className="btn ghost sm" disabled={confirmBusy || !subject.trim() || !body.trim()} onClick={() => runAction(action, { subject, body })}>保存预览文案</button></>}
    {choicesDirty && <span>活动信息有未保存修改，请先保存。</span>}
    <button className="btn primary" disabled={choicesDirty || dirty || confirmBusy || !act?.flow_state?.actions.some(a => a.kind === 'prepare_plan' && a.enabled)} onClick={() => confirmPlan()}>{confirmBusy ? `正在准备方案 · ${elapsed} 秒` : '准备发送方案（会创建所需优惠码，不会发送）'}</button>
    {confirmBusy && <span role="status">正在核对受众与优惠，并生成邮件和图片。图片生成可能需要一段时间，请稍候。</span>}
    <span>{act?.flow_state?.actions.find(a => a.kind === 'prepare_plan')?.blockedReasons.join('；')}</span>
  </div>;
}
