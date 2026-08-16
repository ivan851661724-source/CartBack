'use client';

import { useApp } from '@/state/AppProvider';
import { FIELDS } from '@/lib/constants';
import { Arrow } from '@/components/ui/icons';

/** 邮件配置+预览面板 —— 嵌入数据看板下方，对应 Figma EmailPage */
export default function EmailConfigPanel() {
  const { act, planShown, setPlanShown, setPlanPushed, confirmSendPlan, setChatInput, setChatPlaceholder } = useApp();

  const card = act?.planCard;
  if (!card || planShown !== 'plan') return null;

  const rows = FIELDS.map(([k, label]) => {
    const v = (k === 'offer' ? (card.discount || card.offer) : (card as any)[k]) || '';
    return (
      <div className="ec-row" key={k}>
        <span className="ec-k">{label}</span>
        <span className="ec-v">{v}</span>
      </div>
    );
  });

  return (
    <div className="email-config-panel">
      <div className="phead">
        <h2>邮件配置</h2>
        <span className="desc">由「助手」对话自动生成</span>
      </div>

      <div className="ec-wrap">
        {/* 左侧：需求要点 */}
        <div className="glass-card ec-left">
          <div className="card-title"><span className="tline" />需求要点（自动整理）</div>
          <div className="ec-list">{rows}</div>
          <div className="ec-footnote">由「助手」对话自动生成</div>
        </div>

        {/* 右侧：编辑器 */}
        <div className="glass-card ec-right">
          {/* 发送对象 */}
          <div className="ec-field">
            <label>发送对象</label>
            <div className="ec-input-row">
              <span className="ec-value">{card.audience || '—'}</span>
              <span className="ec-matched">{card.matchedCount || 0} 人匹配</span>
            </div>
          </div>

          {/* 邮件主题 */}
          <div className="ec-field">
            <label>邮件主题</label>
            <div className="ec-input">{card.subject || '—'}</div>
          </div>

          {/* 正文 */}
          <div className="ec-field">
            <label>正文</label>
            <div className="ec-textarea">{card.body || '—'}</div>
          </div>

          {/* 海报模板 */}
          <div className="ec-field">
            <label>海报模板</label>
            <div className="ec-posters">
              {['竖版促销', '横版 Banner', '极简白'].map((name, i) => (
                <button key={i} className={`ec-poster${i === 0 ? ' sel' : ''}`}>
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* 折扣 + 优惠码 */}
          <div className="ec-field-row">
            <div className="ec-field ec-half">
              <label>折扣（%）</label>
              <div className="ec-input">{card.discount || '8'}</div>
            </div>
            <div className="ec-field ec-half">
              <label>优惠码（自动生成）</label>
              <div className="ec-code">{card.coupon || '—'}</div>
            </div>
          </div>

          {/* 按钮 */}
          <div className="ec-actions">
            <button className="btn ghost" onClick={() => {
              setPlanShown(null);
              setPlanPushed(false);
              setChatPlaceholder('说说要改哪块：受众、钩子、折扣还是发送时机…');
            }}>
              <Arrow /> 微调
            </button>
            <button className="btn primary" onClick={() => confirmSendPlan(card)}>
              <Arrow /> 发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}