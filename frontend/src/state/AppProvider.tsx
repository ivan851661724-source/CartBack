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

export type Tab = 'chat' | 'mail' | 'data' | 'aud' | 'comp' | 'set';
export type PlanShown = 'confirm' | 'plan' | 'sent' | null;

// 确认卡预建草稿暂存（单用户本地应用，模块级即可）：可以去发时建一条，确认发送复用同一条，
// 修复「同卡建两条草稿、邮件 tab 僵尸草稿与实际发送对不上」的跳转不准问题
let pendingCardDraft: { actId: string; draft: Draft } | null = null;

interface ToastState { msg: string; shown: boolean; }

interface AppState {
  // 数据（对齐 app.js state）
  token: string | null;
  status: Status | null;
  act: Act | null;
  acts: Act[];          // 多会话 #2：全量会话（/api/state 的 acts），act 为当前选中
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
  historyOpen: boolean; // 多会话 #2：历史会话弹窗
  editOpen: boolean;
  draftGenerating: boolean; // 邮件草稿生成中（方案卡「可以，去发」后、预览弹出前）
  authOpen: boolean;
  authMode: 'login' | 'register';
  toast: ToastState;
  // 初始引导
  onboardingStep: number; // 0=未开始, 1-4=当前步骤, 4=完成
  onboardingSkipped: boolean;
}

