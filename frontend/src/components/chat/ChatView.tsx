'use client';

import { useEffect, useRef } from 'react';
import { useApp } from '@/state/AppProvider';
import { Arrow } from '@/components/ui/icons';
import MessageBubble from './MessageBubble';
import ConfirmCard from './ConfirmCard';
import PlanCardView from './PlanCardView';
import SentBanner from './SentBanner';
import OpportunityCard from './OpportunityCard';

const EDIT_HINT = '说说要改哪块：受众、钩子、折扣还是发送时机…';

/** 助手（对话）视图 —— 对应 flow.html #view-chat + app.js renderChat/sendMsg UI */
export default function ChatView() {
  const {
    act, opportunities, streaming, streamingText, planShown, lastSent,
    chatInput, chatPlaceholder, sendMsg, setChatInput, setChatPlaceholder,
    setPlanShown, setPlanPushed, confirmSendPlan, switchTab,
  } = useApp();

  const areaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
            <div className="ch-av"><Arrow /></div>
            <div className="ch-copy">
              <span className="ch-kicker">当前会话</span>
              <span className="ch-t">挽回策略助手</span>
            </div>
            <span className="ch-s"><span className="dot" /><span>在线 · 已记录 {n}/4 项</span></span>
          </div>

          <div className="chat-area" ref={areaRef} aria-live="polite" aria-label="对话消息区">
            {messages.length === 0 && !streaming && (
              <div className="msg agent">
                <div className="avatar agent"><Arrow /></div>
                <div className="bubble">
                  你好，我是你的挽回邮件教练。<br />
                  告诉我你想挽回哪类人、为什么、希望拿到什么结果，我帮你一步步生成方案卡。
                </div>
              </div>
            )}

            {messages.map((m, i) => <MessageBubble key={i} m={m} />)}

            {streaming && (
              <div className="msg agent">
                <div className="avatar agent"><Arrow /></div>
                {streamingText
                  ? <div className="bubble">{streamingText}</div>
                  : <div className="bubble typing"><span /><span /><span /></div>}
              </div>
            )}

            {/* 对话流内联卡（planShown 状态机） */}
            {planShown === 'confirm' && act?.planCard && (
              <ConfirmCard card={act.planCard} onConfirm={() => setPlanShown('plan')} onReconsider={onReconsider} />
            )}
            {planShown === 'plan' && act?.planCard && (
              <PlanCardView card={act.planCard} onEdit={onEdit} onSend={() => confirmSendPlan(act.planCard!)} />
            )}
            {planShown === 'sent' && lastSent && (
              <SentBanner res={lastSent.res} draft={lastSent.draft} onSeeFlow={() => switchTab('data')} />
            )}
          </div>

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
