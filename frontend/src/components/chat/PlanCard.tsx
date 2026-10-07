'use client';

/**
 * 对话流内方案卡（Wave2）—— confirm 接口 200 后渲染在确认卡之后：
 *  - 折扣码真实徽标：created=绿「已在店铺创建」/ reused=「沿用店内已有码」/ none=灰条「未创建」
 *  - estGmv 金额大字 + 预估/数据来源角标 + 点击展开算式（people × aov × rate% − discount_cost）
 *  - 署名 / 发送方式 / 语种元信息行；退订检测暂时隐藏
 *  - 发送核对单 + 对照组；时段外显示定时发送，其他阻断项仍显示原因
 *  - 点击 POST /api/draft/:id/send，由服务端在时段外预约任务，
 *    服务端闸门 409 时由 AppProvider 用最新 checklist 刷新本卡（红字标原因）。
 * 数据源：AppProvider.confirmState（S3 态改口回 S2 时整体复位，卡片随 act.stage 消失）。
 */
import { useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { planSendState } from '@/lib/chat-flow';
import type { Holdout, PlanCard, PlanCardDiscount } from '@/lib/types';

/** USD 金额（新契约 estGmv.currency='USD'） */
function money(n: number | undefined | null): string {
  return '$' + (Number(n) || 0).toFixed(2);
}

/** 折扣码徽标：code_status 三态 + 默认码（店铺未连接）变体 */
function DiscountBadge({ dis }: { dis?: PlanCardDiscount }) {
  if (!dis) return null;
  if (dis.code_status === 'created' && dis.default && dis.code) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          background: 'var(--bg-input)', color: 'var(--text)', border: '.5px solid var(--line)',
          borderRadius: 999, padding: '4px 12px', fontSize: '12.5px', fontWeight: 700,
        }}>
          🎟 折扣码 {dis.code} · 默认码（店铺未连接）
        </span>
        <span style={{ color: 'var(--muted)', fontSize: '12.5px' }}>连接店铺后可替换为真实店铺券</span>
      </div>
    );
  }
  if (dis.code_status === 'created' && dis.code) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          background: 'var(--ok-bg)', color: 'var(--ok2)', border: '.5px solid var(--ok-line)',
          borderRadius: 999, padding: '4px 12px', fontSize: '12.5px', fontWeight: 700,
        }}>
          🎟 折扣码 {dis.code} · 已在你的店铺创建 ✅
        </span>
        {dis.text && <span style={{ color: 'var(--muted)', fontSize: '12.5px' }}>{dis.text}</span>}
      </div>
    );
  }
  if (dis.code_status === 'reused' && dis.code) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          background: 'var(--bg-input)', color: 'var(--text)', border: '.5px solid var(--line)',
          borderRadius: 999, padding: '4px 12px', fontSize: '12.5px', fontWeight: 700,
        }}>
          🎟 沿用店内已有码 {dis.code}
        </span>
        {dis.text && <span style={{ color: 'var(--muted)', fontSize: '12.5px' }}>{dis.text}</span>}
      </div>
    );
  }
  // none（或 code 缺失）：灰条说明，不冒充有码
  return (
    <div style={{
      border: '.5px dashed var(--line)', background: 'var(--bg-input)', color: 'var(--muted)',
      borderRadius: 10, padding: '8px 12px', fontSize: '12.5px',
    }}>
      未创建折扣码：连接店铺后可补{dis.text ? `（钩子：${dis.text}）` : ''}
    </div>
  );
}

/** 元信息行：label 左 / value 右，虚线分隔 */
function Row({ k, v, danger }: { k: string; v?: string | null; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '.5px dashed #DDE2E8', fontSize: '13px' }}>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
      <span style={{ textAlign: 'right', color: danger ? 'var(--danger)' : 'var(--text)', fontWeight: danger ? 600 : 400 }}>
        {v || '—'}
      </span>
    </div>
  );
}

/** 核对单项：pass 绿勾 / fail 红叉 + 红字 reason */
function CheckItem({ pass, label, reason }: { pass: boolean; label: string; reason?: string }) {
  if (pass) {
    return (
      <div style={{ fontSize: '12.5px', display: 'flex', gap: 7, alignItems: 'baseline' }}>
        <span style={{ color: 'var(--ok)', fontWeight: 700, flexShrink: 0 }}>✓</span>
        <span style={{ color: 'var(--text)' }}>{label}</span>
      </div>
    );
  }
  return (
    <div style={{ fontSize: '12.5px', display: 'flex', gap: 7, alignItems: 'baseline' }}>
      <span style={{ color: 'var(--danger)', fontWeight: 700, flexShrink: 0 }}>✗</span>
      <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
        {label}{reason ? `：${reason}` : ''}
      </span>
    </div>
  );
}

