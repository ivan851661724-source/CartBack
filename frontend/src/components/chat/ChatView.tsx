'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { NavChat, Arrow } from '@/components/ui/icons';
import { filledCount, needsValue, needsSource } from '@/lib/needs';
import { fmtTime } from '@/lib/format';
import { CHAT_PLACEHOLDER } from '@/lib/constants';
import { api } from '@/lib/api';
import { hasUnresolvedConflicts, replyChipsFor, conversationNumber } from '@/lib/chat-flow';
import type { Draft, LastPlan, NotificationItem, TodoItem } from '@/lib/types';
import MessageBubble from './MessageBubble';
import SentBanner from './SentBanner';
import OpportunityCard from './OpportunityCard';
import PlanCardView from './PlanCard';
import PreviewEditor from './PreviewEditor';
import ChoicesEditor from './ChoicesEditor';
import BatchCard from './BatchCard';
import type { BatchPreview } from '@/lib/types';

const EDIT_HINT = '说说要改哪块：受众、钩子、折扣还是发送时机…';

/** 回执气泡 type 角标文案（Z7）：t0=发送回执 / t24=回流汇报 / recover=报喜（system 不进对话流） */
const RECEIPT_TYPE_LABEL: Record<string, string> = { t0: '发送回执', t24: '回流汇报', recover: '报喜' };

/** E1 拦截轮识别组（仅用于「建议」角标）：done 帧 chips 命中其中之一且回复文本含「建议」→ 视为拦截建议气泡 */
const E1_CHIPS = ['换成替代方案', '就要这个折扣', '换主题行再打', '先不动'];


