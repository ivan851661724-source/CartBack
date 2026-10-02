'use client';

/**
 * 批次状态卡（Wave3，PRD Z3「批次并列」+「批次的管理动作全部在对话里完成，列表页只读展示」）。
 *  - 每批一张：批次名 + 六态徽标 + 人群一句话 + 已发/未发计数 + 折扣码短标（PlanCard 简版三态）
 *    + stats 一行（全 0 显示「暂无回流数据」）+ resume_note 顺延提示 + excluded 自动排除摘要。
 *  - 快捷按钮「暂停 / 恢复」：只按状态条件显示，点击发对应对话消息（「A 批次暂停」/「A 批次恢复」，
 *    取 campaign.name 首词）走现有 sendMsg —— 对话是驾驶舱，卡片不自调管理 API。
 *  - 数据源：AppProvider.campaigns（GET /api/state 顶层），每轮对话回合结束 loadState 刷新。
 *  - Wave4 复用：回执气泡 / I5 三行汇报可直接复用本卡与 CampaignStatusBadge。
 */
import React from 'react';
import { useApp } from '@/state/AppProvider';
import type { Campaign, CampaignStatus } from '@/lib/types';

/** 六态徽标元数据（草稿灰/排队蓝/发送中绿/已暂停橙/已完成黑/已冻结红，复用全局状态色 token） */
export const CAMPAIGN_STATUS_META: Record<CampaignStatus, { label: string; bg: string; color: string; border?: string }> = {
  draft: { label: '草稿', bg: 'var(--bg-hover)', color: 'var(--muted)' },
  scheduled: { label: '排队中', bg: 'var(--indigo-bg)', color: 'var(--indigo3)' },
  running: { label: '发送中', bg: 'var(--ok-bg)', color: 'var(--ok2)' },
  paused: { label: '已暂停', bg: 'var(--warn-bg)', color: 'var(--warn2)' },
  done: { label: '已完成', bg: '#1E293B', color: '#fff' },
  frozen: { label: '已冻结', bg: 'var(--danger-bg)', color: 'var(--danger)' },
};

/** 六态徽标（也供邮件页只读条 / Wave4 回执复用） */
export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const m = CAMPAIGN_STATUS_META[status] || CAMPAIGN_STATUS_META.draft;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
      background: m.bg, color: m.color, border: m.border,
      borderRadius: 999, padding: '2px 9px', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', opacity: .75 }} />
      {m.label}
    </span>
  );
}

/** 折扣码短标（PlanCard DiscountBadge 简版）：created 绿 / reused 灰 / none 灰虚线 */
function DiscountMini({ c }: { c: Campaign }) {
  const dis = c.discount;
  if (!dis) return null;
  if (dis.code_status === 'created' && dis.code) {
    return (
      <span style={{
        background: 'var(--ok-bg2)', color: 'var(--ok2)', border: '.5px solid var(--ok-line)',
        borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
      }}>
        🎟 {dis.code}
      </span>
    );
  }
  if (dis.code_status === 'reused' && dis.code) {
    return (
      <span style={{
        background: 'var(--bg-input)', color: 'var(--text)', border: '.5px solid var(--line)',
        borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
      }}>
        🎟 {dis.code} · 店内码
      </span>
    );
  }
  return (
    <span style={{
      background: 'var(--bg-input)', color: 'var(--muted)', border: '.5px dashed var(--line)',
      borderRadius: 999, padding: '2px 9px', fontSize: 11, whiteSpace: 'nowrap',
    }}>
      未创建折扣码
    </span>
  );
}

/** excluded 摘要一行：「自动排除：已下单 3 人、退信 2 人」 */
function excludedText(c: Campaign): string {
  if (!c.excluded || !c.excluded.length) return '';
  return '自动排除：' + c.excluded
    .map((e) => `${e.reason || '其他'} ${e.count} 人`)
    .join('、');
}

/** stats 是否全 0（全 0 → 「暂无回流数据」） */
function statsEmpty(c: Campaign): boolean {
  const s = c.stats;
  return !s || (!s.opened && !s.clicked && !s.recovered && !s.net);
}

/**
 * 批次状态卡（对话流内，campaign.act_id === act.id 的批次并列渲染）。
 * @param readonly true 时隐藏快捷按钮（邮件页等只读场景）
 */
