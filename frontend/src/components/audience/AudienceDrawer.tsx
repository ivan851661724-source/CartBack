'use client';

import { useApp } from '@/state/AppProvider';
import Tag from '@/components/ui/Tag';
import { Close } from '@/components/ui/icons';

/** 受众画像抽屉（一句话画像）—— 对应 flow.html #drawer + app.js openDrawer。
 *  全局常驻，由 drawerAud 是否为 null 驱动 .open。 */
export default function AudienceDrawer() {
  const { drawerAud, setDrawerAud, jumpToConfig } = useApp();
  const a = drawerAud;
  const open = !!a;
  if (!a) {
    return <div className="drawer" role="dialog" aria-modal="true" aria-label="受众画像" aria-hidden="true" />;
  }
  const intent = a.intent || '';
  const oneLiner = /加购/.test(intent)
    ? '已加购未结账，购买意愿强、只差临门一脚——折扣 + 提醒最有效。'
    : /弃购|未付/.test(intent)
      ? '结算中途离开，可能被运费/支付劝退，适合免邮 + 小额折扣再推一把。'
      : /浏览/.test(intent)
        ? '还在犹豫期，适合低门槛钩子（新品尝鲜价）慢慢养。'
        : '处于流失边缘，先弄清原因再针对性给钩子。';
  const go = () => { setDrawerAud(null); jumpToConfig(intent, a); };
  return (
    <div className="drawer open" role="dialog" aria-modal="true" aria-label="受众画像">
      <div className="d-head">
        <div className="av" id="dAv">{(a.name || '?').slice(0, 1)}</div>
        <div>
          <div className="nm" id="dName">{a.name || '—'}</div>
          <div className="em" id="dEmail">{a.email || ''}</div>
        </div>
        <button className="d-close" aria-label="关闭" onClick={() => setDrawerAud(null)}><Close /></button>
      </div>
      <div className="d-body" id="drawerBody">
        <div className="d-sec">
          <h4>为什么值得捞</h4>
          <div className="d-sig">
            <Tag kind="intent">{intent}</Tag>
            <Tag kind={a.risk === '高' ? 'risk' : 'gray'}>流失风险 {a.risk || ''}</Tag>
            <Tag kind="price">价格敏感 {a.price || ''}</Tag>
          </div>
          <div className="kv" style={{ marginTop: 10 }}><span>来源</span><b>{a.source || '—'}</b></div>
          <div className="kv"><span>评分</span><b>{a.score != null ? a.score : '—'}</b></div>
        </div>
        <div className="d-sec">
          <h4>价值</h4>
          <div className="kv"><span>购物车金额</span><b>¥{(+a.abandoned_value || 0).toFixed(2)}</b></div>
          <div className="kv"><span>预估回流 GMV</span><b className="brand">¥{(+a.estGmv || 0).toFixed(2)}</b></div>
          <div className="kv"><span>挽回紧迫度</span><b>{a.urgencyDays != null ? a.urgencyDays + ' 天' : '—'}</b></div>
        </div>
        <div className="d-sec">
          <h4>一句话画像</h4>
          <div style={{ fontSize: '12.5px', color: 'var(--text)', lineHeight: 1.7 }}>{oneLiner}</div>
        </div>
        <button className="btn primary d-cta" onClick={go}>去对话里挽回这拨人</button>
      </div>
    </div>
  );
}