/** 对照组行：frozen=冻结说明；未冻结=warn 色说明（名单不足等 note） */
function HoldoutRow({ h }: { h: Holdout }) {
  if (h.frozen) {
    // ratio 兼容 0.1 / 10 两种口径，统一按百分数展示
    const pct = h.ratio != null ? (h.ratio <= 1 ? Math.round(h.ratio * 100) : Math.round(h.ratio)) : 10;
    return (
      <div style={{
        marginTop: 8, fontSize: '12.5px', color: 'var(--muted)',
        background: 'var(--bg-input)', borderRadius: 8, padding: '7px 10px',
      }}>
        🔒 对照组 {h.count} 人 · 不发送 · 冻结 {pct}%
      </div>
    );
  }
  return (
    <div style={{
      marginTop: 8, fontSize: '12.5px', color: 'var(--warn2)',
      background: 'var(--warn-bg)', borderRadius: 8, padding: '7px 10px',
    }}>
      ⚠ {h.note || `名单不足，本轮不设对照组（${h.count} 人）`}
    </div>
  );
}

export default function PlanCardView() {
  const { confirmState, sendConfirmedPlan, drafts, notifications, switchTab } = useApp();
  const [gmvOpen, setGmvOpen] = useState(false);
  const [sending, setSending] = useState(false);
  if (!confirmState) return null;

  const card: PlanCard = confirmState.planCard;
  const checklist = confirmState.checklist;
  const checklistError = confirmState.checklistError ?? null;
  const est = card.estGmv;
  const f = est?.formula;
  const { items, failItems, canSend: allPass, scheduled } = planSendState(checklist);
  const holdout = confirmState.holdout ?? checklist?.holdout ?? null;
  // 本卡对应草稿是否已在发送生命周期（防双击重发；发送成功后沿用现有状态流）
  const mine = drafts.find((d) => d.id === card.draft_id);
  const alreadySent = Boolean(mine && ['queued', 'sending', 'sent', 'recovering'].includes(mine.status));
  // estGmv 预估→实际翻转（Wave4）：本方案（draft_id 或所属 act 匹配）已有 recover 报喜通知 →
  // 「预估」角标翻转为「实际」。不做 body 数字解析（各通知文案不稳定），存在报喜即翻转并提示。
  const hasRecover = (notifications || []).some((n) => n.type === 'recover' && (
    Boolean(card.draft_id && n.draft_id === card.draft_id) ||
    Boolean(confirmState.actId && n.act_id === confirmState.actId)
  ));

  const onSend = async () => {
    if (sending || alreadySent) return;
    setSending(true);
    try { await sendConfirmedPlan(); } finally { setSending(false); }
  };

  return (
    <div style={{
      background: '#fff', border: '.5px solid var(--line-2)', borderRadius: 16,
      padding: 20, margin: '12px 0', boxShadow: 'var(--shadow-card)',
    }}>
      {/* 头部：受众 + 预计触达 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#1E293B' }}>📋 挽回方案卡</span>
        <span style={{ color: 'var(--muted)', fontSize: '12.5px' }}>
          {card.audience || '—'}{card.reach_count != null ? ` · 预计触达 ${card.reach_count} 人` : ''}
        </span>
      </div>

      {/* 折扣码徽标 */}
      <DiscountBadge dis={card.discount} />

      {/* estGmv：大字 + 角标（报喜通知到达后「预估」翻转为「实际」）+ 可展开算式 */}
      {est && (
        <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-input)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hasRecover ? '实际回流' : '预估回流'}</span>
            <span style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-disp)', color: 'var(--text)', letterSpacing: '.2px' }}>
              {money(est.amount)}
            </span>
            {hasRecover ? (
              <>
                <span style={{
                  fontSize: 10.5, fontWeight: 700, color: 'var(--ok2)', background: 'var(--ok-bg)',
                  border: '.5px solid var(--ok-line)', borderRadius: 999, padding: '2px 8px',
                }}>实际</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ok2)' }}>有顾客用码回来了</span>
              </>
            ) : (
              <span style={{
                fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: '#fff',
                border: '.5px solid var(--line)', borderRadius: 999, padding: '2px 8px',
              }}>预估</span>
            )}
            {est.source === 'demo' ? (
              <span style={{
                fontSize: 10.5, fontWeight: 700, color: 'var(--warn2)', background: 'var(--warn-bg)',
                border: '.5px solid var(--warn-line)', borderRadius: 999, padding: '2px 8px',
              }}>演示数据</span>
            ) : (
              <span style={{
                fontSize: 10.5, fontWeight: 700, color: 'var(--ok2)', background: 'var(--ok-bg2)',
                border: '.5px solid var(--ok-line)', borderRadius: 999, padding: '2px 8px',
              }}>店铺实数</span>
            )}
            {f && (
              <button
                type="button"
                onClick={() => setGmvOpen(v => !v)}
                style={{
                  marginLeft: 'auto', background: '#fff', border: '.5px solid var(--line)', borderRadius: 7,
                  color: 'var(--muted)', fontSize: 11.5, fontWeight: 600, padding: '3px 9px', cursor: 'pointer',
                }}
              >
                算式 {gmvOpen ? '▴' : '▾'}
              </button>
            )}
          </div>
          {gmvOpen && f && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.7 }}>
              {f.people} 人 × 客单 {money(f.aov)} × 挽回率 {f.rate}% − 折扣成本 {money(f.discount_cost)}
              {' = '}<b style={{ color: 'var(--text)' }}>{money(est.amount)}</b>
            </div>
          )}
        </div>
      )}

      {/* 元信息：署名 / 发送方式 / 语种（核对单未拉回前发送方式不预判，显示核对中） */}
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
        <Row k="署名" v={card.signature} />
        <Row k="发送方式" v={checklist ? (scheduled ? `定时发送（${card.send_window || '下一发送时段'}）` : '立即发送，时段外自动定时') : '核对中…'} />
        <Row k="语种" v={card.language} />
      </div>

      {/* 发送核对单：退订项暂时隐藏，时段项展示为定时发送；恢复中/失败给明确行，不留空白 */}
      {checklist && items.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '.5px dashed var(--line)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1E293B', marginBottom: 7, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            发送前核对单
            <span style={{ fontSize: 11.5, fontWeight: 700, color: failItems.length ? 'var(--danger)' : 'var(--ok2)' }}>
              {items.length - failItems.length}/{items.length} 通过
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {items.map((it) => (
              <CheckItem key={`${it.gate}-${it.label}`} pass={it.pass} label={it.label} reason={it.reason} />
            ))}
          </div>
          {holdout && <HoldoutRow h={holdout} />}
        </div>
      )}
      {!checklist && !alreadySent && (
        <div style={{
          marginTop: 12, fontSize: 12.5, color: checklistError ? 'var(--warn2)' : 'var(--muted)',
          background: checklistError ? 'var(--warn-bg)' : 'var(--bg-input)',
          borderRadius: 8, padding: '7px 10px',
        }}>
          {checklistError
            ? `发送条件未核对：${checklistError}。为防误发，本卡发送入口保持关闭。`
            : '正在核对发送条件（时段/频次/署名/金额与码）…'}
        </div>
      )}

      {/* 发送行：仅阻断项禁用，时段外允许提交定时任务；无核对单一律禁用（planSendState fail-safe） */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {alreadySent ? (
          <span style={{ color: 'var(--ok2)', fontWeight: 700, fontSize: 13 }}>
            {mine?.status === 'queued' ? (mine.scheduled_at ? `邮件已定时，将于 ${new Date(mine.scheduled_at).toLocaleString('zh-CN')} 发送` : '邮件已排队，等待发送') : mine?.status === 'sending' ? '邮件发送中…' : '✓ 邮件已发送'}
          </span>
        ) : (
          <>
            <button className="btn primary" onClick={onSend} disabled={sending || !allPass}>
              {sending ? '提交中…' : scheduled ? '确认定时发送' : '确认发送'}
            </button>
            {!allPass && checklist && (
              <span style={{ color: 'var(--danger)', fontSize: '12.5px', fontWeight: 600 }}>
                {failItems.length} 项未过，修复后重试
              </span>
            )}
          </>
        )}
        {/* 商品图入口（批次 1 拍板：上传在设置页，对话流只放跳转按钮）：
            选用后邮件 Hero 直接用商家商品图（万相图生图场景化 / 原图叠字），不在对话流内做上传 */}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => switchTab('set')}
          title="到设置页上传并选用商品图，邮件主图将直接使用"
          style={{ marginLeft: 'auto' }}
        >
          🖼 去设置页选商品图
        </button>
      </div>
    </div>
  );
}