export default function BatchCard({ c, readonly = false }: { c: Campaign; readonly?: boolean }) {
  const { sendMsg, streaming } = useApp();
  // 快捷按钮消息取批次名首词（如「A 加购未付」→「A 批次暂停」），由后端在对话里解析执行
  const short = (c.name || '').trim().split(/\s+/)[0] || '该批次';
  const canPause = !readonly && ['draft', 'scheduled', 'running'].includes(c.status);
  const canResume = !readonly && c.status === 'paused';
  const excluded = excludedText(c);

  return (
    <div style={{
      background: '#fff', border: '.5px solid var(--line-2)', borderRadius: 14,
      padding: '14px 16px', margin: '12px 0', boxShadow: 'var(--shadow-card)',
    }}>
      {/* 头部：批次名 + 六态徽标 + 快捷按钮 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1E293B' }}>📦 {c.name}</span>
        <CampaignStatusBadge status={c.status} />
        {(canPause || canResume) && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {canPause && (
              <button
                type="button"
                disabled={streaming}
                className="btn sm ghost"
                title={`在对话里发送「${short} 批次暂停」`}
                onClick={() => { if (!streaming) void sendMsg(`${short} 批次暂停`); }}
              >
                暂停
              </button>
            )}
            {canResume && (
              <button
                type="button"
                disabled={streaming}
                className="btn sm ghost"
                title={`在对话里发送「${short} 批次恢复」`}
                onClick={() => { if (!streaming) void sendMsg(`${short} 批次恢复`); }}
              >
                恢复
              </button>
            )}
          </span>
        )}
      </div>

      {/* 人群一句话 + 计数 */}
      <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
        {c.audience_desc || '—'}
      </div>
      <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>已发 <b>{c.sent_count || 0}</b> 人</span>
        <span>未发 <b>{c.pending_count || 0}</b> 人</span>
        {c.holdout_count > 0 && <span style={{ color: 'var(--muted)' }}>对照组 {c.holdout_count} 人</span>}
      </div>

      {/* 折扣码短标 + 优惠说明（discount 缺省时整行隐藏） */}
      {c.discount && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DiscountMini c={c} />
          {c.discount.text && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{c.discount.text}</span>}
        </div>
      )}

      {/* stats 一行：全 0 显示「暂无回流数据」 */}
      <div style={{
        marginTop: 10, padding: '7px 10px', borderRadius: 8, background: 'var(--bg-input)',
        fontSize: 12, color: statsEmpty(c) ? 'var(--soft)' : 'var(--text)',
      }}>
        {statsEmpty(c)
          ? '暂无回流数据'
          : <>打开 <b>{c.stats.opened}</b> · 点击 <b>{c.stats.clicked}</b> · 已挽回 <b>{c.stats.recovered}</b> 人 · 净回流 <b>${(c.stats.net || 0).toFixed(2)}</b></>}
      </div>

      {/* 顺延/恢复提示（如「黑五已过，已恢复排程」） */}
      {c.resume_note && (
        <div style={{
          marginTop: 8, padding: '7px 10px', borderRadius: 8, background: 'var(--warn-bg)',
          fontSize: 12, color: 'var(--warn2)', fontWeight: 600,
        }}>
          ⏱ {c.resume_note}
        </div>
      )}

      {/* 自动排除摘要一行 */}
      {excluded && (
        <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--muted)' }}>{excluded}</div>
      )}
    </div>
  );
}

/**
 * 只读批次条（邮件配置 tab 草稿列表上方）：名称 / 状态 / 已发未发，不可操作。
 * PRD「列表页只读展示」——管理动作引导回对话（title 提示）。
 */
export function BatchStrip({ campaigns }: { campaigns: Campaign[] }) {
  if (!campaigns.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1E293B' }}>发送批次</span>
        <span style={{ fontSize: 11.5, color: 'var(--soft)' }}>只读 · 暂停 / 恢复等管理动作在「助手」对话里完成</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {campaigns.map((c) => (
          <div
            key={c.id}
            title="批次在「助手」对话里管理：发送「{批次名首词} 批次暂停 / 恢复」即可"
            style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              background: '#fff', border: '.5px solid var(--line-2)', borderRadius: 10,
              padding: '9px 14px', fontSize: 12.5, color: 'var(--text)',
            }}
          >
            <span style={{ fontWeight: 700 }}>📦 {c.name}</span>
            <CampaignStatusBadge status={c.status} />
            <span style={{ color: 'var(--muted)', marginLeft: 'auto', display: 'flex', gap: 12 }}>
              <span>已发 <b style={{ color: 'var(--text)' }}>{c.sent_count || 0}</b></span>
              <span>未发 <b style={{ color: 'var(--text)' }}>{c.pending_count || 0}</b></span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
