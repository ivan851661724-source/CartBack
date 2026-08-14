'use client';

import type { Kpis, Metrics } from '@/lib/types';

/** 运维指标条（架构 §7 B6）—— 对应 app.js renderData 的 metrics 段。 */
export default function MetricsStrip({ k, m, demoAnchorRoi }: { k: Kpis; m: Metrics; demoAnchorRoi?: number }) {
  const guardHits = (m.guardrail_L0 || 0) + (m.guardrail_L2 || 0) + (m.guardrail_L4 || 0) + (m.guardrail_L3 || 0);
  return (
    <div className="metrics" id="metrics">
      <div className="m-item">发信量 <b>{m.send_volume || 0}</b></div>
      <div className="m-item">Token <b>{m.token_usage || 0}</b></div>
      <div className="m-item">发送失败 <b>{m.send_fail || 0}</b></div>
      <div className="m-item">真实发送 <b>{m.send_real || 0}</b></div>
      <div className="m-item">护栏命中 <b>{guardHits}</b></div>
      <div className="m-note">成本 ¥{k.cost} · 全量预估可挽回 GMV ¥{k.estTotal}（示意）· 演示 ROI 锚点 {demoAnchorRoi ?? 0}×（非真实业绩）</div>
    </div>
  );
}
