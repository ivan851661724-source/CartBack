'use client';

/**
 * CartBack v3 全局状态与动作层（React Context）。
 * 1:1 移植自 app.js 的全局 state + boot/loadState/ensureAct/sendMsg/setMode/saveConfig/
 * resetData/doImport/auth/* / switchTab / jumpToConfig 等逻辑，仅把命令式 DOM 操控换成
 * 声明式 state。对话流卡片（confirm/plan/sent）的 planShown 状态机原样保留。
 */
import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { api, setToken, streamMessage, createAct } from '@/lib/api';
import type {
  Act, Audience, Draft, Kpis, Me, Metrics, Mode, Opportunities,
  PlanCard, SendResult, Status, TrendPoint,
} from '@/lib/types';
import { CHAT_PLACEHOLDER, intentToAudience } from '@/lib/constants';

export type Tab = 'chat' | 'mail' | 'data' | 'aud' | 'set';
export type PlanShown = 'confirm' | 'plan' | 'sent' | null;

interface ToastState { msg: string; shown: boolean; }

interface AppState {
  // 数据（对齐 app.js state）
  token: string | null;
  status: Status | null;
  act: Act | null;
  kpis: Kpis | null;
  trend: TrendPoint[] | null;
  metrics: Metrics;
  demoAnchorRoi?: number;
  drafts: Draft[];
  audience: Audience[];
  opportunities: Opportunities | null;
  planPushed: boolean;
  planShown: PlanShown;
  lastSent: { res: SendResult; draft: Draft } | null;
  me: Me | null;
  // UI 状态
  booted: boolean;
  activeTab: Tab;
  chatInput: string;
  chatPlaceholder: string;
  streaming: boolean;
  streamingText: string;
  editingDraft: Draft | null;
  drawerAud: Audience | null;
  importOpen: boolean;
  editOpen: boolean;
  authOpen: boolean;
  authMode: 'login' | 'register';
  toast: ToastState;
}

