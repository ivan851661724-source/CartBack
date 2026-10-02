'use client';

/**
 * CartBack v3 全局状态与动作层（React Context）。
 * 1:1 移植自 app.js 的全局 state + boot/loadState/ensureAct/sendMsg/setMode/saveConfig/
 * resetData/doImport/auth/* / switchTab / jumpToConfig 等逻辑，仅把命令式 DOM 操控换成
 * 声明式 state。对话流卡片（confirm/plan/sent）的 planShown 状态机原样保留。
 */
import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { api, setToken, streamMessage, createAct, confirmAct, ApiAuthError } from '@/lib/api';
import type {
  Act, Audience, Checklist, Chips, Draft, Engine, Holdout, Kpis, Me, Metrics, Mode, Opportunities,
  PlanCard, SendResult, Status, TrendPoint,
} from '@/lib/types';
import { CHAT_PLACEHOLDER, intentToAudience } from '@/lib/constants';
import { filledCount } from '@/lib/needs';

export type Tab = 'chat' | 'mail' | 'data' | 'aud' | 'comp' | 'set';
export type PlanShown = 'confirm' | 'plan' | 'sent' | null;

/** confirm 接口 200 后的方案卡状态（对话流 PlanCard 卡的数据源；S3 改口回 S2 时整体复位） */
export interface ConfirmState {
  actId: string;
  planCard: PlanCard;
  checklist: Checklist | null;
  holdout: Holdout | null;
}

/** confirm 409（建码失败）的三出口状态：重试建码 / 改用店内现成码 / 改发无钩子提醒信 */
export interface ConfirmFailed {
  reason: string;
  options: string[];
}

// 确认卡预建草稿暂存（单用户本地应用，模块级即可）：旧后端回退路径 / demo 引导跳步可能预建，
// confirm 新接口成功后若存在暂存草稿则删除（confirm 由后端建稿），避免同卡出现僵尸草稿
let pendingCardDraft: { actId: string; draft: Draft } | null = null;

/** act 局部合并：后端 act 增量（confirm/send 响应）并入本地 act；messages 空值不覆盖本地 */
function mergeAct(base: Act, inc?: Partial<Act>): Act {
  if (!inc) return base;
  return {
    ...base,
    ...inc,
    messages: inc.messages && inc.messages.length ? inc.messages : base.messages,
  };
}

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
  engine: Engine;   // 引擎健康态：done 帧与 GET /api/state 都可能更新；初始缺省 online
  chips: Chips;     // 最新一条 agent 回复的快捷 chips（发送新消息即清空；旧 done 帧无此字段则保持空）
  // Wave2 confirm 流：confirm 200 的方案卡/核对单（留在对话页渲染 PlanCard 卡）+ 409 三出口 + 忙态
  confirmState: ConfirmState | null;
  confirmFailed: ConfirmFailed | null;
  confirmBusy: boolean;
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
  // 引导风格（与 demo/real 发送模式解耦的独立开关）：
  //  'demo' = 硬编码 Leo's PhoneCase 快捷词 + GuideOverlay 浮层引导（演示用）
  //  'safe' = 纯意图快捷词 + 顶栏 HintPill 串联引导（真实商家，不覆盖品牌）
  guideStyle: 'demo' | 'safe';
}