/** 助手（对话）视图 —— 对应 flow.html #view-chat + app.js renderChat/sendMsg UI */
export default function ChatView() {
  const {
    act, acts, drafts, opportunities, streaming, streamingText, planShown, lastSent,
    chatInput, chatPlaceholder, chips, askedSlot, engine, sendMsg, setChatInput, setChatPlaceholder,
    setPlanShown, setPlanPushed, switchTab, setHistoryOpen, planCollapsed, expandPlan,
    confirmState, confirmFailed, confirmBusy, confirmPlan, runAction,
    campaigns, pendingBatches,
    lastPlan, notifications,
    todos, resumeTodo, welcome,
  } = useApp();

  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // confirm 409 三出口：「改用店内现成码」的输入行展开 + 码值
  const [reuseOpen, setReuseOpen] = useState(false);
  const [reuseCode, setReuseCode] = useState('');
  const [choicesDirty, setChoicesDirty] = useState(false);
  useEffect(() => { setChoicesDirty(false); }, [act?.id, act?.business_version]);

  const n = filledCount(act?.needs);
  // 开场返回的出口选项仅在四项必要信息齐全后显示；槽位采集和澄清选项照常保留。
  const replyChips = replyChipsFor(act, chips, askedSlot);
  const messages = act?.messages || [];
  // E1 拦截轮「建议」角标：最新 agent 回复含「建议」且当前 chips 命中拦截组（换方案/要折扣/换主题/先不动）时，
  // 给该条气泡加灰色「建议」小标，帮商家一眼认出这是助手的替代建议（纯样式，chips 随下一条消息清空后角标随之消失）。
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; } }
  const lastAssistant = lastAssistantIdx >= 0 ? messages[lastAssistantIdx] : null;
  const e1Badge: string | undefined = !streaming && chips.length > 0
    && chips.some((c) => E1_CHIPS.includes(c))
    && typeof lastAssistant?.content === 'string' && lastAssistant.content.includes('建议')
    ? '建议' : undefined;
  const hasOpportunities = Boolean(opportunities && (opportunities.newCount || opportunities.untargeted));
  // 本会话是否已发过邮件（确认卡据此隐藏「可以，去发」）
  const hasSentForAct = (drafts || []).some(
    (d) => d.act_id === act?.id && ['queued', 'sending', 'sent', 'recovering'].includes(d.status),
  );
  const deliveredForAct = (drafts || []).some(d => d.act_id === act?.id && ['sent', 'recovering'].includes(d.status));
  // Wave3 批次域：本会话关联的正式批次（campaign.act_id === act.id）→ 对话流内并列批次状态卡
  const actCampaigns = campaigns.filter((c) => c.act_id === act?.id);
  // Wave4 Z7 回执：通知里属于当前会话且非 system 的条目（接口倒序 → 翻转为时间正序），
  // 在消息流末尾渲染为 agent 风格回执气泡；随 loadState/轮询刷新而出现。
  const actReceipts = (notifications || [])
    .filter((nt) => nt.act_id === act?.id && nt.type !== 'system')
    .slice()
    .reverse();

  // ② 受众圈选条件预览（确认卡核对用；与发送端 /api/draft 同口径）
  const [audConditions, setAudConditions] = useState<{ matchedCount: number; estGmv: number; filters: { value: string | number }[] } | null>(null);
  const planAudience = act?.planCard?.audience || '';
  useEffect(() => {
    if (act?.flow_version === 6 || planShown !== 'confirm' || !planAudience) { setAudConditions(null); return; }
    let alive = true;
    api<{ matchedCount: number; estGmv: number; filters: { value: string | number }[] }>('/api/audience/preview', {
      method: 'POST', body: JSON.stringify({ audience: planAudience }),
    }).then((r) => { if (alive && r && (r as any).filters) setAudConditions(r); }).catch(() => {});
    return () => { alive = false; };
  }, [planShown, planAudience, act?.flow_version]);

  // 自动滚到底（消息变化 / 流式 token / 卡片出现 / 回复 chips / 方案卡或建码失败卡出现 / 待确认批次、批次卡、回执气泡出现）
  useEffect(() => {
    const el = areaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, planShown, streaming, chips, confirmState, confirmFailed, pendingBatches.length, actCampaigns.length, actReceipts.length]);

  const focusInput = () => {
    const i = inputRef.current;
    if (i) { i.focus(); i.placeholder = EDIT_HINT; }
  };
  const onReconsider = () => { setPlanShown(null); setPlanPushed(false); focusInput(); setChatPlaceholder(EDIT_HINT); };

  const onSend = () => sendMsg(chatInput);

  // C4 goal 槽位级例外（P2-N4 复测 10-03）：goal 的 chips 是「要一个值」的类别入口而非答案本身——
  // 点击把类别词预填进输入框，商家补上具体值（多少单/多少金额）再发送；「我自己定」只聚焦输入框。
  // F1 出口 chip「其他需求」同构（自由输入出口，PRD F1 处理逻辑 4）：只聚焦输入框不发送；
  // 「好，帮我写一封」「介绍一下其他功能」按原文发送，分别进入 C6 推断补满（→D1）与 F5 功能导览。
  const onChipClick = (c: string) => {
    if (askedSlot === 'goal') {
      setChatInput(c === '我自己定' ? '' : `${c} `);
      setChatPlaceholder(c === '我自己定' ? '说说你要的结果，比如「本月挽回 100 单」' : CHAT_PLACEHOLDER);
      if (inputRef.current) inputRef.current.focus();
      return;
    }
    if (c === '其他需求') {
      setChatInput('');
      setChatPlaceholder('直接说你的需求，比如「上个月加购没付的想捞回来」');
      if (inputRef.current) inputRef.current.focus();
      return;
    }
    sendMsg(c);
  };

  // 确认卡（新契约）：四槽优先读 act.needs（三态对象走 needsValue），planCard 字段兜底；
  // source==='inferred' 的槽在该行显示「（我推断的，可改）」小标。
  const confirmCard = !streaming && !planCollapsed && (act?.flow_version === 6 || (!hasUnresolvedConflicts(act) && !askedSlot)) && planShown === 'confirm' && act?.planCard ? act.planCard : null;
  const needsNow = act?.needs ?? null;
  // planCard reason 兜底：新契约为 reason；旧后端历史数据仍是 pain（键已删，运行时兜底读一次）
  const cardReason = confirmCard ? (confirmCard.reason || (confirmCard as { pain?: string }).pain) : undefined;
  const confirmRaw: [string, string | undefined, boolean][] = confirmCard ? [
    ['挽回对象*必填', needsValue(needsNow?.audience) || confirmCard.audience, needsSource(needsNow?.audience) === 'inferred'],
    ['流失原因*必填', needsValue(needsNow?.reason) || cardReason, needsSource(needsNow?.reason) === 'inferred'],
    ['期待结果*必填', needsValue(needsNow?.goal) || confirmCard.goal, needsSource(needsNow?.goal) === 'inferred'],
    ['优惠方式*必填', needsValue(needsNow?.offer)
      || (typeof confirmCard.discount === 'string' ? confirmCard.discount : confirmCard.discount?.text)
      || confirmCard.offer, needsSource(needsNow?.offer) === 'inferred'],
  ] : [];
  const confirmRows: [string, string, boolean][] = confirmRaw.map(([label, v, inferred]) => [label, v || '—', inferred]);

  // Wave2 confirm 流：当前会话已确认（confirmState 属于本会话且 act 在 S3）→ 确认卡换已确认态、下方渲染方案卡
  const confirmedHere = Boolean(confirmState && confirmState.actId === act?.id && act?.stage === 'S3');

  const submitReuse = () => {
    const code = reuseCode.trim();
    if (!code) return;
    setReuseOpen(false);
    setReuseCode('');
    confirmPlan({ reuse_code: code });
  };

  return (
    <div className="view-body chat-view-body">
      <div className="chat-workspace">
        <section className="chat-shell" aria-label="挽回策略对话">
        <div className="chat-wrap">
          <div className="chat-head">
            <div className="ch-av"><NavChat /></div>
                          <div className="ch-copy">
                            <span className="ch-kicker">当前会话</span>
                            <span className="ch-t">智能邮件助手</span>
                          </div>
                          <span className="ch-s" style={engine === 'degraded' ? { color: 'var(--warn2)' } : undefined}>
                            <span className="dot"></span>
                            {/* G2 诚实三件套①（P2-N3）：头部状态必须与实际引擎档位一致——降级期不得谎报在线 */}
                            <span>{engine === 'degraded' ? '降级模式 · AI 未连接' : '在线'}</span>
                          </span>
            <button
              className="btn ghost sm ch-hist"
              onClick={() => setHistoryOpen(true)}
              title="历史会话"
            >
              会话 {conversationNumber(acts, act?.id) || ''}
            </button>
          </div>

          <div className="chat-area" ref={areaRef} aria-live="polite" aria-label="对话消息区">
            {/* Z4 空态（剧本 #23：不输入也见首条气泡）：welcome.eligible 时渲染后端 opening 预览
                （欢迎语+数据开场句+清单+出口句，与建会话 messages[0] 同源单点生成），此时不显示出口按钮；
                上方按需渲染「上次方案」复用卡与待办卡。无 opening（旧后端）→ 退回中性引导。 */}
            {messages.length === 0 && !streaming && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {lastPlan && <LastPlanCard plan={lastPlan} onUse={() => sendMsg('照上次的来')} />}
                {todos.length > 0 && <TodosCard todos={todos} onResume={resumeTodo} />}
                {welcome?.eligible && welcome.opening ? (
                  <>
                    <div className="msg agent">
                      <div className="avatar agent"><NavChat /></div>
                      <div className="bubble">{welcome.opening}</div>
                    </div>
                  </>
                ) : (
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 12, padding: '56px 16px', color: 'var(--muted)',
                  }}>
                    <div className="chat-empty-ic"><NavChat /></div>
                    <div style={{ fontSize: '13.5px', color: 'var(--muted)', textAlign: 'center', lineHeight: 1.7 }}>
                      把你的想法说给我，比如想挽回哪拨客人
                    </div>
                  </div>
                )}
              </div>
            )}

            {messages.map((m, i) => <MessageBubble key={i} m={m} badge={i === lastAssistantIdx ? e1Badge : undefined} />)}

            {/* ② 主动轻提示：四要素齐了但一直没触发确认卡 → 轻推一句（非弹窗、非表单） */}
            {!streaming && act?.flow_version !== 6 && n >= 4 && !act?.planCard && !planShown && messages.length > 4 && (
              <div className="msg agent">
                <div className="avatar agent"><NavChat /></div>
                <div className="bubble" style={{ opacity: 0.92 }}>
                  差不多齐了——要我现在按这些配一封挽回邮件吗？想先调整哪块也行。
                </div>
              </div>
            )}

            {streaming && (
              <div className="msg agent">
                <div className="avatar agent"><NavChat /></div>
                {streamingText
                  ? <div className="bubble">{streamingText}</div>
                  : <div className="bubble typing"><span /><span /><span /></div>}
              </div>
            )}

            {/* 常驻回复 chips：最新一条 agent 回复的后续快捷操作。
                来源：SSE done 帧 chips + 建会话响应的开场 chips（AppProvider 存 state，发送新消息即清空）；
                四槽齐全且停留 S2 时补上三个出口按钮；采集期隐藏提前下发的出口选项。
                数量不做截断（P2-N1：goal 槽 4 项是 C4 槽位级例外，
                slice(0,3) 会把「我自己定」自由输入出口永久截掉）。
                goal 槽 chips 走「chips+输入框」复合形态（P2-N4）：点击预填输入框补值，其余点击即发送。 */}
            {!streaming && act?.flow_version === 6 && (
              <div style={{ display: 'flex', gap: '8px', padding: '4px 0 0', flexWrap: 'wrap' }}>
                {(act.flow_state?.actions || []).filter(a => !['prepare_plan', 'save_preview', 'save_choices'].includes(a.kind)).map(action => (
                  <button
                    key={action.id}
                    disabled={confirmBusy || !action.enabled}
                    title={action.blockedReasons.join('；')}
                    onClick={() => action.kind === 'other' ? onReconsider() : runAction(action)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '7px 13px', borderRadius: '9px',
                      border: 'none', background: '#E6E9ED', color: 'var(--text)',
                      fontSize: '12.5px', fontWeight: 500, cursor: action.enabled ? 'pointer' : 'not-allowed',
                      whiteSpace: 'nowrap', transition: 'background .15s',
                      opacity: action.enabled ? 1 : 0.5,
                    }}
                    onMouseEnter={(e) => {
                      if (action.enabled) {
                        e.currentTarget.style.background = '#FF7F4D';
                        e.currentTarget.style.color = '#FFFFFF';
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#E6E9ED';
                      e.currentTarget.style.color = 'var(--text)';
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {!streaming && act?.flow_version === 6 && act.stage !== 'S3' && act.flow_state?.actions.find(a => a.kind === 'save_choices') && <ChoicesEditor key={`${act.id}:${act.business_version}:choices`} needs={act.needs} action={act.flow_state.actions.find(a => a.kind === 'save_choices')!} onDirty={setChoicesDirty} />}
            {act?.flow_state?.previous_preview && <details style={{ margin: '12px 16px', padding: 12, border: '1px solid #DDE2E8', borderRadius: 12 }}>
              <summary>上一版邮件预览已失效，仅供查看</summary>
              <strong>{act.flow_state.previous_preview.subject}</strong>
              <p style={{ whiteSpace: 'pre-wrap' }}>{act.flow_state.previous_preview.body}</p>
              <p>活动信息已更新，请重新生成并核对当前版本。</p>
            </details>}
            {!streaming && replyChips.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', padding: '4px 0 0', flexWrap: 'wrap' }}>
                {replyChips.map((c, i) => (
                  <button
                    key={`${i}-${c}`}
                    type="button"
                    disabled={streaming}
                    onClick={() => onChipClick(c)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '7px 13px', borderRadius: '9px',
                      border: 'none', background: '#E6E9ED', color: 'var(--text)',
                      fontSize: '12.5px', fontWeight: 500, cursor: 'pointer',
                      whiteSpace: 'nowrap', transition: 'background .15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#FF7F4D';
                      e.currentTarget.style.color = '#FFFFFF';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#E6E9ED';
                      e.currentTarget.style.color = 'var(--text)';
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}

            {/* 待确认批次卡组（Wave3 Z1 逐批确认）：done 帧 batches 存在时在最新 agent 回复下纵向渲染，
                每批一张虚线边框小卡 +「待确认」角标（区别于已创建批次的实线 BatchCard）。
                agent 提出建批方案但尚未创建——用户点 chips「确认建批」或回复确认语后后端才真正建批，
                本组卡随新消息清空，正式批次由 /api/state 的 campaigns 承接（下方批次状态卡）。 */}
            {!streaming && pendingBatches.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0 4px' }}>
                {pendingBatches.map((b, i) => <PendingBatchCard key={`${i}-${b.name}`} b={b} />)}
              </div>
            )}

            {/* 确认卡：渲染只由数据驱动（planShown='confirm' + 后端 planCard）。
                曾经 旧流程要求「本会话逐字点满 10 条品牌词」才放行 —— 跨会话/自由输入时
                计数永远不达标，卡被压制而模型仍在说「下面弹出确认标签」（线上实锤），已移除该门禁。 */}
            {confirmCard && (
              <div data-guide-target="guide-confirm" style={{background:'#fff',border:'.5px solid var(--line-2)',borderRadius:'16px',padding:'20px',margin:'12px 0',boxShadow:'var(--shadow-card)',maxWidth:'50%'}}>
                <div style={{fontSize:'16px',fontWeight:700,color:'#1E293B',marginBottom:'12px'}}>{act?.flow_version === 6 ? '邮件预览 · 尚未发送' : '⚡ 需求已收集完整！'}</div>
                {act?.flow_version === 6 && <PreviewEditor key={`${act.id}:${act.business_version}`} card={confirmCard} action={act.flow_state?.actions.find(a => a.kind === 'save_preview')} choicesDirty={choicesDirty} />}
                <div style={{display:'flex',flexDirection:'column',gap:'6px',marginBottom:'14px'}}>
                  {confirmRows.map(([label, value, inferred]) => (
                    <div key={label} style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:'12px',padding:'7px 0',borderBottom: label === '优惠方式' ? 'none' : '.5px dashed #DDE2E8',fontSize:'13px'}}>
                      <span style={{color:'#8A95A0',flexShrink:0}}>{label}</span>
                      <span style={{textAlign:'right'}}>
                        {value}
                        {inferred && <span style={{fontSize:'11px',color:'var(--muted)',marginLeft:'6px'}}>（我推断的，可改）</span>}
                      </span>
                    </div>
                  ))}
                </div>
                {/* C5 随信素材：商家在对话里补充的素材（act.memory.extras）随信附上——发送前在此回显核对。
                    value 兼容新契约三态对象（needsValue 读取）；key=brand 显示为「品牌名」，中文 key 直接展示。 */}
                {(act?.memory?.extras?.length ?? 0) > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, paddingTop: 10, borderTop: '.5px dashed #DDE2E8', fontSize: '12.5px' }}>
                    <div style={{ fontWeight: 600, color: '#1E293B', marginBottom: 2 }}>随信素材</div>
                    <div style={{ color: 'var(--muted)' }}>你说的素材都收好了：</div>
                    {(act!.memory!.extras || []).map((ex, i) => (
                      <div key={`${ex.key}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{ex.key === 'brand' ? '品牌名' : ex.key === 'category' ? '品类' : ex.key === 'aov' ? '客单价' : ex.key}</span>
                        <span style={{ textAlign: 'right', color: 'var(--text)' }}>{needsValue((ex as { value: unknown }).value) || '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
                {audConditions && (
                  <div style={{display:'flex',flexDirection:'column',gap:'6px',marginBottom:'14px',paddingTop:'10px',borderTop:'.5px dashed #DDE2E8',fontSize:'12.5px'}}>
                    <div style={{fontWeight:600,color:'#1E293B',marginBottom:'2px'}}>受众圈选条件（发送前请核对）</div>
                    <div style={{color:'var(--muted)'}}>条件：{audConditions.filters.map((f) => String(f.value)).join(' · ')}</div>
                    <div style={{color:'var(--muted)'}}>预计触达 {audConditions.matchedCount} 人 · 预估可挽回 ¥{audConditions.estGmv}（预估）</div>
                    <div style={{color:'var(--muted)'}}>发送时按 3 类人群生成 3 个变体（价格敏感 / 高意向 / 标准），语种跟随收件人。</div>
                  </div>
                )}
                <div style={{display:'flex',gap:'9px',alignItems:'center',flexWrap:'wrap'}}>
                  {hasSentForAct ? (
                    <>
                      <span style={{fontSize:'13px',color:'var(--ok2)',fontWeight:600}}>{deliveredForAct ? '✓ 邮件已发送' : '邮件已排队或正在发送'}</span>
                      <button className="btn ghost" onClick={() => switchTab('data')}>查看数据看板 →</button>
                    </>
                  ) : confirmedHere ? (
                    <>
                      <span style={{fontSize:'13px',color:'var(--ok2)',fontWeight:600}}>✓ 已确认方案</span>
                      <span style={{fontSize:'12.5px',color:'var(--muted)'}}>在下方方案卡核对后发送</span>
                      <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
                    </>
                  ) : (
                    <>
                      {act?.flow_version !== 6 && <button className="btn primary" disabled={confirmBusy || streaming} onClick={() => confirmPlan()}>
                        {confirmBusy ? '准备中…' : act?.flow_version === 6 ? '准备发送方案（不会发送）' : '可以，去发'}
                      </button>}
                      <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
                    </>
                  )}
                </div>
              </div>
            )}
            {/* confirm 409（建码失败）：原因 + 三条出口（重试 / 输入店内现成码 / 改发无钩子） */}
            {confirmFailed && (
              <div style={{background:'var(--danger-bg)',border:'.5px solid var(--danger)',borderRadius:'16px',padding:'16px 20px',margin:'12px 0'}}>
                <div style={{fontSize:'14px',fontWeight:700,color:'var(--danger)',marginBottom:'4px'}}>⚠ 折扣码创建失败</div>
                <div style={{fontSize:'12.5px',color:'var(--text)',marginBottom:'10px'}}>{confirmFailed.reason || '折扣码服务暂时不可用'}</div>
                <div style={{display:'flex',gap:'8px',alignItems:'center',flexWrap:'wrap'}}>
                  <button className="btn sm primary" disabled={confirmBusy} onClick={() => confirmPlan()}>重试建码</button>
                  <button className="btn sm ghost" disabled={confirmBusy} onClick={() => setReuseOpen(v => !v)}>改用店内现成码</button>
                  <button className="btn sm ghost" disabled={confirmBusy} onClick={() => confirmPlan({ nohook: true })}>改发无钩子提醒信</button>
                </div>
                {reuseOpen && (
                  <div style={{display:'flex',gap:'8px',marginTop:'10px'}}>
                    <input
                      value={reuseCode}
                      onChange={(e) => setReuseCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitReuse(); }}
                      placeholder="输入店内已有折扣码，如 SAVE20"
                      autoFocus
                      style={{flex:1,minWidth:0,border:'.5px solid var(--line)',borderRadius:'9px',padding:'8px 12px',fontSize:'13px',background:'#fff',color:'var(--text)',outline:'none'}}
                    />
                    <button className="btn sm primary" disabled={!reuseCode.trim() || confirmBusy} onClick={submitReuse}>使用该码</button>
                  </div>
                )}
              </div>
            )}
            {/* 方案卡（confirm 200 后渲染在确认卡之后）：折扣徽标 / estGmv 算式 / 五项核对单 / 确认发送 */}
            {confirmedHere && !planCollapsed && <PlanCardView />}
            {/* 需求③：方案/确认卡聊天后收起为一行记录，可随时展开；不再每轮弹出打断对话 */}
            {!streaming && planCollapsed && planShown === 'confirm' && act?.planCard && !hasSentForAct && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 16px 2px', fontSize: '12.5px', color: 'var(--muted)' }}>
                <span>📋 {act.stage === 'S3' ? '发送方案卡已收起（未发送，不影响继续聊天）' : '邮件预览卡已收起'}——记录保留在对话流中</span>
                <button className="btn sm ghost" onClick={expandPlan}>展开核对 / 发送</button>
              </div>
            )}
            {planShown === 'sent' && lastSent && (
              <SentBanner res={lastSent.res} draft={lastSent.draft} onSeeFlow={() => switchTab('data')} />
            )}

            {/* 批次状态卡（Wave3 Z3）：本会话关联批次（campaign.act_id === act.id）在对话流内并列展示，
                暂停/恢复等管理动作走卡上快捷按钮（发对应对话消息），后端处理完由回合末 loadState 刷新六态。 */}
            {actCampaigns.map((c) => <BatchCard key={c.id} c={c} />)}

            {/* Z7 回执气泡：本会话的发送回执/回流汇报/报喜通知在消息流末尾以 agent 风格呈现
                （灰色左边框 + type 角标区分普通回复）；其 chips 与常驻 chips 同机制（点击即 sendMsg），
                仅在常驻 chips 置空时渲染，避免与后端 done 帧 chips 冲突。 */}
            {actReceipts.map((nt) => (
              <ReceiptBubble key={nt.id} nt={nt} chipsEnabled={chips.length === 0 && !streaming} />
            ))}
          </div>

          <div data-guide-target="guide-compose" style={{display:'flex',flexDirection:'column',flexShrink:0}}>

          <div className="compose">
            <input
              ref={inputRef}
              type="text"
              value={chatInput}
              placeholder={chatPlaceholder}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
            />
            <button className="btn primary" onClick={onSend} disabled={streaming}>
              <Arrow /> 发送
            </button>
          </div>
          </div>
        </div>
        </section>

        {/* F4 进度唯一口径（09-30 报告）：进度全屏仅顶栏 HintPill 一处（n/4）；
            右栏只承载待处理机会，历史引导期不再渲染重复的 0/10 checklist */}
        {hasOpportunities ? (
          <aside className="opportunity-rail" aria-label="待处理机会">
            <OpportunityCard />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Z4「上次方案」摘要卡：last_plan 非空且当前对话为空时显示在空态上方（记忆复用入口）。
 * 整卡可点 = 发送「照上次的来」（走 sendMsg，由后端按记忆重建方案）。
 */
function LastPlanCard({ plan, onUse }: { plan: LastPlan; onUse: () => void }) {
  const hook = plan.offer_text || plan.discount_text || '';
  const symbol = plan.currency === 'USD' ? '$' : plan.currency ? plan.currency + ' ' : '¥';
  const rows: [string, string][] = [
    ['受众', plan.audience],
    ['钩子', hook || '—'],
    ['预估金额', symbol + (Number(plan.est_gmv_amount) || 0)],
    ['确认时间', fmtTime(plan.confirmed_at) || '—'],
  ];
  return (
    <button
      type="button"
      onClick={onUse}
      title="点击发送「照上次的来」，按上次方案再来一轮"
      style={{
        background: '#fff', border: '.5px solid var(--line-2)', borderRadius: 16, padding: '14px 18px',
        boxShadow: 'var(--shadow-card)', cursor: 'pointer', textAlign: 'left', width: '100%',
        fontFamily: 'inherit', transition: 'border-color .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--brand)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line-2)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>🗂 上次方案</span>
        {plan.campaign_name && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{plan.campaign_name}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: 'var(--brand)', whiteSpace: 'nowrap' }}>
          点击复用：照上次的来 →
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
            <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
            <span style={{ color: 'var(--text)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

/**
 * Z5「待办」卡（A4 收口的可见出口）：GET /api/state 顶层 todos（未 done 倒序 ≤20，AppProvider 缺省 []）。
 * 对话为空时渲染在「上次方案」卡之下——下次打开面板的首屏即见。每条一行（summary + 「继续」小按钮），
 * 整行可点 = resumeTodo → POST /api/todos/:id/resume 以原会话数据恢复对话；todos 为空时本区块不渲染。
 */
function TodosCard({ todos, onResume }: { todos: TodoItem[]; onResume: (id: string) => void }) {
  return (
    <div style={{
      background: '#fff', border: '.5px solid var(--line-2)', borderRadius: 16, padding: '14px 18px',
      boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1E293B', marginBottom: 4 }}>⏳ 待办</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {todos.map((t, i) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onResume(t.id)}
            title="继续这条待办：接着上次的方案聊"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              width: '100%', padding: '9px 0', background: 'none', border: 'none',
              borderBottom: i < todos.length - 1 ? '.5px dashed #DDE2E8' : 'none',
              cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
            }}
          >
            <span style={{
              fontSize: 12.5, color: 'var(--text)', minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{t.summary}</span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--brand)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              继续 →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Z7 回执气泡：本会话的 t0/t24/recover 通知渲染为 agent 风格气泡，灰色左边框 + type 角标区分
 * 普通回复（「发送回执 / 回流汇报 / 报喜」）。气泡下按需渲染通知自带 chips（chipsEnabled =
 * 常驻 chips 置空且非流式），点击 chip 即以该文案作为用户消息发送（与常驻 chips 同机制）。
 */
function ReceiptBubble({ nt, chipsEnabled }: { nt: NotificationItem; chipsEnabled: boolean }) {
  const { sendMsg, streaming } = useApp();
  const label = RECEIPT_TYPE_LABEL[nt.type] || '通知';
  const chips = chipsEnabled && Array.isArray(nt.chips)
    ? nt.chips.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : [];
  return (
    <div className="msg agent">
      <div className="avatar agent"><NavChat /></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, maxWidth: '100%' }}>
        <div className="bubble" style={{ borderLeft: '3px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: nt.body ? 4 : 0, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '1px 8px', flexShrink: 0,
              ...(nt.type === 'recover'
                ? { color: 'var(--ok2)', background: 'var(--ok-bg)', border: '.5px solid var(--ok-line)' }
                : { color: 'var(--muted)', background: 'var(--bg-input)', border: '.5px solid var(--line)' }),
            }}>{label}</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>{nt.title}</span>
            <span style={{ fontSize: 10.5, color: 'var(--soft)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
              {fmtTime(nt.created_at)}
            </span>
          </div>
          {nt.body && <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{nt.body}</div>}
        </div>
        {chips.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {chips.map((c, i) => (
              <button
                key={`${i}-${c}`}
                type="button"
                disabled={streaming}
                onClick={() => sendMsg(c)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  padding: '7px 13px', borderRadius: '9px',
                  border: '0.5px solid #DDE2E8', background: '#fff', color: 'var(--text)',
                  fontSize: '12.5px', fontWeight: 500, cursor: 'pointer',
                  whiteSpace: 'nowrap', transition: 'all .15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#FF7F4D';
                  e.currentTarget.style.background = 'var(--brand-soft)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#DDE2E8';
                  e.currentTarget.style.background = '#fff';
                }}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 待确认批次小卡（Wave3 Z1）：agent 提出的建批方案（done 帧 batches，尚未创建）。
 * 虚线边框 +「待确认」角标与已创建批次的实线 BatchCard 区分；确认动作走 chips
 * （后端下发「确认建批」/「改一下」），卡片本身无按钮、不可点。
 */
function PendingBatchCard({ b }: { b: BatchPreview }) {
  return (
    <div style={{
      position: 'relative', background: 'var(--bg-input)', border: '1.5px dashed var(--line)',
      borderRadius: 12, padding: '12px 14px', margin: '0 16px',
    }}>
      <span style={{
        position: 'absolute', top: -9, right: 12,
        background: '#fff', border: '.5px solid var(--warn-line)', color: 'var(--warn2)',
        borderRadius: 999, padding: '1px 8px', fontSize: 10.5, fontWeight: 700,
      }}>待确认</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>📦 {b.name}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>预计触达 <b style={{ color: 'var(--text)' }}>{b.reach_count || 0}</b> 人</span>
      </div>
      <div style={{ marginTop: 5, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {b.audience_desc && <span>人群：{b.audience_desc}</span>}
        {b.offer_text && <span>优惠：{b.offer_text}</span>}
      </div>
    </div>
  );
}

