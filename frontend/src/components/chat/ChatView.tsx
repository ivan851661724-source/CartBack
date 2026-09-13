'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { NavChat, Arrow } from '@/components/ui/icons';
import { BRAND_POINTS, INTENT_POINTS } from '@/lib/constants';
import { api } from '@/lib/api';
import type { Draft } from '@/lib/types';
import MessageBubble from './MessageBubble';
import ConfirmCard from './ConfirmCard';
import PlanCardView from './PlanCardView';
import SentBanner from './SentBanner';
import OpportunityCard from './OpportunityCard';

const EDIT_HINT = '说说要改哪块：受众、钩子、折扣还是发送时机…';

/** 助手（对话）视图 —— 对应 flow.html #view-chat + app.js renderChat/sendMsg UI */
export default function ChatView() {
  const {
    act, acts, drafts, opportunities, streaming, streamingText, planShown, lastSent,
    chatInput, chatPlaceholder, sendMsg, setChatInput, setChatPlaceholder,
    setPlanShown, setPlanPushed, confirmSendPlan, createCardDraft, switchTab, setHistoryOpen, loadState,
    setEditingDraft, setEditOpen, setDraftGenerating, toast_,
    onboardingStep, onboardingSkipped, skipOnboarding, setOnboardingStep, guideStyle,
  } = useApp();

  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [clickedChips, setClickedChips] = useState<Set<number>>(new Set());

  const n = act?.needs ? (Object.values(act.needs) as string[]).filter(Boolean).length : 0;
  const messages = act?.messages || [];
  const hasOpportunities = Boolean(opportunities && (opportunities.newCount || opportunities.untargeted));
  // 初始态（引导期）：右侧显示需求收集 checklist；引导走完/跳过后切回机会列表
  const showOnboarding = !onboardingSkipped && onboardingStep < 4;
  // 引导风格开关：demo=硬编码品牌词+浮层引导+checklist；safe=纯意图词+顶栏串联引导
  const isDemoGuide = guideStyle === 'demo';
  const chips = isDemoGuide ? BRAND_POINTS : INTENT_POINTS;
  // 已收集的品牌信息条数：从持久化的 messages 派生（clickedChips 是 ChatView 局部 state，
  // 切页卸载会重置 → 之前用 clickedChips.size 门控确认卡导致切页回来卡消失；改用持久计数）
  const collectedCount = isDemoGuide
    ? messages.filter((m) => m.role === 'user' && BRAND_POINTS.some((bp) => bp.msg === m.content)).length
    : 0;
  const collectedAll = isDemoGuide ? collectedCount >= BRAND_POINTS.length : true;
  // 本会话是否已发过邮件（确认卡据此隐藏「可以，去发」）
  const hasSentForAct = (drafts || []).some(
    (d) => d.act_id === act?.id && ['queued', 'sending', 'sent', 'recovering'].includes(d.status),
  );

  // ② 受众圈选条件预览（确认卡核对用；与发送端 /api/draft 同口径）
  const [audConditions, setAudConditions] = useState<{ matchedCount: number; estGmv: number; filters: { value: string | number }[] } | null>(null);
  const planAudience = act?.planCard?.audience || '';
  useEffect(() => {
    if (planShown !== 'confirm' || !planAudience) { setAudConditions(null); return; }
    let alive = true;
    api<{ matchedCount: number; estGmv: number; filters: { value: string | number }[] }>('/api/audience/preview', {
      method: 'POST', body: JSON.stringify({ audience: planAudience }),
    }).then((r) => { if (alive && r && (r as any).filters) setAudConditions(r); }).catch(() => {});
    return () => { alive = false; };
  }, [planShown, planAudience]);

  // 自动滚到底（消息变化 / 流式 token / 卡片出现）
  useEffect(() => {
    const el = areaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, planShown, streaming]);

  // 步骤1→2 自动跳步：10 项收集完 + 回复结束 + planCard 就绪 → 推进到步骤2（需求确认卡）+ 生成草稿
  // 保持 planShown='confirm'（#1 确认卡持久化），不切 tab（由 GuideOverlay 气泡指向确认卡让用户点「可以，去发」）
  const advanced0Ref = useRef(false);
  useEffect(() => { if (clickedChips.size === 0) advanced0Ref.current = false; }, [clickedChips.size]);
  useEffect(() => {
    if (!isDemoGuide || onboardingStep !== 0 || advanced0Ref.current) return;
    if (clickedChips.size >= BRAND_POINTS.length && !streaming && act?.planCard) {
      advanced0Ref.current = true;
      const card = act.planCard;
      (async () => {
        setOnboardingStep(1);
        setDraftGenerating(true);
        try { await createCardDraft(act.id, card); await loadState(); }
        catch (e: any) { toast_('草稿生成失败：' + (e?.message || e)); }
        setDraftGenerating(false);
      })();
    }
  }, [isDemoGuide, onboardingStep, clickedChips, streaming, act, setOnboardingStep, createCardDraft, loadState, setDraftGenerating, toast_]);

  const focusInput = () => {
    const i = inputRef.current;
    if (i) { i.focus(); i.placeholder = EDIT_HINT; }
  };
  const onReconsider = () => { setPlanShown(null); setPlanPushed(false); focusInput(); setChatPlaceholder(EDIT_HINT); };
  const onEdit = () => { focusInput(); setChatPlaceholder(EDIT_HINT); };

  const onSend = () => sendMsg(chatInput);

  return (
    <div className="view-body chat-view-body">
      <div className="chat-workspace">
        <section className="chat-shell" aria-label="挽回策略对话">
        <div className="chat-wrap">
          <div className="chat-head">
            <div className="ch-av"><NavChat /></div>
                          <div className="ch-copy">
                            <span className="ch-kicker">当前会话</span>
                            <span className="ch-t">{!onboardingSkipped && onboardingStep < 4 ? '运营助手' : '挽回策略助手'}</span>
                          </div>
                          <span className="ch-s"><span className="dot"></span><span>在线 · 已记录 {n}/4 项</span></span>
            <button
              className="btn ghost sm ch-hist"
              onClick={() => setHistoryOpen(true)}
              title="历史会话"
            >
              会话 {acts.length > 0 ? acts.length : ''}
            </button>
          </div>

          <div className="chat-area" ref={areaRef} aria-live="polite" aria-label="对话消息区">
            {messages.length === 0 && !streaming && (
              <div className="msg agent">
                <div className="avatar agent"><NavChat /></div>
                <div className="bubble">
                  {!onboardingSkipped && onboardingStep < 4
                    ? '点击左侧快捷描述，告诉助手你的品牌信息'
                    : '你好，我是你的挽回邮件教练。\n告诉我你想挽回哪类人、为什么、希望拿到什么结果，我帮你一步步生成方案卡。'}
                </div>
              </div>
            )}

            {messages.map((m, i) => <MessageBubble key={i} m={m} />)}

            {/* ② 主动轻提示：四要素齐了但一直没触发确认卡 → 轻推一句（非弹窗、非表单） */}
            {!streaming && n >= 4 && !act?.planCard && !planShown && messages.length > 4 && (
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

            {/* 对话流内联卡（planShown 状态机） */}
            {/* demo：10 个 chip 全点完才弹确认卡（后端在 4 项 needs 攒齐时就产出 planCard，
                约第 6 个 chip，太早；demo 要求攒满 10 再展示）。safe：planCard 一到就弹。
                门控用 collectedAll（从持久 messages 派生），切页回来不会因局部 state 重置而消失。 */}
            {planShown === 'confirm' && act?.planCard && (!isDemoGuide || collectedAll) && (
              <div data-guide-target="guide-confirm" style={{background:'#fff',border:'.5px solid var(--line-2)',borderRadius:'16px',padding:'20px',margin:'12px 0',boxShadow:'var(--shadow-card)'}}>
                <div style={{fontSize:'16px',fontWeight:700,color:'#1E293B',marginBottom:'12px'}}>⚡ 需求已收集完整！</div>
                <div style={{display:'flex',flexDirection:'column',gap:'6px',marginBottom:'14px'}}>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'.5px dashed #DDE2E8',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>针对谁</span><span>{act.planCard.audience || '—'}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'.5px dashed #DDE2E8',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>为什么挽回</span><span>{act.planCard.pain || '—'}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'.5px dashed #DDE2E8',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>要什么结果</span><span>{act.planCard.goal || '—'}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>给什么钩子</span><span>{act.planCard.discount || act.planCard.offer || '—'}</span></div>
                </div>
                {audConditions && (
                  <div style={{display:'flex',flexDirection:'column',gap:'6px',marginBottom:'14px',paddingTop:'10px',borderTop:'.5px dashed #DDE2E8',fontSize:'12.5px'}}>
                    <div style={{fontWeight:600,color:'#1E293B',marginBottom:'2px'}}>受众圈选条件（发送前请核对）</div>
                    <div style={{color:'var(--muted)'}}>条件：{audConditions.filters.map((f) => String(f.value)).join(' · ')}</div>
                    <div style={{color:'var(--muted)'}}>预计触达 {audConditions.matchedCount} 人 · 预估可挽回 ¥{audConditions.estGmv}（预估）</div>
                    <div style={{color:'var(--muted)'}}>发送时按 3 类人群生成 3 个变体（价格敏感 / 高意向 / 标准），语种跟随收件人。</div>
                  </div>
                )}
                <div style={{display:'flex',gap:'9px',alignItems:'center'}}>
                  {hasSentForAct ? (
                    <>
                      <span style={{fontSize:'13px',color:'var(--ok2)',fontWeight:600}}>✓ 邮件已发送</span>
                      <button className="btn ghost" onClick={() => switchTab('data')}>查看数据看板 →</button>
                    </>
                  ) : (
                    <>
                      <button className="btn primary" onClick={async () => {
                        const card = act.planCard;
                        if (!card) return;
                        // 不切 planShown（保留确认卡在对话流中）；跳邮件 tab + 预建草稿 + 打开预览
                        switchTab('mail');
                        setDraftGenerating(true);
                        try {
                          const d = await createCardDraft(act.id, card);   // 预建草稿（确认发送复用同一条，防僵尸草稿）
                          await loadState();
                          setEditingDraft(d); setEditOpen(true);            // 草稿就绪→打开预览
                        } catch (e: any) {
                          // 失败必须可见（此前静默吞掉 → 跳到邮件页后无任何反馈）；留在确认卡方便重试
                          toast_('草稿生成失败：' + (e?.message || e));
                          switchTab('chat');
                        }
                        setDraftGenerating(false);
                      }}>可以，去发</button>
                      <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
                    </>
                  )}
                </div>
              </div>
            )}
            {planShown === 'plan' && act?.planCard && (
              <PlanCardView card={act.planCard} onEdit={onEdit} onSend={() => confirmSendPlan(act.planCard!)} />
            )}
            {planShown === 'sent' && lastSent && (
              <SentBanner res={lastSent.res} draft={lastSent.draft} onSeeFlow={() => switchTab('data')} />
            )}
          </div>

          <div data-guide-target="guide-compose" style={{display:'flex',flexDirection:'column',flexShrink:0}}>
          {/* 初始引导快捷描述词（与右侧 checklist 共用 BRAND_POINTS） */}
          {showOnboarding && (
            <div style={{display:'flex',gap:'8px',padding:'8px 16px',flexWrap:'wrap',flexShrink:0}}>
              {chips.map((chip, i) => {
                const clicked = clickedChips.has(i);
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={streaming}
                    onClick={() => {
                      const next = new Set(clickedChips);
                      next.add(i);
                      setClickedChips(next);
                      // demo：点击即发（驱动 LLM 对话 + 攒齐自动跳步）
                      // safe（P0-4）：全新会话首条直发，已有上下文只填入输入框待商家确认，
                      //               防止快捷词把已聊的品牌信息带走
                      if (isDemoGuide) {
                        sendMsg(chip.msg);
                      } else {
                        const fresh = messages.filter((m) => m.role === 'user').length === 0 && n === 0;
                        if (fresh) sendMsg(chip.msg);
                        else { setChatInput(chip.msg); inputRef.current?.focus(); }
                      }
                    }}
                    style={{
                      display:'inline-flex',alignItems:'center',gap:'6px',
                      padding:'7px 13px',borderRadius:'9px',
                      border: clicked ? '0.5px solid transparent' : '0.5px solid #DDE2E8',
                      background: clicked ? 'var(--brand-soft)' : '#fff',
                      color: clicked ? 'var(--brand)' : 'var(--text)',
                      fontSize:'12.5px',fontWeight:500,
                      cursor: streaming ? 'not-allowed' : 'pointer',
                      opacity: streaming && !clicked ? 0.45 : 1,
                      whiteSpace:'nowrap',transition:'all .15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!clicked && !streaming) {
                        e.currentTarget.style.borderColor = '#FF7F4D';
                        e.currentTarget.style.background = 'var(--brand-soft)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!clicked && !streaming) {
                        e.currentTarget.style.borderColor = '#DDE2E8';
                        e.currentTarget.style.background = '#fff';
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {clicked
                        ? <path d="M20 6L9 17l-5-5" />
                        : i === 0 ? <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="9" x2="15" y2="9" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="12" y2="17" /></>
                        : i === 1 ? <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></>
                        : i === 2 ? <><circle cx="12" cy="12" r="10" /><path d="M16 8h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2Z" /></>
                        : i === 3 ? <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>
                        : <><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></>
                      }
                    </svg>
                    {chip.label}
                  </button>
                );
              })}
            </div>
          )}

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
          <div className="compose-hint">开放式对话 · 信息后台静默采集 · 齐了才弹确认</div>
          </div>
        </div>
        </section>

        {(isDemoGuide && showOnboarding) || hasOpportunities ? (
          <aside className="opportunity-rail" aria-label={isDemoGuide && showOnboarding ? '需求收集进度' : '待处理机会'}>
            {isDemoGuide && showOnboarding ? (
              <OnboardingChecklist
                collected={clickedChips}
                onAdvance={async () => {
                  // 手动兜底（自动跳步 effect 通常先触发）：推进步骤2 + 生成草稿。
                  // 保持 planShown='confirm'（#1 确认卡持久化），不切 tab（由引导气泡指向侧栏）。
                  const card = act?.planCard;
                  if (!card) { toast_('需求尚未收集完整，回到对话补全四要素后再生成邮件'); return; }
                  setOnboardingStep(1);
                  setDraftGenerating(true);
                  try { await createCardDraft(act.id, card); await loadState(); }
                  catch (e: any) { toast_('草稿生成失败：' + (e?.message || e)); }
                  setDraftGenerating(false);
                }}
              />
            ) : (
              <OpportunityCard />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 初始引导右侧 checklist —— 对齐 Figma AgentPage「📋 需求收集进度」(App.tsx:352-401)。
 * 圆勾选框 + 标签 + 右侧已填短值 + 虚线分隔 + 进度条 + 底部完成按钮。
 * collected 为已点 chip 的索引集合；完成按钮推进引导下一步（引导走完才切回机会列表）。
 */
function OnboardingChecklist({ collected, onAdvance }: { collected: Set<number>; onAdvance: () => void }) {
  const total = BRAND_POINTS.length;
  const done = collected.size;
  const allDone = done >= total;
  return (
    <div className="opp-card" style={{ gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="disp" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>📋 需求收集进度</span>
        <span style={{ color: 'var(--brand)', fontWeight: 800, fontFamily: 'var(--font-disp)', fontSize: 15 }}>
          {done}<span style={{ color: 'var(--soft)', fontWeight: 400, fontSize: 12 }}>/{total}</span>
        </span>
      </div>

      <div style={{ height: 6, background: 'var(--bg-input)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${(done / total) * 100}%`, background: 'var(--brand)',
          borderRadius: 999, transition: 'width .5s var(--ease)',
        }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {BRAND_POINTS.map((p, i) => {
          const c = collected.has(i);
          return (
            <div key={p.key} style={{
              display: 'flex', gap: 9, alignItems: 'flex-start',
              padding: '7px 0', borderBottom: '.5px dashed var(--line)', fontSize: 12,
            }}>
              <div style={{
                width: 17, height: 17, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: c ? 'var(--brand)' : '#fff', border: `.5px solid ${c ? 'var(--brand)' : 'var(--line)'}`,
                color: '#fff', fontSize: 9, fontWeight: 700, transition: 'all .2s',
              }}>{c ? '✓' : ''}</div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ color: c ? 'var(--text)' : 'var(--muted)', flexShrink: 0 }}>{p.label}</span>
                {c && p.val && (
                  <span style={{
                    color: 'var(--muted)', fontSize: 11, textAlign: 'right',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{p.val}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {allDone ? (
        <button className="btn primary" onClick={onAdvance} style={{ width: '100%', justifyContent: 'center', border: 'none' }}>
          设置完成！进入下一步 →
        </button>
      ) : (
        <button className="btn ghost" disabled style={{ width: '100%', justifyContent: 'center', border: 'none' }}>
          还需补全 {total - done} 个要点
        </button>
      )}
    </div>
  );
}
