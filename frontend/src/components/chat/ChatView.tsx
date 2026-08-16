'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import { NavChat, Arrow } from '@/components/ui/icons';
import { api } from '@/lib/api';
import MessageBubble from './MessageBubble';
import ConfirmCard from './ConfirmCard';
import PlanCardView from './PlanCardView';
import SentBanner from './SentBanner';
import OpportunityCard from './OpportunityCard';

const EDIT_HINT = '说说要改哪块：受众、钩子、折扣还是发送时机…';

/** 助手（对话）视图 —— 对应 flow.html #view-chat + app.js renderChat/sendMsg UI */
export default function ChatView() {
  const {
    act, acts, opportunities, streaming, streamingText, planShown, lastSent,
    chatInput, chatPlaceholder, sendMsg, setChatInput, setChatPlaceholder,
    setPlanShown, setPlanPushed, confirmSendPlan, switchTab, setHistoryOpen, loadState,
    onboardingStep, onboardingSkipped, skipOnboarding, setOnboardingStep,
  } = useApp();

  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [clickedChips, setClickedChips] = useState<Set<number>>(new Set());

  const n = act?.needs ? (Object.values(act.needs) as string[]).filter(Boolean).length : 0;
  const messages = act?.messages || [];
  const hasOpportunities = Boolean(opportunities && (opportunities.newCount || opportunities.untargeted));

  // 自动滚到底（消息变化 / 流式 token / 卡片出现）
  useEffect(() => {
    const el = areaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, planShown, streaming]);

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
                    ? '点击下方快捷描述，告诉助手你的品牌信息'
                    : '你好，我是你的挽回邮件教练。\n告诉我你想挽回哪类人、为什么、希望拿到什么结果，我帮你一步步生成方案卡。'}
                </div>
              </div>
            )}

            {messages.map((m, i) => <MessageBubble key={i} m={m} />)}

            {streaming && (
              <div className="msg agent">
                <div className="avatar agent"><NavChat /></div>
                {streamingText
                  ? <div className="bubble">{streamingText}</div>
                  : <div className="bubble typing"><span /><span /><span /></div>}
              </div>
            )}

            {/* 对话流内联卡（planShown 状态机） */}
            {planShown === 'confirm' && act?.planCard && (
              <div style={{background:'#fff',border:'2px solid #FF7F4D',borderRadius:'16px',padding:'20px',margin:'12px 0',boxShadow:'0 2px 24px rgba(0,0,0,.06)'}}>
                <div style={{fontSize:'16px',fontWeight:700,color:'#1E293B',marginBottom:'12px'}}>⚡ 需求已收集完整！</div>
                <div style={{display:'flex',flexDirection:'column',gap:'6px',marginBottom:'14px'}}>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'1px dashed #DDE2E8',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>针对谁</span><span>{act.planCard.audience || '—'}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'1px dashed #DDE2E8',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>为什么挽回</span><span>{act.planCard.pain || '—'}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'1px dashed #DDE2E8',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>要什么结果</span><span>{act.planCard.goal || '—'}</span></div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'7px 0',fontSize:'13px'}}><span style={{color:'#8A95A0'}}>给什么钩子</span><span>{act.planCard.discount || act.planCard.offer || '—'}</span></div>
                </div>
                <div style={{display:'flex',gap:'9px'}}>
                  <button className="btn primary" onClick={async () => { 
                    setPlanShown('plan');
                    try {
                      await api('/api/draft', { method: 'POST', body: JSON.stringify({ actId: act.id, planCard: act.planCard }) });
                      await loadState();
                    } catch(e) {}
                    switchTab('mail'); 
                  }}>可以，去发</button>
                  <button className="btn ghost" onClick={onReconsider}>再聊聊</button>
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

          {/* 初始引导快捷描述词 */}
          {!onboardingSkipped && onboardingStep < 4 && (
            <div style={{display:'flex',gap:'8px',padding:'8px 16px',flexWrap:'wrap',flexShrink:0}}>
              {[
                { label: '品牌名称', msg: '我的品牌叫 Leo\'s PhoneCase，专门做手机壳的' },
                { label: '品牌类目', msg: '我们主要做手机配件，主打手机壳和贴膜' },
                { label: '客单价', msg: '客单价大概 30-50 美元，手机壳为主' },
                { label: '发送时段', msg: '我想在晚上 8 点发送挽回邮件' },
                { label: '目标受众', msg: '我要挽回加购未付的客户，主要是 25-35 岁年轻人' },
                { label: '挽回原因', msg: '他们加购了但没付款，可能是价格或运费问题' },
                { label: '折扣力度', msg: '我想给 8 折优惠，再加免邮费' },
                { label: '产品特色', msg: '我们手机壳主打防摔设计，有 50 多种图案可选' },
                { label: '营销目标', msg: '希望他们回来完成购买，顺便看看新品' },
                { label: '发送频率', msg: '先发一封试试，效果好的话 3 天后再发第二封' },
              ].map((chip, i) => {
                const clicked = clickedChips.has(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      const next = new Set(clickedChips);
                      next.add(i);
                      setClickedChips(next);
                      if (next.size >= 10 && onboardingStep < 4) setOnboardingStep(onboardingStep + 1);
                      sendMsg(chip.msg);
                    }}
                    style={{
                      display:'inline-flex',alignItems:'center',gap:'6px',
                      padding:'7px 13px',borderRadius:'9px',
                      border: clicked ? '0.5px solid #FF7F4D' : '0.5px solid #DDE2E8',
                      background: clicked ? '#FFF8F4' : '#fff',
                      color: clicked ? '#FF7F4D' : '#1E293B',
                      fontSize:'12.5px',fontWeight:500,
                      cursor:'pointer',whiteSpace:'nowrap',transition:'all .15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!clicked) {
                        e.currentTarget.style.borderColor = '#FF7F4D';
                        e.currentTarget.style.background = '#FFF8F4';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!clicked) {
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
        </section>

        {hasOpportunities && (
          <aside className="opportunity-rail" aria-label="待处理机会">
            <OpportunityCard />
          </aside>
        )}
      </div>
    </div>
  );
}