interface AppContextValue extends AppState {
  // 动作
  switchTab: (t: Tab) => void;
  switchAct: (id: string) => void;
  loadState: () => Promise<void>;        // 多会话 #2：切换会话（重置卡片/输入等会话级状态）
  newConversation: () => Promise<void>;   // 多会话 #2：新建会话
  sendMsg: (text: string) => Promise<void>;
  setMode: (m: Mode) => Promise<void>;
  saveConfig: (body: { aiKey: string; espKey: string; espFrom: string; aiModel: string; aiBaseUrl?: string; shopBrand?: string }) => Promise<void>;
  resetData: () => Promise<void>;
  doImport: (csv: string) => Promise<boolean>;
  authSubmit: (email: string, password: string, name: string) => Promise<string | true>;
  authLogout: () => Promise<void>;
  jumpToConfig: (intent: string, aud?: Audience) => Promise<void>;
  confirmPlan: (body?: { reuse_code?: string; nohook?: boolean }) => Promise<void>;  // 确认卡「可以，去发」/ 409 三出口（带 body 重调）
  sendConfirmedPlan: () => Promise<boolean>;   // 方案卡「确认发送」：POST /api/draft/:id/send，409 时刷新核对单
  createCardDraft: (actId: string, card: PlanCard) => Promise<Draft>;   // 确认卡预建草稿（旧后端回退路径 / 引导跳步复用）
  sendEditedDraft: (subject: string, body: string) => Promise<boolean>;
  sendDraft: (d: Draft) => Promise<boolean>;        // 卡片操作行「发送」：按存储原稿直接发送（Figma 406:2955）
  deleteDraft: (d: Draft) => Promise<boolean>;      // 卡片操作行「删除」
  // setters
  setChatInput: (v: string) => void;
  setChatPlaceholder: (v: string) => void;
  setPlanShown: (p: PlanShown) => void;
  setPlanPushed: (v: boolean) => void;
  setEditingDraft: (d: Draft | null) => void;
  setDrawerAud: (a: Audience | null) => void;
  setOnboardingStep: (s: number) => void;
  skipOnboarding: () => void;
  setGuideStyle: (s: 'demo' | 'safe') => void;
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
    engine: 'online', chips: [],
    confirmState: null, confirmFailed: null, confirmBusy: false,
    booted: false, activeTab: 'chat', chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
    streaming: false, streamingText: '', editingDraft: null, drawerAud: null,
    importOpen: false, historyOpen: false, editOpen: false, draftGenerating: false, authOpen: false, authMode: 'register',
    toast: { msg: '', shown: false },
    onboardingStep: 0, onboardingSkipped: false,
    guideStyle: (typeof localStorage !== 'undefined' && localStorage.getItem('cb_guide_style') === 'safe') ? 'safe' : 'demo',
  });

  // 多会话 #2 性能：act 索引 Map（O(1) 查找，避免 O(n) scans on every loadState）
  const actIndexRef = useRef<Map<string, Act>>(new Map());
  // P1-9 方案卡召回只做一次/会话：用户点「再聊聊」关掉确认卡后，后续 loadState 不得强行弹回
  const planRestoredRef = useRef<Set<string>>(new Set());
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
      // 引擎健康态：仅接受合法值，非法/缺省保持现值（初始 online）
      ...(s.engine === 'online' || s.engine === 'degraded' ? { engine: s.engine as Engine } : {}),
      act: nextAct && state.act && nextAct.id === state.act.id && state.act.planCard && !nextAct.planCard
        ? { ...nextAct, planCard: state.act.planCard }
        : nextAct,
    });
    // 会话重建后若消息为空，复位 planPushed
    setState(prev => {
      let next = prev;
      if (prev.act && (!prev.act.messages || !prev.act.messages.length) && !s.acts?.[0]) {
        next = { ...next, planPushed: false };
      }
      // 刷新后方案卡召回（走查 P1-9）：后端 act.planCard 还在、本会话又没有草稿 → 重现确认卡（每会话仅一次）。
      // 已有草稿的会话不反推（「可以，去发」复用暂存草稿防僵尸草稿；刷新后暂存丢失，再去发会走邮件页）。
      if (!next.planShown && next.act?.planCard && !((s.drafts || []) as Draft[]).some(d => d.act_id === next.act!.id)
          && !planRestoredRef.current.has(next.act.id)) {
        planRestoredRef.current.add(next.act.id);
        next = { ...next, planShown: 'confirm', planPushed: true };
      }
      return next;
    });
  }, [patch, state.act, buildActIndex]);

  const ensureAct = useCallback(async (): Promise<Act | null> => {
    if (state.act) return state.act;
    try {
      const act = await createAct();
      patch({ act, acts: [act, ...state.acts] });
      return act;
    } catch {
      // 未登录/网络失败等导致建不了会话：返回 null，由调用方决定引导方式（不再静默丢消息）
      return null;
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
        if (e instanceof ApiAuthError) {
          // 401/403 = 未登录/安全模式：引导注册登录，不算故障（走查 P0-1：不再反复弹「初始化失败」toast）
          patch({ booted: true, authOpen: true, authMode: 'register' });
          return;
        }
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
      confirmState: null, confirmFailed: null,   // confirm 状态属于上一会话，切会话即失效
      chips: [],   // chips 属于上一会话的最新回复，切会话即失效
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
        confirmState: null, confirmFailed: null,   // 新会话无 confirm 状态
        chips: [],   // 新会话无历史回复，chips 清空
        chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
      });
    } catch (e: any) {
      toast_('新建会话失败：' + (e?.message || e));
    }
  }, [state.acts, patch, toast_]);

  // —— 发消息（SSE 流式 + 一次性降级） ——
  const sendMsg = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || state.streaming) return;
    // 无会话（未登录 / 注册后未重建）先补建；补不了就明确引导注册，绝不静默丢弃（走查 P0-2）
    const act = state.act || await ensureAct();
    if (!act) {
      patch({ authOpen: true, authMode: 'register' });
      toast_('请先注册或登录后再发送');
      return;
    }
    patch({ chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER });
    // 乐观追加用户消息
    const userMsg = { role: 'user' as const, content: t };
    const actWithUser: Act = { ...act, messages: [...act.messages, userMsg] };
    // 发送新消息即清空上一回复的 chips（新 chips 由本轮 done 帧重新下发）
    patch({ act: actWithUser, streaming: true, streamingText: '', chips: [] });

    const finalize = (r: { reply: string; stage?: any; needs?: any; planCard?: PlanCard | null; chips?: unknown; engine?: unknown }) => {
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
        // chips：只接受字符串数组（旧 done 帧无此字段/空数组 → 清空不渲染）
        const chips: Chips = Array.isArray(r.chips)
          ? (r.chips as unknown[]).filter((c): c is string => typeof c === 'string')
          : [];
        // engine：仅接受合法值，否则保持现值
        const engine = r.engine === 'online' || r.engine === 'degraded' ? r.engine : prev.engine;
        return {
          ...prev, act: nextAct, streaming: false, streamingText: '',
          engine, chips,
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
      const result = await streamMessage(act.id, t, (full) => { got = true; last = full; patch({ streamingText: full }); });
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
        const r = await api<any>(`/api/act/${act.id}/message`, {
          method: 'POST', body: JSON.stringify({ message: t }),
        });
        if (r.error) { toast_(r.error); patch({ streaming: false, streamingText: '' }); return; }
        finalize(r);
      } catch (e: any) {
        toast_('发送失败：' + (e?.message || e));
        patch({ streaming: false, streamingText: '' });
      }
    }
  }, [state.act, state.streaming, patch, ensureAct, toast_]);

  // —— 模式切换 ——
  const setMode = useCallback(async (m: Mode) => {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode: m }) });
    await loadState();
    toast_(m === 'real' ? '已切换真实模式（仅显示真实归因）' : '已切换演示模式');
  }, [loadState, toast_]);

  // —— 保存配置 ——
  const saveConfig = useCallback(async (body: { aiKey: string; espKey: string; espFrom: string; aiModel: string; aiBaseUrl?: string; shopBrand?: string }) => {
    const payload: Record<string, string> = {
      aiKey: body.aiKey.startsWith('•') ? '' : body.aiKey,
      espKey: body.espKey.startsWith('•') ? '' : body.espKey,
      espFrom: body.espFrom, aiModel: body.aiModel,
    };
    if (typeof body.aiBaseUrl === 'string') payload.aiBaseUrl = body.aiBaseUrl;
    if (typeof body.shopBrand === 'string') payload.shopBrand = body.shopBrand;
    const r = await api<{ status: Status }>('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    patch({ status: r.status });
    toast_('配置已保存（密钥仅存于服务端，不回传前端）');
  }, [patch, toast_]);

  // —— 重置 ——
  const resetData = useCallback(async () => {
    await api('/api/reset', { method: 'POST' });
    patch({ act: null, acts: [], planPushed: false, planShown: null, lastSent: null, chips: [], confirmState: null, confirmFailed: null });
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
  const authSubmit = useCallback(async (email: string, password: string, name: string): Promise<string | true> => {
    if (!email || !password) return '邮箱和密码不能为空';
    const isReg = state.authMode === 'register';
    const path = isReg ? '/api/auth/register' : '/api/auth/login';
    const body = isReg ? { email, password, name } : { email, password };
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), credentials: 'same-origin',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return j.error || '请求失败';
    patch({ authOpen: false });
    // 会话重建：注册/登录成功后必须补上 boot 阶段因未登录而没建好的会话，
    // 否则 sendMsg 命中「无会话」分支，助手静默失效（走查 P0-2）
    try {
      planRestoredRef.current.clear();
      await refreshMe();
      await loadState();
      await ensureAct();
    } catch { /* 会话重建失败时下次进入页面由 boot 兜底 */ }
    toast_(isReg ? '注册成功，欢迎！' : '登录成功');
    return true;
  }, [state.authMode, patch, refreshMe, loadState, ensureAct, toast_]);

  const authLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    // 会话级数据一并清空：否则登出后 UI 仍揣着上一账号的 act/受众，换账号登录后
    // loadState 的 `|| state.act` 兜底会把幻影 act 带回来，所有消息 404（线上 selftest 实锤）
    planRestoredRef.current.clear();
    patch({
      me: null, act: null, acts: [], drafts: [], audience: [], opportunities: null,
      planPushed: false, planShown: null, lastSent: null, chips: [],
      confirmState: null, confirmFailed: null,
      chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER, drawerAud: null, historyOpen: false,
    });
    refreshMe();
    toast_('已退出登录');
  }, [patch, refreshMe, toast_]);

  // —— 引导步骤里程碑自动推进（走查 P0-3）：步骤跟真实状态走（开始采集/方案就绪或已有草稿/已发送），
  // 不再按「点过几个快捷词」自增，避免未采集到需求就宣告前进或「闭环已跑通」 ——
  // 仅 safe 模式启用（顶栏 HintPill 串联引导需要状态推进）；demo 模式由 GuideOverlay + chips 手动驱动，
  // 否则 DB 里有历史已发送草稿时刷新即 hasSent→step 3，直接弹「引导已完成」
  useEffect(() => {
    setState(s => {
      if (s.guideStyle !== 'safe') return s;
      if (s.onboardingSkipped || s.onboardingStep >= 4) return s;
      const needCount = filledCount(s.act?.needs);
      const planReady = needCount >= 4 || Boolean(s.act?.planCard);
      const hasDraft = s.drafts.length > 0;
      const hasSent = s.drafts.some(d => ['queued', 'sending', 'sent', 'recovering'].includes(d.status));
      const target = hasSent ? 3 : (hasDraft || planReady) ? 2 : needCount > 0 ? 1 : 0;
      return target > s.onboardingStep ? { ...s, onboardingStep: target } : s;
    });
  }, [state.guideStyle, state.act?.needs, state.act?.planCard, state.drafts]);

  // —— 受众「去聊这拨人」→ 新建 act（预选受众）+ 切对话 + 预填输入 ——
  const jumpToConfig = useCallback(async (intent: string, aud?: Audience) => {
    const act = await createAct({ audience: intentToAudience(intent) });
    patch({
      act, acts: [act, ...state.acts], planPushed: false, planShown: null, activeTab: 'chat',
      confirmState: null, confirmFailed: null,   // 新会话无 confirm 状态
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

  // —— 确认卡预建草稿（旧后端回退路径 / demo 引导跳步用）：重活（变体/海报入队）提前跑，暂存给确认发送复用 ——
  const createCardDraft = useCallback(async (actId: string, card: PlanCard): Promise<Draft> => {
    const r = await api<{ draft: Draft; error?: string }>('/api/draft', {
      method: 'POST', body: JSON.stringify({ actId, planCard: card }),
    });
    if (r.error || !r.draft) throw new Error(r.error || '草稿生成失败');
    pendingCardDraft = { actId, draft: r.draft };
    return r.draft;
  }, []);

  // —— 方案卡「可以，去发」→ POST /api/act/:id/confirm（Wave2）：
  // 200 → 存 confirmState（planCard/checklist/holdout），留在对话页渲染方案卡 + 五项核对单，不切 mail tab；
  // 409（建码失败）→ confirmFailed 三出口（重试 / 现成码 / 无钩子），带 body 重调本 action；
  // 404（旧后端无此接口，部署窗口期）→ 回退旧路径：预建草稿 → 邮件 tab → EditModal。
  const confirmPlan = useCallback(async (body?: { reuse_code?: string; nohook?: boolean }) => {
    const act = state.act;
    if (!act || state.confirmBusy) return;
    patch({ confirmBusy: true, confirmFailed: null });
    try {
      const out = await confirmAct(act.id, body);
      if (out.kind === 'ok') {
        const planCard = out.planCard;
        const checklist = out.checklist ?? null;
        // 旧流程（demo 引导自动跳步）可能预建过草稿；confirm 由后端建稿 → 删暂存稿防僵尸
        const stale = pendingCardDraft && pendingCardDraft.actId === act.id ? pendingCardDraft.draft : null;
        pendingCardDraft = null;
        setState(prev => {
          if (!prev.act || prev.act.id !== act.id) return { ...prev, confirmBusy: false };
          const nextAct: Act = { ...mergeAct(prev.act, out.act), stage: 'S3', planCard: planCard || prev.act.planCard || null };
          return {
            ...prev,
            act: nextAct,
            acts: prev.acts.map(a => (a.id === nextAct.id ? nextAct : a)),
            confirmState: { actId: nextAct.id, planCard, checklist, holdout: checklist?.holdout ?? null },
            confirmFailed: null,
            planShown: 'confirm', planPushed: true,
            confirmBusy: false,
          };
        });
        if (stale) api(`/api/draft/${stale.id}`, { method: 'DELETE' }).catch(() => {});
        toast_(body?.nohook ? '已改为无钩子提醒信，请在下方方案卡核对后发送' : '方案已确认，请在下方方案卡核对后发送');
        return;
      }
      if (out.kind === 'conflict') {
        setState(prev => ({
          ...prev,
          confirmFailed: { reason: out.reason, options: out.options },
          confirmState: null,
          confirmBusy: false,
          ...(out.act && prev.act && out.act.id === prev.act.id ? { act: mergeAct(prev.act, out.act) } : {}),
        }));
        return;
      }
      // unsupported：旧后端无 confirm 接口 → 回退 Wave1 路径，保证部署窗口期可用
      const card = act.planCard;
      if (!card) { toast_('方案尚未生成'); return; }
      switchTab('mail');
      patch({ draftGenerating: true });
      try {
        const d = await createCardDraft(act.id, card);
        await loadState();
        patch({ editingDraft: d, editOpen: true });
      } catch (e: any) {
        toast_('草稿生成失败：' + (e?.message || e));
        switchTab('chat');
      }
      patch({ draftGenerating: false });
    } catch (e: any) {
      toast_('确认失败：' + (e?.message || e));
    } finally {
      patch({ confirmBusy: false });
    }
  }, [state.act, state.confirmBusy, patch, switchTab, createCardDraft, loadState, toast_]);

  // —— 方案卡「确认发送」→ POST /api/draft/:id/send（confirm 已在后端建稿，draft_id 直用）：
  // 409 闸门兜底 → 用服务端返回的最新 checklist 刷新 confirmState（方案卡红字标未过原因）；
  // 202 入队 → 轮询 → planShown='sent' 走现有 SentBanner 流。
  const sendConfirmedPlan = useCallback(async (): Promise<boolean> => {
    const cs = state.confirmState;
    const actId = state.act?.id;
    if (!cs || cs.actId !== actId) { toast_('请先确认方案'); return false; }
    let draftId = cs.planCard.draft_id || '';
    try {
      if (!draftId) {
        // 过渡期兜底：confirm 响应缺 draft_id → 现场补建草稿再发送
        const r = await api<{ draft?: Draft; error?: string }>('/api/draft', {
          method: 'POST', body: JSON.stringify({ actId, planCard: cs.planCard }),
        });
        if (r.error || !r.draft) { toast_(r.error || '草稿生成失败'); return false; }
        draftId = r.draft.id;
        setState(prev => (prev.confirmState && prev.confirmState.actId === actId
          ? { ...prev, confirmState: { ...prev.confirmState, planCard: { ...prev.confirmState.planCard, draft_id: draftId } } }
          : prev));
      }
      const r = await api<{ job_id?: string; queued?: boolean; result?: SendResult; ok?: boolean; checklist?: Checklist; error?: string }>(
        `/api/draft/${draftId}/send`, { method: 'POST', body: '{}' });
      // 闸门 409：服务端返回最新核对单 → 刷新重渲染（前端按钮本就该禁用，此处为服务端兜底）
      if (r.ok === false && r.checklist && Array.isArray(r.checklist.items)) {
        const fresh = r.checklist;
        setState(prev => (prev.confirmState && prev.confirmState.actId === actId
          ? { ...prev, confirmState: { ...prev.confirmState, checklist: fresh, holdout: fresh.holdout ?? prev.confirmState.holdout } }
          : prev));
        toast_('发送未通过核对单，请在方案卡查看未过项');
        return false;
      }
      if (r.error) { toast_(r.error); return false; }
      let res: SendResult | undefined = r.result;
      if (r.queued && r.job_id) {
        const j = await pollJob(r.job_id);
        if (!j.ok) { toast_('发送失败：' + (j.error || '未知错误')); await loadState(); return false; }
        res = j.result;
      }
      // confirm 建稿路径本地没有完整 Draft → 以 planCard 数据拼伪草稿供 SentBanner 展示（loadState 后邮件 tab 有真身）
      const pseudo: Draft = {
        id: draftId, subject: '', body: '', status: 'sent',
        matchedCount: Number(cs.planCard.reach_count) || 0,
        estGmv: Number(cs.planCard.estGmv?.amount) || 0,
        currency: cs.planCard.estGmv?.currency || undefined,
        cost: Number((res as any)?.cost) || 0,
      };
      patch({ planShown: 'sent', lastSent: { res: res || {}, draft: pseudo } });
      await loadState();
      toast_('邮件已发出 · 回流中…');
      return true;
    } catch (e: any) {
      toast_('发送失败：' + (e?.message || e));
      return false;
    }
  }, [state.confirmState, state.act, patch, loadState, pollJob, toast_]);

  // —— S3 改口复位：用户在对话里改参，后端把 act 弹回 S2（或切到无 confirmState 的会话）→
  // confirm 相关 state 复位，确认卡由 planPushed/act.stage 判断重新出现，不做死缓存。
  useEffect(() => {
    setState(s => {
      if (!s.confirmState) return s;
      if (!s.act || s.act.id !== s.confirmState.actId || s.act.stage !== 'S3') {
        return { ...s, confirmState: null, confirmFailed: null };
      }
      return s;
    });
  }, [state.act?.id, state.act?.stage]);

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

  // —— 卡片操作行「发送」（Figma 406:2955）：不经编辑弹窗，按存储原稿直接发送 ——
  const sendDraft = useCallback(async (d: Draft) => {
    if (['sent', 'sending', 'queued'].includes(d.status)) { toast_('该邮件已发送或正在发送'); return false; }
    try {
      const r = await api<{ job_id?: string; queued?: boolean; error?: string }>(`/api/draft/${d.id}/send`, {
        method: 'POST', body: '{}',
      });
      if (r.error) { toast_(r.error); return false; }
      if (r.queued && r.job_id) {
        const j = await pollJob(r.job_id);
        if (!j.ok) { toast_('发送失败：' + (j.error || '未知错误')); await loadState(); return false; }
      }
      toast_('邮件已发送');
      await loadState();
      return true;
    } catch (e: any) {
      toast_('发送失败：' + (e?.message || e));
      return false;
    }
  }, [loadState, pollJob, toast_]);

  // —— 卡片操作行「删除」：二步确认，删除后同步刷新列表 ——
  const deleteDraft = useCallback(async (d: Draft) => {
    if (!window.confirm(`删除这封「${d.subject || '未命名邮件'}」？`)) return false;
    try {
      const r = await api<{ deleted?: boolean; error?: string }>(`/api/draft/${d.id}`, { method: 'DELETE' });
      if (r.error) { toast_(r.error); return false; }
      if (state.editingDraft?.id === d.id) patch({ editOpen: false, editingDraft: null });
      toast_('已删除');
      await loadState();
      return true;
    } catch (e: any) {
      toast_('删除失败：' + (e?.message || e));
      return false;
    }
  }, [state.editingDraft, patch, loadState, toast_]);

  const value: AppContextValue = {
    ...state,
    switchTab, switchAct, loadState, newConversation, sendMsg, setMode, saveConfig, resetData, doImport,
    authSubmit, authLogout, jumpToConfig, confirmPlan, sendConfirmedPlan, createCardDraft, sendEditedDraft, sendDraft, deleteDraft,
    setChatInput: (v) => patch({ chatInput: v }),
    setChatPlaceholder: (v) => patch({ chatPlaceholder: v }),
    setPlanShown: (p) => patch({ planShown: p }),
    setPlanPushed: (v) => patch({ planPushed: v }),
    setEditingDraft: (d) => patch({ editingDraft: d }),
    setDrawerAud: (a) => patch({ drawerAud: a }),
    setOnboardingStep: (s) => patch({ onboardingStep: s }),
    skipOnboarding: () => patch({ onboardingStep: 4, onboardingSkipped: true }),
    setGuideStyle: (s) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem('cb_guide_style', s);
      patch({ guideStyle: s });
    },
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
