'use client';

import { useApp } from '@/state/AppProvider';
import AudienceRow from './AudienceRow';
import { Download } from '@/components/ui/icons';

/** 受众视图：导入按钮 + 注释 + 机会清单（按预估回流降序）—— 对应 flow.html #view-aud + renderAud。 */
export default function AudienceView() {
  const { audience, setDrawerAud, jumpToConfig, setImportOpen } = useApp();
  const sorted = [...audience].sort((a, b) => (+b.estGmv || 0) - (+a.estGmv || 0));
  return (
    <div className="view-body">
      <div className="phead">
        <h2>高意向流失受众</h2>
        <span className="desc">按预估回流价值排序 · 谁最值得捞一眼可见</span>
      </div>
      <div className="aud-tools">
        <button className="btn grad" onClick={() => setImportOpen(true)}>
          <Download /> 导入真实名单
        </button>
        <div className="note">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
          当前为演示名单 · 接入店铺后自动拉取真实顾客（邮件语种跟随客户地区）
        </div>
      </div>
      <div className="opp-list" id="oppList">
        {sorted.map((a) => (
          <AudienceRow key={a.email + a.name} a={a} onOpen={() => setDrawerAud(a)} onGo={() => jumpToConfig(a.intent, a)} />
        ))}
      </div>
    </div>
  );
}
