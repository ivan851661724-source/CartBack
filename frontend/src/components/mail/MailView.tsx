'use client';

import { useApp } from '@/state/AppProvider';
import { Mail, ReachCheck, Arrow } from '@/components/ui/icons';
import MailCard from './MailCard';

/** 邮件配置视图：统计条 + 卡片网格 —— 对应 flow.html #view-mail + app.js renderDrafts */
export default function MailView() {
  const { drafts, setEditingDraft, setEditOpen, draftGenerating } = useApp();
  const count = drafts.length;
  const reach = drafts.reduce((s, d) => s + (d.matchedCount || 0), 0);
  const gmv = drafts.reduce((s, d) => s + (+d.estGmv || 0), 0).toFixed(0);

  const open = (d: typeof drafts[number]) => { setEditingDraft(d); setEditOpen(true); };

  return (
    <div className="view-body">
      <div className="phead">
        <h2>邮件配置</h2>
        <span className="desc">每封独立生命周期 · 草稿 → 发送中 → 已发送 → 回流中</span>
      </div>
      <div className="stat-strip">
        <div className="stat glass-card">
          <div className="s-ic brand"><Mail /></div>
          <div><div className="s-n num">{count}</div><div className="s-l">封邮件活动</div></div>
        </div>
        <div className="stat glass-card">
          <div className="s-ic ok"><ReachCheck /></div>
          <div><div className="s-n num">{reach}</div><div className="s-l">累计触达</div></div>
        </div>
        <div className="stat glass-card">
          <div className="s-ic brand"><Arrow /></div>
          <div><div className="s-n num brand">¥{gmv}</div><div className="s-l">已捞回 · 预估</div></div>
        </div>
      </div>
      <div className="mail-grid">
        {draftGenerating && (
          <div className="mail-card generating-card" aria-busy="true">
            <div className="gen-thumb shimmer" />
            <div className="gen-body">
              <div className="gen-line shimmer w80" />
              <div className="gen-line shimmer w60" />
              <div className="gen-line shimmer w40" />
              <div className="gen-status"><span className="spinner" />正在生成邮件草稿…</div>
            </div>
          </div>
        )}
        {drafts.length === 0 && !draftGenerating ? (
          <div className="empty-note">还没有邮件。去「助手」跟 agent 聊完，会自动生成方案卡。</div>
        ) : (
          drafts.map((d) => <MailCard key={d.id} d={d} onOpen={() => open(d)} />)
        )}
      </div>
    </div>
  );
}
