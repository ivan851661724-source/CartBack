'use client';
import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { needsValue } from '@/lib/needs';
import type { AvailableAction, Needs } from '@/lib/types';
export default function ChoicesEditor({ needs, action, onDirty }: { needs: Needs; action: AvailableAction; onDirty: (value: boolean) => void }) {
  const { runAction, confirmBusy } = useApp();
  const fields = { audience: '受众范围', offer: '优惠（或填写“无优惠”）', reason: '原因（可选）', goal: '目标（可选）' };
  const initial = Object.fromEntries(Object.keys(fields).map(k => [k, needsValue(needs[k as keyof Needs])]));
  const [values, setValues] = useState(initial);
  return <details style={{ margin: '12px 16px', padding: 12, border: '1px solid #DDE2E8', borderRadius: 12 }}><summary>查看或修改本次活动信息</summary><p>留空表示尚未决定。无需补齐原因和目标，也可以先看邮件预览。</p>
    <div style={{ display: 'grid', gap: 8 }}>{Object.entries(fields).map(([key, label]) => <label key={key}>{label}<input aria-label={label} style={{ width: '100%' }} value={values[key]} disabled={confirmBusy} onChange={e => { const next = { ...values, [key]: e.target.value }; setValues(next); onDirty(Object.keys(fields).some(k => next[k] !== initial[k])); }} /></label>)}</div>
    <button className="btn ghost sm" style={{ marginTop: 10 }} disabled={confirmBusy} onClick={() => runAction(action, { choices: values })}>保存本次活动信息</button>
  </details>;
}
