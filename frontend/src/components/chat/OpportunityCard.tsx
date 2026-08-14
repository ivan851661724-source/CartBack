'use client';

import type { Opportunities } from '@/lib/types';
import { useApp } from '@/state/AppProvider';
import { Bell } from '@/components/ui/icons';

/** 对话工作台右侧机会栏（新流失主动提醒）—— 对应 app.js renderOpportunities */
export default function OpportunityCard() {
  const { opportunities, jumpToConfig } = useApp();
  const o = opportunities;
  if (!o || (!o.newCount && !o.untargeted)) {
    return <div className="opp-card hidden" />;
  }
  const top = (o.opportunities && o.opportunities[0]) || null;
  return (
    <div className="opp-card">
      <div className="opp-card-head">
        <span className="opp-kicker"><Bell />待处理机会</span>
        <span className="opp-count">{o.untargeted || o.opportunities?.length || 0}</span>
      </div>
      <div className="opp-msg">{o.message}</div>
      <div className="opp-items">
        {(o.opportunities || []).map((x, i) => (
          <div className="opp-item" key={i}>
            <span className="opp-name">{x.name}</span>
            <span className="opp-intent">{x.intent}</span>
            <span className="opp-meta">预估 ¥{(x.estGmv || 0).toFixed(0)} · {x.urgencyDays} 天</span>
          </div>
        ))}
      </div>
      <button className="btn primary opp-cta" onClick={() => top && jumpToConfig(top.intent || '', top)}>
        处理首个机会
      </button>
    </div>
  );
}
