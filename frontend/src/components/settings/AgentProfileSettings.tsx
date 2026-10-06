'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
const fields = { product: '主营产品', market: '市场', currency: '币种', brand_tone: '品牌语气', default_offer: '长期优惠偏好', constraints: '长期限制（每行一项）' };
export default function AgentProfileSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const display = (profile: Record<string, string | string[]>) => Object.fromEntries(Object.keys(fields).map(k => [k, Array.isArray(profile[k]) ? (profile[k] as string[]).join('\n') : String(profile[k] || '')]));
  useEffect(() => { let alive = true; api<{ profile: Record<string, string | string[]> }>('/api/agent-profile').then(r => { if (alive) setValues(display(r.profile || {})); }).catch(e => { if (alive) setMessage(e.message); }); return () => { alive = false; }; }, []);
  const save = async (remove = false) => {
    setBusy(true);
    try {
      const profile = { ...values, constraints: (values.constraints || '').split('\n').map(x => x.trim()).filter(Boolean) };
      const r = await api<{ error?: string; profile: Record<string, string | string[]> }>('/api/agent-profile', { method: remove ? 'DELETE' : 'PUT', ...(remove ? {} : { body: JSON.stringify({ profile }) }) });
      if (r.error) throw new Error(r.error);
      setValues(display(r.profile || {})); setMessage(remove ? '长期资料已删除' : '长期资料已保存');
    } catch (e: any) { setMessage(e.message || '保存失败'); } finally { setBusy(false); }
  };
  return <div className="card" style={{ padding: 20, marginBottom: 20 }}><h3>助手长期记忆</h3><p>这里保存你明确设置的店铺资料。单次活动和历史方案不会自动变成长期偏好。清空某项并保存即可删除该项。</p>
    <div style={{ display: 'grid', gap: 10 }}>{Object.entries(fields).map(([key, label]) => <label key={key}>{label}{key === 'constraints' ? <textarea style={{ width: '100%' }} value={values[key] || ''} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} disabled={busy} /> : <input style={{ width: '100%' }} value={values[key] || ''} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} disabled={busy} />}</label>)}</div>
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}><button className="btn primary" disabled={busy} onClick={() => save()}>保存长期资料</button><button className="btn ghost" disabled={busy} onClick={() => save(true)}>删除全部长期资料</button></div><p role="status">{message}</p></div>;
}