interface AppContextValue extends AppState {
  // 动作
  switchTab: (t: Tab) => void;
  switchAct: (id: string) => void;
  loadState: () => Promise<void>;        // 多会话 #2：切换会话（重置卡片/输入等会话级状态）
  newConversation: () => Promise<void>;   // 多会话 #2：新建会话
  sendMsg: (text: string) => Promise<void>;
  setMode: (m: Mode) => Promise<void>;
  saveConfig: (body: { aiKey: string; espKey: string; espFrom: string; aiModel: string; aiBaseUrl?: string }) => Promise<void>;
  resetData: () => Promise<void>;
  doImport: (csv: string) => Promise<boolean>;
  authSubmit: (email: string, password: string, name: string) => Promise<boolean>;
  authLogout: () => Promise<void>;
  jumpToConfig: (intent: string, aud?: Audience) => Promise<void>;
  confirmSendPlan: (card: PlanCard) => Promise<void>;
  createCardDraft: (actId: string, card: PlanCard) => Promise<Draft>;   // 确认卡预建草稿（确认发送时复用，防重复建草稿）
  sendEditedDraft: (subject: string, body: string) => Promise<boolean>;
  // setters
  setChatInput: (v: string) => void;
  setChatPlaceholder: (v: string) => void;
  setPlanShown: (p: PlanShown) => void;
  setPlanPushed: (v: boolean) => void;
  setEditingDraft: (d: Draft | null) => void;
  setDrawerAud: (a: Audience | null) => void;
  setOnboardingStep: (s: number) => void;
  skipOnboarding: () => void;
  setImportOpen: (v: boolean) => void;
  setHistoryOpen: (v: boolean) => void;
  setEditOpen: (v: boolean) => void;
  setDraftGenerating: (v: boolean) => void;
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
    token: null, status: null, act: null, acts: [], kpis: null, trend: null, metrics: {},
    drafts: [], audience: [], opportunities: null,
    planPushed: false, planShown: null, lastSent: null, me: null,
    booted: false, activeTab: 'chat', chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
    streaming: false, streamingText: '', editingDraft: null, drawerAud: null,
    importOpen: false, historyOpen: false, editOpen: false, draftGenerating: false, authOpen: false, authMode: 'register',
    toast: { msg: '', shown: false },
    onboardingStep: 0, onboardingSkipped: false,
  });

  // 多会话 #2 性能：act 索引 Map（O(1) 查找，避免 O(n) scans on every loadState）
  const actIndexRef = useRef<Map<string, Act>>(new Map());
  const buildActIndex = useCallback((acts: Act[]) => {
    const m = new Map<string, Act>();
    for (const a of acts) m.set(a.id, a);
    actIndexRef.current = m;
    return m;
  }, []);

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
    const acts: Act[] = (s.acts || []) as Act[];
    const actIndex = buildActIndex(acts);
    // 多会话 #2：O(1) Map 查找当前选中；不存在才取第一个（?.id 可能 undefined，兜底空串查不到走 fallback）
    // /api/state 不返回 planCard（后端不持久化）——同一会话沿用内存值，否则确认发送/预览后 loadState 把卡片冲掉
    const nextAct = actIndex.get(state.act?.id ?? '') || acts[0] || state.act;
    patch({
      status: s.status, kpis: s.kpis, trend: s.trend,
      metrics: s.metrics || {}, demoAnchorRoi: s.demoAnchorRoi,
      drafts: s.drafts, audience: s.audience,
      acts,
      act: nextAct && state.act && nextAct.id === state.act.id && state.act.planCard && !nextAct.planCard
        ? { ...nextAct, planCard: state.act.planCard }
        : nextAct,
    });
    // 会话重建后若消息为空，复位 planPushed
    setState(prev => {
      if (prev.act && (!prev.act.messages || !prev.act.messages.length) && !s.acts?.[0]) {
        return { ...prev, planPushed: false };
      }
      return prev;
    });
  }, [patch, state.act, buildActIndex]);

  const ensureAct = useCallback(async () => {
    if (!state.act) {
      const act = await createAct();
      patch({ act, acts: [act, ...state.acts] });
    }
  }, [state.act, state.acts, patch]);

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

  // —— 多会话 #2：切换会话（streaming 中阻止；O(1) Map 查找）——
  const switchAct = useCallback((id: string) => {
    if (state.streaming) { toast_('回复生成中，稍等再切换'); return; }
    const next = actIndexRef.current.get(id);
    if (!next || next.id === state.act?.id) { patch({ historyOpen: false }); return; }
    patch({
      act: next, historyOpen: false, activeTab: 'chat',
      planPushed: false, planShown: null,
      chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
    });
  }, [state.streaming, state.act, patch, toast_]);

  // —— 多会话 #2：新建会话（新建 act 置顶并直接进入对话） ——
  const newConversation = useCallback(async () => {
    try {
      const act = await createAct();
      patch({
        act, acts: [act, ...state.acts],
        historyOpen: false, activeTab: 'chat',
        planPushed: false, planShown: null,
        chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
      });
    } catch (e: any) {
      toast_('新建会话失败：' + (e?.message || e));
    }
  }, [state.acts, patch, toast_]);

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
        // 确认卡重现：首推（planPushed=false）或用户用文字确认（「可以/好/行，去发」类）时拉卡。
        // 修「卡片永远不再出现」死局：planPushed 全局一次性后，再聊聊/刷新后打字确认无法唤回卡片；
        // 再修「点过一次可以去发后死锁」：planShown 卡在 plan/sent 不复位时同样拉不回卡 → 不再看 planShown。
        // 光杆「好」「行」也算确认（好(的|吧|嘞)? ），但「不好/不行」不算（[^不没] 前置守卫）。
        const CONFIRM_INTENT_RE = /(^|[^不没])(可以|行(的|吧)?|好(的|吧|嘞)?|去发|发送|确认|就这样|生成|ok|yes|send)/i;
        const pushConfirm = !!r.planCard && (!prev.planPushed || CONFIRM_INTENT_RE.test(t));
        return {
          ...prev, act: nextAct, streaming: false, streamingText: '',
          // 多会话 #2：acts 里的同一会话同步为新状态（历史列表摘要/时间随之更新）
          acts: prev.acts.map(a => (a.id === nextAct.id ? nextAct : a)),
          planPushed: pushConfirm ? true : prev.planPushed,
          planShown: pushConfirm ? 'confirm' : prev.planShown,
        };
      });
    };

    let got = false;       // 是否已收到 token 帧（= 服务端已开始交付，本轮 LLM 已计费）
    let last = '';         // 最近一帧累计文本（流中断时保留已到内容）
    try {
      const result = await streamMessage(state.act.id, t, (full) => { got = true; last = full; patch({ streamingText: full }); });
      finalize(result);
    } catch {
      if (got) {
        // 已收到部分内容：服务端已完成并落库，不再降级重发（避免二次计费 + 重复回复），保留已到文本
        finalize({ reply: last });
        toast_('网络中断，以上为已接收到的部分回复');
        return;
      }
      // 降级：一次性 /message（未收到任何 token，本轮未交付，可安全重试）
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
  const saveConfig = useCallback(async (body: { aiKey: string; espKey: string; espFrom: string; aiModel: string; aiBaseUrl?: string }) => {
    const payload: Record<string, string> = {
      aiKey: body.aiKey.startsWith('•') ? '' : body.aiKey,
      espKey: body.espKey.startsWith('•') ? '' : body.espKey,
      espFrom: body.espFrom, aiModel: body.aiModel,
    };
    if (typeof body.aiBaseUrl === 'string') payload.aiBaseUrl = body.aiBaseUrl;
    const r = await api<{ status: Status }>('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    patch({ status: r.status });
    toast_('配置已保存（密钥仅存于服务端，不回传前端）');
  }, [patch, toast_]);

  // —— 重置 ——
  const resetData = useCallback(async () => {
    await api('/api/reset', { method: 'POST' });
    patch({ act: null, acts: [], planPushed: false, planShown: null, lastSent: null });
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
      act, acts: [act, ...state.acts], planPushed: false, planShown: null, activeTab: 'chat',
      chatInput: aud ? `帮我挽回 ${aud.intent || ''} 的人，弃购额约 ¥${+aud.abandoned_value || 0}` : '',
      chatPlaceholder: CHAT_PLACEHOLDER,
    });
  }, [state.acts, patch]);

  // —— 异步任务轮询（发送 202 入队后；GET /api/jobs/:id）——
  const pollJob = useCallback(async (jobId: string, timeoutMs = 120000): Promise<{ ok: boolean; result?: any; error?: string }> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const j = await api<{ status: string; result?: any; error?: string }>(`/api/jobs/${jobId}`);
        if (j.status === 'done') return { ok: true, result: j.result };
        if (j.status === 'failed') return { ok: false, error: j.error || '任务执行失败' };
      } catch { /* 网络抖动继续轮询 */ }
      await new Promise(r => setTimeout(r, 900));
    }
    return { ok: false, error: '任务超时，请稍后在邮件页查看状态' };
  }, []);

  // —— 方案卡「确认发送」→ 生成草稿（含变体+海报入队）→ 202 发送入队 → 轮询结果 ——
  // 修「跳转不准」根因：确认卡「可以，去发」已预建草稿（createCardDraft 暂存），
  // 此处优先复用，避免同一张方案卡建出两条草稿（僵尸草稿留在邮件 tab，状态与实际发送对不上）
  const confirmSendPlan = useCallback(async (card: PlanCard) => {
    if (!state.act) return;
    try {
      let d: Draft | null = null;
      if (pendingCardDraft && pendingCardDraft.actId === state.act.id) {
        d = pendingCardDraft.draft;
        pendingCardDraft = null;
      }
      if (!d) {
        const r = await api<{ draft: Draft; references?: any; error?: string }>('/api/draft', {
          method: 'POST', body: JSON.stringify({ actId: state.act.id, planCard: card }),
        });
        if (r.error) { toast_(r.error); return; }
        d = r.draft;
      }
      const s = await api<{ job_id?: string; queued?: boolean; result?: SendResult; error?: string }>(`/api/draft/${d.id}/send`, {
        method: 'POST', body: JSON.stringify({ subject: d.subject, body: d.body }),
      });
      if (s.error) { toast_(s.error); return; }
      let res: SendResult | undefined = s.result;
      if (s.queued && s.job_id) {
        const j = await pollJob(s.job_id);
        if (!j.ok) { toast_('发送失败：' + (j.error || '未知错误')); await loadState(); return; }
        res = j.result;
      }
      patch({ planShown: 'sent', lastSent: { res: res || {}, draft: d } });
      await loadState();
      toast_('邮件已发出 · 回流中…');
    } catch (e: any) {
      toast_('发送失败：' + (e?.message || e));
    }
  }, [state.act, patch, loadState, pollJob, toast_]);

  // —— 确认卡「可以，去发」预建草稿：重活（变体/海报入队）提前跑，暂存给确认发送复用 ——
  const createCardDraft = useCallback(async (actId: string, card: PlanCard): Promise<Draft> => {
    const r = await api<{ draft: Draft; error?: string }>('/api/draft', {
      method: 'POST', body: JSON.stringify({ actId, planCard: card }),
    });
    if (r.error || !r.draft) throw new Error(r.error || '草稿生成失败');
    pendingCardDraft = { actId, draft: r.draft };
    return r.draft;
  }, []);

  // —— 邮件卡编辑后发送（202 入队 + 轮询）——
  const sendEditedDraft = useCallback(async (subject: string, body: string) => {
    const d = state.editingDraft;
    if (!d) return false;
    if (!subject || !body) { toast_('主题和正文不能为空'); return false; }
    try {
      const r = await api<{ job_id?: string; queued?: boolean; error?: string }>(`/api/draft/${d.id}/send`, {
        method: 'POST', body: JSON.stringify({ subject, body }),
      });
      if (r.error) { toast_(r.error); return false; }
      if (r.queued && r.job_id) {
        const j = await pollJob(r.job_id);
        if (!j.ok) { toast_('发送失败：' + (j.error || '未知错误')); await loadState(); return false; }
      }
      patch({ editOpen: false, editingDraft: null });
      toast_('邮件已发送（以编辑后内容为准）');
      await loadState();
      return true;
    } catch (e: any) {
      toast_('发送失败：' + (e?.message || e));
      return false;
    }
  }, [state.editingDraft, patch, loadState, pollJob, toast_]);

  const value: AppContextValue = {
    ...state,
    switchTab, switchAct, loadState, newConversation, sendMsg, setMode, saveConfig, resetData, doImport,
    authSubmit, authLogout, jumpToConfig, confirmSendPlan, createCardDraft, sendEditedDraft,
    setChatInput: (v) => patch({ chatInput: v }),
    setChatPlaceholder: (v) => patch({ chatPlaceholder: v }),
    setPlanShown: (p) => patch({ planShown: p }),
    setPlanPushed: (v) => patch({ planPushed: v }),
    setEditingDraft: (d) => patch({ editingDraft: d }),
    setDrawerAud: (a) => patch({ drawerAud: a }),
    setOnboardingStep: (s) => patch({ onboardingStep: s }),
    skipOnboarding: () => patch({ onboardingStep: 4, onboardingSkipped: true }),
    setImportOpen: (v) => patch({ importOpen: v }),
    setHistoryOpen: (v) => patch({ historyOpen: v }),
    setEditOpen: (v) => patch({ editOpen: v }),
    setDraftGenerating: (v: boolean) => patch({ draftGenerating: v }),
    setAuthOpen: (v) => patch({ authOpen: v }),
    setAuthMode: (m) => patch({ authMode: m }),
    toast_,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
