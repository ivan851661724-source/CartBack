'use client';

import { Fragment } from 'react';
import type { Kpis } from '@/lib/types';

/** 层色：品牌橙逐层减淡（对齐 Figma 406:401 FunnelChart 的衰减） */
const TIER_FILLS = ['rgba(249,111,58,1)', 'rgba(249,111,58,.78)', 'rgba(249,111,58,.56)', 'rgba(249,111,58,.36)'];

/**
 * 转化漏斗：真梯形漏斗（对齐 Figma 406:397）—— 4 层居中梯形 + 右侧「步骤 数值 / 百分比」标签列
 * + 层间贯穿虚线分割（619:9555/57/59）。宽度数据驱动：每层顶宽 = 数值占发送量的比例（下限 4%
 * 保底可见），层底宽 = 下一层顶宽，末层再收窄 ~45%；preserveAspectRatio="none" 随卡片宽度自适应。
 */
export default function Funnel({ k }: { k: Kpis }) {
  const steps: [string, number][] = [['发送', k.sent || 0], ['打开', k.open || 0], ['点击', k.click || 0], ['转化', k.convert || 0]];
  const max = Math.max(k.sent || 0, 1);
  const tops = steps.map(([, v]) => Math.min(100, Math.max((v / max) * 100, 4)));
  return (
    <div className="funnel" id="funnel">
      {steps.map(([l, v], i) => {
        const top = tops[i];
        const bottom = i < 3 ? tops[i + 1] : top * 0.45;
        const r = Math.max(0, Math.min(100, (bottom / top) * 100));
        const pct = Math.round((v / max) * 100);
        return (
          <Fragment key={l}>
            {i > 0 && <div className="f-divider" aria-hidden />}
            <div className="f-tier">
              <div className="f-stage">
                <svg
                  className="f-trap"
                  style={{ width: `${top}%` }}
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <polygon points={`0,0 100,0 ${(100 + r) / 2},100 ${(100 - r) / 2},100`} fill={TIER_FILLS[i]} />
                </svg>
              </div>
              <div className="f-meta">
                <div className="f-name">{l} {v}</div>
                <div className="f-pctv">{pct}%</div>
              </div>
            </div>
            {i === steps.length - 1 && <div className="f-divider" aria-hidden />}
          </Fragment>
        );
      })}
    </div>
  );
}
