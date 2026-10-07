'use client';

import { useApp } from '@/state/AppProvider';
import type { Kpis } from '@/lib/types';
import AlertBar from './AlertBar';
import NarrativeStrip from './NarrativeStrip';
import KpiGrid from './KpiGrid';
import Funnel from './Funnel';
import TrendChart from './TrendChart';
import MetricsStrip from './MetricsStrip';
import TagEffectPanel from './TagEffectPanel';

/** 数据看板视图 */
export default function DataView() {
  const { kpis, trend, metrics } = useApp();
  const k: Kpis = kpis || ({} as Kpis);
  const hint = '北极星：真实回流 GMV / ROI · 只显示真实归因结果';

  return (
    <div className="view-body">
      <div className="phead">
        <h2>数据看板</h2>
        <span className="desc">{hint}</span>
      </div>
      <AlertBar k={k} />
      <NarrativeStrip k={k} />
      <KpiGrid k={k} />
      <div className="charts-row">
        <div className="glass-card" style={{ padding: '17px 19px' }}>
          <div className="card-title">转化漏斗</div>
          <Funnel k={k} />
        </div>
        <div className="glass-card" style={{ padding: '17px 19px' }}>
          <div className="card-title">近 7 日 GMV 趋势</div>
          <TrendChart trend={trend} />
          <div className="legend">
            <span className="lg"><span className="sw" style={{ background: 'linear-gradient(90deg,#FF7F4D,#FFB380)' }} />回流 GMV</span>
            <span className="lg"><span className="sw" style={{ background: '#EEF2F6', border: '.5px solid #DDE2E8' }} />发送量</span>
          </div>
        </div>
      </div>
      <TagEffectPanel />
      <MetricsStrip k={k} m={metrics} />
    </div>
  );
}
