'use client';

/**
 * 竞品雷达页（PRD §6 / 第六模块）：
 *  - 源管理列表 + 添加（转发制收集地址一键复制）
 *  - 手动粘贴竞品邮件原文（MVP 收集入口，不依赖公网部署）
 *  - 策略卡列表（学结构不抄文案：原文不出库，仅展示结构字段）
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/state/AppProvider';
import Tag from '@/components/ui/Tag';
import Modal from '@/components/ui/Modal';

interface CompSource { id: string; name: string; mailbox: string | null; status: string; last_collected_at: number | null; }
interface StrategyCard {
  id: string; competitor_name: string | null; theme_formula: string | null;
  angle: string | null; discount_range: string | null; timing: string | null;
  frequency: string | null; visual_style: string | null; raw_retained?: boolean;
  collected_at?: number | null; created_at: number;
}

export default function CompetitorView() {
  const { toast_, booted, activeTab } = useApp();
  const [sources, setSources] = useState<CompSource[]>([]);
  const [address, setAddress] = useState('');
  const [cards, setCards] = useState<StrategyCard[]>([]);
  const [newName, setNewName] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteRaw, setPasteRaw] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api<{ sources: CompSource[]; collection_address: string }>('/api/competitors');
      setSources(s.sources || []);
      setAddress(s.collection_address || '');
      const c = await api<{ cards: StrategyCard[] }>('/api/strategy-cards');
      setCards(c.cards || []);
    } catch (e: any) {
      toast_('竞品数据加载失败：' + (e?.message || e));
    }
  }, [toast_]);

  // 视图常驻挂载：bootstrap 后 + 每次切到竞品页都重新拉取（否则是旧快照）
  useEffect(() => { if (booted && activeTab === 'comp') load(); }, [booted, activeTab, load]);

  const addSource = async () => {
    if (!newName.trim()) { toast_('竞品名称不能为空'); return; }
    setBusy(true);
    try {
      const r = await api<{ sources: CompSource[]; error?: string }>('/api/competitors', {
        method: 'POST', body: JSON.stringify({ name: newName.trim() }),
      });
      if (r.error) { toast_(r.error); return; }
      setSources(r.sources || []);
      setNewName('');
      toast_('竞品源已添加');
    } finally { setBusy(false); }
  };

  const delSource = async (id: string) => {
    const r = await api<{ sources: CompSource[] }>(`/api/competitors/${id}`, { method: 'DELETE' });
    setSources(r.sources || []);
  };

  const submitPaste = async () => {
    if (!pasteRaw.trim()) { toast_('请粘贴邮件原文'); return; }
    setBusy(true);
    try {
      const r = await api<{ kept: boolean; reason?: string; message?: string; provider?: string; error?: string }>(
        '/api/competitors/inbound',
        { method: 'POST', body: JSON.stringify({ raw_email: pasteRaw, competitor_name: pasteName.trim() }) },
      );
      if (r.error) { toast_(r.error); return; }
      if (!r.kept) { toast_(r.message || '已丢弃（仅收营销邮件）'); setPasteOpen(false); setPasteRaw(''); return; }
      toast_(`策略卡已生成（${r.provider === 'llm' ? 'AI 拆解' : '规则拆解'}）`);
      setPasteOpen(false);
      setPasteRaw('');
      setPasteName('');
      await load();
    } finally { setBusy(false); }
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast_('收集地址已复制，转发竞品邮件即可');
    } catch { toast_(address); }
  };

  const CARD_ROWS: [keyof StrategyCard, string][] = [
    ['theme_formula', '钩子公式'], ['angle', '角度'], ['discount_range', '折扣'],
    ['timing', '时机'], ['frequency', '频率'], ['visual_style', '视觉'],
  ];

  return (
    <div className="view-body">
      <div className="phead">
        <h2>竞品雷达</h2>
        <span className="desc">竞品验证过的打法 → 变成本店策略卡，生成方案时自动参考（学结构，不抄文案）</span>
      </div>

      {/* 收集地址 + 源管理 */}
      <div className="setup-card glass-card">
        <div className="s-body">
          <div className="s-head">
            <h3>收集邮箱（转发制）</h3>
            <Tag kind="default">{sources.length} 个源</Tag>
          </div>
          <div className="s-desc">把竞品营销邮件转发到这个专属地址，系统自动预过滤 → 拆解成策略卡。没有公网部署时，用下面的「手动粘贴」。</div>
          <div className="row">
            <input readOnly value={address} style={{ maxWidth: 320 }} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn ghost sm" onClick={copyAddress}>复制地址</button>
            <button className="btn primary sm" onClick={() => setPasteOpen(true)}>手动粘贴邮件</button>
          </div>

          <div style={{ marginTop: 14 }}>
            {sources.map((s) => (
              <div className="row" key={s.id} style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span><b>{s.name}</b></span>
                <Tag kind="default">{s.last_collected_at ? '最近收集 ' + new Date(s.last_collected_at).toLocaleDateString() : '暂无收集'}</Tag>
                <button className="btn ghost sm" onClick={() => delSource(s.id)}>移除</button>
              </div>
            ))}
            <div className="row" style={{ gap: 8 }}>
              <input
                placeholder="竞品名称（如 NovaGear）"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={{ maxWidth: 240 }}
                onKeyDown={(e) => { if (e.key === 'Enter') addSource(); }}
              />
              <button className="btn ghost sm" disabled={busy} onClick={addSource}>添加源</button>
            </div>
          </div>
        </div>
      </div>

      {/* 策略卡列表 */}
      <div className="phead" style={{ marginTop: 10 }}>
        <h3>策略卡（{cards.length}）</h3>
        <span className="desc">生成方案时检索同品类 Top-3 自动注入参考</span>
      </div>
      {cards.length === 0 ? (
        <div className="s-desc">还没有策略卡。粘贴一封竞品营销邮件试试。</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {cards.map((c) => (
            <div className="glass-card" key={c.id} style={{ padding: 14 }}>
              <div className="s-head">
                <h3>{c.competitor_name || '未知竞品'}</h3>
                <Tag kind="intent">{c.discount_range || '—'}</Tag>
              </div>
              <div style={{ marginTop: 8 }}>
                {CARD_ROWS.map(([k, label]) => (
                  c[k] ? (
                    <div key={k} style={{ fontSize: 13, marginBottom: 4 }}>
                      <span style={{ opacity: 0.6 }}>{label}：</span>
                      <span>{String(c[k])}</span>
                    </div>
                  ) : null
                ))}
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, opacity: 0.5 }}>
                  {c.created_at ? new Date(c.created_at).toLocaleDateString() : ''}
                </span>
                <button
                  className="btn ghost sm"
                  onClick={async () => { await api(`/api/strategy-cards/${c.id}`, { method: 'DELETE' }); await load(); }}
                >删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 手动粘贴弹层 */}
      <Modal open={pasteOpen} onClose={() => setPasteOpen(false)} title="粘贴竞品邮件原文" width="92%">
        <div className="m-body">
          <div className="row">
            <input
              placeholder="竞品名称（可选）"
              value={pasteName}
              onChange={(e) => setPasteName(e.target.value)}
              style={{ maxWidth: 240 }}
            />
            <span className="s-desc">原文仅存 30 天，只提取打法</span>
          </div>
          <textarea
            placeholder="把竞品营销邮件的原文粘贴到这里…"
            value={pasteRaw}
            onChange={(e) => setPasteRaw(e.target.value)}
            rows={10}
            style={{ width: '100%', marginTop: 8 }}
          />
        </div>
        <div className="m-foot">
          <button className="btn primary" disabled={busy} onClick={submitPaste}>拆解成策略卡</button>
          <button className="btn ghost" onClick={() => setPasteOpen(false)}>取消</button>
        </div>
      </Modal>
    </div>
  );
}