interface AppContextValue extends AppState {
  // 动作
  switchTab: (t: Tab) => void;
  sendMsg: (text: string) => Promise<void>;
  setMode: (m: Mode) => Promise<void>;
  saveConfig: (body: { aiKey: string; espKey: string; espFrom: string; aiModel: string }) => Promise<void>;
  resetData: () => Promise<void>;
  doImport: (csv: string) => Promise<boolean>;
  authSubmit: (email: string, password: string, name: string) => Promise<boolean>;
  authLogout: () => Promise<void>;
  jumpToConfig: (intent: string, aud?: Audience) => Promise<void>;
  confirmSendPlan: (card: PlanCard) => Promise<void>;
  sendEditedDraft: (subject: string, body: string) => Promise<boolean>;
  // setters
  setChatInput: (v: string) => void;
  setChatPlaceholder: (v: string) => void;
  setPlanShown: (p: PlanShown) => void;
  setPlanPushed: (v: boolean) => void;
  setEditingDraft: (d: Draft | null) => void;
  setDrawerAud: (a: Audience | null) => void;
  setImportOpen: (v: boolean) => void;
  setEditOpen: (v: boolean) => void;
  setAuthOpen: (v: boolean) => void;
  setAuthMode: (m: 'login' | 'register') => void;
  toast_: (msg: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

const toastTimer = { current: null as ReturnType<typeof setTimeout> | null };

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>({
    token: null, status: null, act: null, kpis: null, trend: null, metrics: {},
    drafts: [], audience: [], opportunities: null,
    planPushed: false, planShown: null, lastSent: null, me: null,
    booted: false, activeTab: 'chat', chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
    streaming: false, streamingText: '', editingDraft: null, drawerAud: null,
    importOpen: false, editOpen: false, authOpen: false, authMode: 'register',
    toast: { msg: '', shown: false },
  });

  // 局部 patch 辅助
  const patch = useCallback((p: Partial<AppState>) => setState(s => ({ ...s, ...p })), []);
  const toast_ = useCallback((msg: string) => {
    setState(s => ({ ...s, toast: { msg, shown: true } }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setState(s => ({ ...s, toast: { ...s.toast, shown: false } })), 3000);
  }, []);

  // —— 数据加载 ——
  const loadState = useCallback(async () => {
    const s = await api<any>('/api/state');
    patch({
      status: s.status, kpis: s.kpis, trend: s.trend,
      metrics: s.metrics || {}, demoAnchorRoi: s.demoAnchorRoi,
      drafts: s.drafts, audience: s.audience,
      act: (s.acts && s.acts[0]) ? s.acts[0] : state.act,
    });
    // 会话重建后若消息为空，复位 planPushed
    setState(prev => {
      if (prev.act && (!prev.act.messages || !prev.act.messages.length) && !s.acts?.[0]) {
        return { ...prev, planPushed: false };
      }
      return prev;
    });
  }, [patch, state.act]);

  const ensureAct = useCallback(async () => {
    if (!state.act) {
      const act = await createAct();
      patch({ act });
    }
  }, [state.act, patch]);

  const loadOpportunities = useCallback(async () => {
    try {
      const o = await api<Opportunities>('/api/opportunities');
      patch({ opportunities: o });
    } catch { /* ignore */ }
  }, [patch]);

  const refreshMe = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me', { method: 'GET', credentials: 'same-origin' });
      if (r.ok) {
        const me = await r.json() as Me;
        patch({ me });
        if (me.user && me.authMode === 'session') loadState().catch(() => {});
      } else {
        patch({ me: null });
      }
    } catch {
      patch({ me: null });
    }
  }, [patch, loadState]);

  // —— boot ——
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      try {
        const b = await api<{ token: string; status: Status }>('/api/bootstrap');
        setToken(b.token);
        patch({ token: b.token, status: b.status });
        refreshMe();              // 非阻塞
        await loadState();
        await loadOpportunities();
        await ensureAct();
        patch({ booted: true });
      } catch (e: any) {
        toast_('初始化失败：' + (e?.message || e));
      }
    })();
  }, [patch, refreshMe, loadState, loadOpportunities, ensureAct, toast_]);

  // —— 切 tab（关闭抽屉，更新面包屑由 Topbar 读 activeTab） ——
  const switchTab = useCallback((t: Tab) => {
    patch({ activeTab: t, drawerAud: null });
  }, [patch]);

  // —— 发消息（SSE 流式 + 一次性降级） ——
  const sendMsg = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || !state.act || state.streaming) return;
    patch({ chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER });
    // 乐观追加用户消息
    const userMsg = { role: 'user' as const, content: t };
    const actWithUser: Act = { ...state.act, messages: [...state.act.messages, userMsg] };
    patch({ act: actWithUser, streaming: true, streamingText: '' });

    const finalize = (r: { reply: string; stage?: any; needs?: any; planCard?: PlanCard | null }) => {
      setState(prev => {
        if (!prev.act) return prev;
        const assistantMsg = { role: 'assistant' as const, content: r.reply };
        const nextAct: Act = {
          ...prev.act,
          stage: r.stage ?? prev.act.stage,
          needs: r.needs ?? prev.act.needs,
          messages: [...prev.act.messages, assistantMsg],
          planCard: r.planCard ?? prev.act.planCard ?? null,
        };
        const pushConfirm = !!r.planCard && !prev.planPushed;
        return {
          ...prev, act: nextAct, streaming: false, streamingText: '',
          planPushed: pushConfirm ? true : prev.planPushed,
          planShown: pushConfirm ? 'confirm' : prev.planShown,
        };
      });
    };

    try {
      const result = await streamMessage(state.act.id, t, (full) => patch({ streamingText: full }));
      finalize(result);
    } catch {
      // 降级：一次性 /message
      try {
        const r = await api<any>(`/api/act/${state.act.id}/message`, {
          method: 'POST', body: JSON.stringify({ message: t }),
        });
        if (r.error) { toast_(r.error); patch({ streaming: false, streamingText: '' }); return; }
        finalize(r);
      } catch (e: any) {
        toast_('发送失败：' + (e?.message || e));
        patch({ streaming: false, streamingText: '' });
      }
    }
  }, [state.act, state.streaming, patch, toast_]);

  // —— 模式切换 ——
  const setMode = useCallback(async (m: Mode) => {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode: m }) });
    await loadState();
    toast_(m === 'real' ? '已切换真实模式（仅显示真实归因）' : '已切换演示模式');
  }, [loadState, toast_]);

  // —— 保存配置 ——
  const saveConfig = useCallback(async (body: { aiKey: string; espKey: string; espFrom: string; aiModel: string }) => {
    const payload = {
      aiKey: body.aiKey.startsWith('•') ? '' : body.aiKey,
      espKey: body.espKey.startsWith('•') ? '' : body.espKey,
      espFrom: body.espFrom, aiModel: body.aiModel,
    };
    const r = await api<{ status: Status }>('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    patch({ status: r.status });
    toast_('配置已保存（密钥仅存于服务端，不回传前端）');
  }, [patch, toast_]);

  // —— 重置 ——
  const resetData = useCallback(async () => {
    await api('/api/reset', { method: 'POST' });
    patch({ act: null, planPushed: false, planShown: null, lastSent: null });
    await loadState();
    await ensureAct();
    toast_('数据已重置');
  }, [patch, loadState, ensureAct, toast_]);

  // —— CSV 导入 ——
  const doImport = useCallback(async (csv: string) => {
    const r = await api<{ imported?: number; audience?: Audience[]; error?: string }>('/api/audience/import', {
      method: 'POST', body: JSON.stringify({ csv }),
    });
    if (r.error) { toast_(r.error); return false; }
    patch({ audience: r.audience || [], importOpen: false });
    toast_(`已导入 ${r.imported ?? 0} 位高意向顾客`);
    return true;
  }, [patch, toast_]);

  // —— 鉴权 ——
  const authSubmit = useCallback(async (email: string, password: string, name: string) => {
    if (!email || !password) { toast_('邮箱和密码不能为空'); return false; }
    const isReg = state.authMode === 'register';
    const path = isReg ? '/api/auth/register' : '/api/auth/login';
    const body = isReg ? { email, password, name } : { email, password };
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), credentials: 'same-origin',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast_(j.error || '请求失败'); return false; }
    patch({ authOpen: false });
    refreshMe();
    toast_(isReg ? '注册成功，欢迎！' : '登录成功');
    return true;
  }, [state.authMode, patch, refreshMe, toast_]);

  const authLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    patch({ me: null });
    refreshMe();
    toast_('已退出登录');
  }, [patch, refreshMe, toast_]);

  // —— 受众「去聊这拨人」→ 新建 act（预选受众）+ 切对话 + 预填输入 ——
  const jumpToConfig = useCallback(async (intent: string, aud?: Audience) => {
    const act = await createAct({ audience: intentToAudience(intent) });
    patch({
      act, planPushed: false, planShown: null, activeTab: 'chat',
      chatInput: aud ? `帮我挽回 ${aud.intent || ''} 的人，弃购额约 ¥${+aud.abandoned_value || 0}` : '',
      chatPlaceholder: CHAT_PLACEHOLDER,
    });
  }, [patch]);

  // —— 方案卡「确认发送」→ 生成草稿 + 发送 + 进对话流 sent banner ——
  const confirmSendPlan = useCallback(async (card: PlanCard) => {
    if (!state.act) return;
    try {
      const r = await api<{ draft: Draft; error?: string }>('/api/draft', {
        method: 'POST', body: JSON.stringify({ actId: state.act.id, planCard: card }),
      });
      if (r.error) { toast_(r.error); return; }
      const d = r.draft;
      const s = await api<{ result?: SendResult; error?: string }>(`/api/draft/${d.id}/send`, {
        method: 'POST', body: JSON.stringify({ subject: d.subject, body: d.body }),
      });
      if (s.error) { toast_(s.error); return; }
      patch({ planShown: 'sent', lastSent: { res: s.result || {}, draft: d } });
      await loadState();
      toast_('邮件已发出 · 回流中…');
    } catch (e: any) {
      toast_('发送失败：' + (e?.message || e));
    }
  }, [state.act, patch, loadState, toast_]);

  // —— 邮件卡编辑后发送 ——
  const sendEditedDraft = useCallback(async (subject: string, body: string) => {
    const d = state.editingDraft;
    if (!d) return false;
    if (!subject || !body) { toast_('主题和正文不能为空'); return false; }
    const r = await api<{ error?: string }>(`/api/draft/${d.id}/send`, {
      method: 'POST', body: JSON.stringify({ subject, body }),
    });
    if (r.error) { toast_(r.error); return false; }
    patch({ editOpen: false, editingDraft: null });
    toast_('邮件已发送（以编辑后内容为准）');
    await loadState();
    return true;
  }, [state.editingDraft, patch, loadState, toast_]);

  const value: AppContextValue = {
    ...state,
    switchTab, sendMsg, setMode, saveConfig, resetData, doImport,
    authSubmit, authLogout, jumpToConfig, confirmSendPlan, sendEditedDraft,
    setChatInput: (v) => patch({ chatInput: v }),
    setChatPlaceholder: (v) => patch({ chatPlaceholder: v }),
    setPlanShown: (p) => patch({ planShown: p }),
    setPlanPushed: (v) => patch({ planPushed: v }),
    setEditingDraft: (d) => patch({ editingDraft: d }),
    setDrawerAud: (a) => patch({ drawerAud: a }),
    setImportOpen: (v) => patch({ importOpen: v }),
    setEditOpen: (v) => patch({ editOpen: v }),
    setAuthOpen: (v) => patch({ authOpen: v }),
    setAuthMode: (m) => patch({ authMode: m }),
    toast_,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
