'use client';

import { useApp } from '@/state/AppProvider';
import type { Kpis } from '@/lib/types';
import AlertBar from './AlertBar';
import NarrativeStrip from './NarrativeStrip';
import KpiGrid from './KpiGrid';
import Funnel from './Funnel';
import TrendChart from './TrendChart';
import MetricsStrip from './MetricsStrip';
import EmailConfigPanel from './EmailConfigPanel';

/** 数据看板视图 */
export default function DataView() {
  const { status, kpis, trend, metrics, demoAnchorRoi } = useApp();
  const real = !!status && status.mode === 'real';
  const k: Kpis = kpis || ({} as Kpis);
  const hint = real
    ? '北极星：真实回流 GMV / ROI · 只显示真实归因结果'
    : '北极星：真实回流 GMV / ROI（当前演示数据 · 回流为仿真）';

  return (
    <div className="view-body">
      <div className="phead">
        <h2>数据看板</h2>
        <span className="desc">{hint}</span>
      </div>
      <AlertBar k={k} />
      <NarrativeStrip k={k} real={real} />
      <KpiGrid k={k} />
      <div className="charts-row">
        <div className="glass-card" style={{ padding: '17px 19px' }}>
          <div className="card-title"><span className="tline" />转化漏斗</div>
          <Funnel k={k} />
        </div>
        <div className="glass-card" style={{ padding: '17px 19px' }}>
          <div className="card-title"><span className="tline" />7 日趋势 · 回流 GMV</div>
          <TrendChart trend={trend} />
          <div className="legend">
            <span className="lg"><span className="sw" style={{ background: 'linear-gradient(90deg,#FF7F4D,#FFB380)' }} />回流 GMV</span>
            <span className="lg"><span className="sw" style={{ background: '#EEF2F6', border: '.5px solid #DDE2E8' }} />发送量</span>
          </div>
        </div>
      </div>
      <MetricsStrip k={k} m={metrics} demoAnchorRoi={demoAnchorRoi} />
      <EmailConfigPanel />
    </div>
  );
}
