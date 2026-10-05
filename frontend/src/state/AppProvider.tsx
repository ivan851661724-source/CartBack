'use client';

/**
 * CartBack v3 全局状态与动作层（React Context）。
 * 1:1 移植自 app.js 的全局 state + boot/loadState/ensureAct/sendMsg/setMode/saveConfig/
 * resetData/doImport/auth/* / switchTab / jumpToConfig 等逻辑，仅把命令式 DOM 操控换成
 * 声明式 state。对话流卡片（confirm/sent）的 planShown 状态机原样保留。
 */
import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { api, setToken, streamMessage, createAct, confirmAct, ApiAuthError } from '@/lib/api';
import type {
  Act, Audience, Blackout, BatchPreview, Campaign, Checklist, Chips, Draft, Engine, Holdout,
  Kpis, LastPlan, Me, Metrics, Mode, NotificationItem, NotificationsResp, Opportunities, Prefs,
  PlanCard, SendResult, Status, StoreBanner, TodoItem, TrendPoint, WelcomeState,
} from '@/lib/types';
import { CHAT_PLACEHOLDER, intentToAudience } from '@/lib/constants';

export type Tab = 'chat' | 'mail' | 'data' | 'aud' | 'comp' | 'set';
/** 对话流卡片状态机：confirm=确认卡 / sent=发送回执条（'plan' 成员已随 EmailConfigPanel 死代码清理删除，Wave5） */
export type PlanShown = 'confirm' | 'sent' | null;

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

/** 停发域缺省安全值（后端未升级/字段缺失时按「未停发」处理，徽标不误报） */
export const EMPTY_BLACKOUT: Blackout = { active: false, ranges: [] };

/** done 帧 batches 安全解析：仅保留结构完整的批次方案（name 必须为字符串） */
function parseBatches(raw: unknown): BatchPreview[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (b): b is BatchPreview =>
      !!b && typeof b === 'object' && typeof (b as BatchPreview).name === 'string',
  );
}

/** /api/state 顶层批次域安全解析：campaigns 数组 / blackout 对象 / global_paused 布尔 */
function parseBatchDomain(s: any): { campaigns: Campaign[]; blackout: Blackout; global_paused: boolean } {
  const b = s?.blackout;
  return {
    campaigns: Array.isArray(s?.campaigns) ? (s.campaigns as Campaign[]) : [],
    blackout: b && typeof b === 'object'
      ? { active: Boolean(b.active), ranges: Array.isArray(b.ranges) ? b.ranges : [] }
      : EMPTY_BLACKOUT,
    global_paused: Boolean(s?.global_paused),
  };
}

// —— Wave4 /api/state 顶层新域安全解析（均可缺省：旧后端无这些键时按空缺省处理，UI 不误报） ——

/** Z4 欢迎态：{eligible} 布尔域；缺省 null */
function parseWelcome(raw: unknown): WelcomeState | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as WelcomeState;
  return {
    eligible: Boolean(w.eligible),
    opening: typeof w.opening === 'string' && w.opening ? w.opening : undefined,
    chips: Array.isArray(w.chips) ? w.chips.filter((c): c is string => typeof c === 'string') : undefined,
  };
}

/** F1 店铺横幅数据（数据开场句数据源）：connected 必转布尔，数值字段非法时丢弃 */
function parseStoreBanner(raw: unknown): StoreBanner | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as StoreBanner;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return {
    connected: Boolean(b.connected),
    store_name: typeof b.store_name === 'string' && b.store_name ? b.store_name : undefined,
    weekly_abandoned_count: num(b.weekly_abandoned_count),
    aov: num(b.aov),
    abandoned_value: num(b.abandoned_value),
    currency: typeof b.currency === 'string' && b.currency ? b.currency : undefined,
  };
}

/** Z6 偏好：只挑已知字符串键（多余键丢弃，避免把后端内部结构灌进 UI） */
function parsePrefs(raw: unknown): Prefs {
  const out: Prefs = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const p = raw as Record<string, unknown>;
  for (const k of ['brand', 'tone', 'discount_habit', 'signature'] as const) {
    if (typeof p[k] === 'string' && (p[k] as string)) out[k] = p[k] as string;
  }
  return out;
}

/** Z4 上次方案：audience 缺失/为空则整体视为无（摘要卡不渲染半残数据） */
function parseLastPlan(raw: unknown): LastPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as LastPlan;
  if (typeof p.audience !== 'string' || !p.audience) return null;
  return {
    audience: p.audience,
    offer_text: typeof p.offer_text === 'string' ? p.offer_text : '',
    discount_text: typeof p.discount_text === 'string' ? p.discount_text : '',
    est_gmv_amount: Number(p.est_gmv_amount) || 0,
    currency: typeof p.currency === 'string' ? p.currency : '',
    confirmed_at: p.confirmed_at as number | string,
    campaign_name: typeof p.campaign_name === 'string' && p.campaign_name ? p.campaign_name : undefined,
  };
}

/** Z5 待办：只保留结构完整项（id 非空字符串 + summary 字符串）；缺省/非法 → []（旧后端无此键不渲染待办区） */
function parseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (t): t is TodoItem =>
      !!t && typeof t === 'object'
      && typeof (t as TodoItem).id === 'string' && !!(t as TodoItem).id
      && typeof (t as TodoItem).summary === 'string',
  );
}

// 确认卡预建草稿暂存（单用户本地应用，模块级即可）：仅旧后端回退路径（/confirm 404）会预建，
// demo 引导跳步不再预建（复测 10-03：预建稿让刷新后的确认卡召回被 P1-9「有草稿不反推」压制，
// 且 confirm 建权威稿后此稿被当僵尸稿删除）。confirm 新接口成功后若存在暂存草稿则删除，兜底防重
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

/** 后端 act 序列化的方案卡键是 plan_card（snake）——统一映射为前端 planCard。
 *  S2 无码预览卡（preview 标记）与 S3 权威卡都随 /api/state 下发，刷新后可召回（A2/P0-N2） */
function withPlanCard(a: any): Act {
  if (!a || typeof a !== 'object') return a;
  return { ...a, planCard: a.planCard ?? a.plan_card ?? null };
}

/** B4 合法槽位（done 帧 askedSlot 白名单） */
const ASKED_SLOTS = ['audience', 'reason', 'offer', 'goal'];

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
  askedSlot: string | null;  // B4 本轮追问的槽位（done 帧下发，与 chips 同源同生命周期）；goal 槽 chips 走输入框复合形态（C4）
  // Wave2 confirm 流：confirm 200 的方案卡/核对单（留在对话页渲染 PlanCard 卡）+ 409 三出口 + 忙态
  confirmState: ConfirmState | null;
  confirmFailed: ConfirmFailed | null;
  confirmBusy: boolean;
  // Wave3 批次域：/api/state 顶层的正式批次 / 停发日历 / 全局停发（列表只读展示，管理动作在对话里）
  campaigns: Campaign[];
  blackout: Blackout;
  global_paused: boolean;
  // done 帧 batches：agent 提出待确认的建批方案（与 chips 同生命周期：新消息/切会话清空）
  pendingBatches: BatchPreview[];
  // Wave4 Z4/C5/Z6：/api/state 顶层新域（均可缺省，旧后端安全降级为空值）
  welcome: WelcomeState | null;      // 首屏欢迎态（eligible=名下无任何 act；欢迎语文案由后端 opening 下发）
  storeBanner: StoreBanner | null;   // F1 数据开场句数据源（连接状态/周弃购数/客单价…）
  prefs: Prefs;                      // 商家偏好（语气/折扣习惯/署名）
  lastPlan: LastPlan | null;         // 上次方案摘要（对话空态复用入口）
  // Wave5 Z5：待办（未 done 倒序 ≤20；A4 收口的可见出口，对话空态渲染，「继续」恢复原会话）
  todos: TodoItem[];
  // Wave4 Z7 通知域：GET /api/notifications（倒序 ≤50）+ 未读数
  notifications: NotificationItem[];
  unread: number;
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
}

interface AppContextValue extends AppState {
  // 动作
  switchTab: (t: Tab) => void;
  switchAct: (id: string) => void;
  loadState: (opts?: { preferActId?: string }) => Promise<void>;        // 多会话 #2：切换会话（重置卡片/输入等会话级状态）；resumeTodo 传 preferActId 锚定刚恢复的会话
  newConversation: () => Promise<void>;   // 多会话 #2：新建会话
  resumeTodo: (id: string) => Promise<void>;   // Z5：待办「继续」→ POST /api/todos/:id/resume 以原 act 数据预填的新会话恢复对话
  sendMsg: (text: string) => Promise<void>;
  setMode: (m: Mode) => Promise<void>;
  saveConfig: (body: { espKey: string; espFrom: string; shopBrand?: string; aiKey?: string; aiModel?: string; aiBaseUrl?: string }) => Promise<void>;
  resetData: () => Promise<void>;
  doImport: (csv: string) => Promise<boolean>;
  authSubmit: (email: string, password: string, name: string) => Promise<string | true>;
  authLogout: () => Promise<void>;
  jumpToConfig: (intent: string, aud?: Audience) => Promise<void>;
  confirmPlan: (body?: { reuse_code?: string; nohook?: boolean }) => Promise<void>;  // 确认卡「可以，去发」/ 409 三出口（带 body 重调）
  sendConfirmedPlan: () => Promise<boolean>;   // 方案卡「确认发送」：POST /api/draft/:id/send，409 时刷新核对单
  createCardDraft: (actId: string, card: PlanCard) => Promise<Draft>;   // 确认卡预建草稿（仅旧后端回退路径用）
  sendEditedDraft: (subject: string, body: string) => Promise<boolean>;
  sendDraft: (d: Draft) => Promise<boolean>;        // 卡片操作行「发送」：按存储原稿直接发送（Figma 406:2955）
  deleteDraft: (d: Draft) => Promise<boolean>;      // 卡片操作行「删除」
  refreshNotifications: () => Promise<void>;        // Z7：拉取通知列表与未读数（60s 轮询 + loadState 后顺带）
  markNotificationsRead: (ids?: string[]) => Promise<void>;  // Z7：标记已读（缺省全部；本地先行置灰不阻塞）
  // setters
  setChatInput: (v: string) => void;
  setChatPlaceholder: (v: string) => void;
  setPlanShown: (p: PlanShown) => void;
  setPlanPushed: (v: boolean) => void;
  setEditingDraft: (d: Draft | null) => void;
  setDrawerAud: (a: Audience | null) => void;
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
    engine: 'online', chips: [], askedSlot: null,
    confirmState: null, confirmFailed: null, confirmBusy: false,
    campaigns: [], blackout: EMPTY_BLACKOUT, global_paused: false, pendingBatches: [],
    welcome: null, storeBanner: null, prefs: {}, lastPlan: null,
    todos: [],
    notifications: [], unread: 0,
    booted: false, activeTab: 'chat', chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
    streaming: false, streamingText: '', editingDraft: null, drawerAud: null,
    importOpen: false, historyOpen: false, editOpen: false, draftGenerating: false, authOpen: false, authMode: 'register',
    toast: { msg: '', shown: false },
  });

  // 多会话 #2 性能：act 索引 Map（O(1) 查找，避免 O(n) scans on every loadState）
  const actIndexRef = useRef<Map<string, Act>>(new Map());
  // P0-N1（复测 10-03）：loadState 刚锚定的会话（A1「打开面板取最近未完结 act」的权威结果）。
  // boot 旧闭包里 state.act 恒为 null，ensureAct 读闭包每次刷新都去 createAct → 后端建新会话时把
  // 未完结 act 全部置 closed，进度与上下文全丢。有锚点绝不新建；新建只由「新会话」按钮触发（A1-5）。
  const anchoredActRef = useRef<Act | null>(null);
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

  // —— Z7 通知：拉取（60s 轮询 + loadState 后顺带）——
  // 接口缺失/旧后端 404 / 网络失败时静默保持现值（列表空、角标不出现），不 toast 不阻塞。
  const refreshNotifications = useCallback(async () => {
    try {
      const r = await api<NotificationsResp>('/api/notifications');
      if (r && Array.isArray(r.items)) {
        patch({
          notifications: (r.items as NotificationItem[]).filter((n) => n && typeof n === 'object' && n.id != null),
          unread: Number(r.unread) || 0,
        });
      }
    } catch { /* 旧后端无此接口：保持现值 */ }
  }, [patch]);

  // —— Z7 通知：标记已读（缺省 ids = 全部）。本地先行置灰（打开铃铛即视为已读），POST 失败不回滚 UI ——
  const markNotificationsRead = useCallback(async (ids?: string[]) => {
    setState(prev => ({
      ...prev,
      unread: 0,
      notifications: prev.notifications.map(n => (!ids || ids.includes(n.id)) ? { ...n, read: true } : n),
    }));
    try {
      await api('/api/notifications/read', {
        method: 'POST', body: JSON.stringify(ids ? { ids } : {}),
      });
    } catch { /* 接口缺失不阻塞 UI；下次轮询以服务端为准 */ }
  }, []);

  // —— 数据加载 ——
  // P0-N2（复测 10-03）：整个锚定/合并逻辑放进函数式 setState 读「当下最新」的 state——
  // 旧实现读渲染闭包里的 state.act，sendMsg 的 done 帧刚写入的 planCard 会被紧随其后的
  // loadState 用无卡的服务端 act 覆盖（满 4/4 当轮确认卡不弹的第三处清空点）。
  const loadState = useCallback(async (opts?: { preferActId?: string }) => {
    const s = await api<any>('/api/state');
    const acts: Act[] = ((s.acts || []) as any[]).map(withPlanCard);
    const actIndex = buildActIndex(acts);
    // Z7 顺带刷新通知（内部已吞错，不阻塞 loadState 主流程）
    refreshNotifications();
    // 同步锚点（P0-N1）：boot 在 loadState 之后立刻 ensureAct，而 setState updater 是异步冲刷的——
    // 锚点必须同步写入 ref，ensureAct 才不会误判「无会话」而新建。job 只有一个：名下存在未完结 act
    // 时禁止新建（A1）；updater 里的精细锚点（含 planCard 合并）冲刷后接管。
    anchoredActRef.current = (opts?.preferActId ? actIndex.get(opts.preferActId) || null : null)
      || acts.find(a => a.stage !== 'closed') || null;
    setState(prev => {
      // 多会话 #2：当前选中优先（O(1) Map 查找）；缺位时按 A1 锚定「最近未完结 act」——
      // 绝不锚 closed act（closeOpenActs 会刷新 closed act 的 updated_at 使其排到首位），
      // 也绝不因锚定失败而新建（新建只由「新会话」按钮触发，后端建新会话会关闭其它未收口会话）
      const preferId = opts?.preferActId ?? prev.act?.id ?? '';
      const nextActRaw = actIndex.get(preferId) || acts.find(a => a.stage !== 'closed') || null;
      // 同会话沿用内存 planCard：S2 预览卡仅随 done 帧下发、/api/state 可能滞后一拍
      const nextAct = nextActRaw && prev.act && nextActRaw.id === prev.act.id && prev.act.planCard && !nextActRaw.planCard
        ? { ...nextActRaw, planCard: prev.act.planCard }
        : nextActRaw;
      anchoredActRef.current = nextAct;   // ensureAct 的权威依据：有锚点绝不新建（A1/P0-N1）
      // 锚定结果与会话切换同口径：卡片/chips/confirm 状态属于上一会话，切会话即失效
      const actChanged = (nextAct?.id || null) !== (prev.act?.id || null);
      let next: AppState = {
        ...prev,
        status: s.status, kpis: s.kpis, trend: s.trend,
        metrics: s.metrics || {}, demoAnchorRoi: s.demoAnchorRoi,
        drafts: s.drafts, audience: s.audience,
        acts,
        // Wave3 批次域：campaigns/blackout/global_paused（缺省安全值；pendingBatches 是 done 帧专属，不在此触碰）
        ...parseBatchDomain(s),
        // Wave4 Z4/C5/Z6 + Wave5 Z5：welcome/store_banner/prefs/last_plan/todos（均可缺省，安全降级）
        welcome: parseWelcome(s.welcome),
        storeBanner: parseStoreBanner(s.store_banner),
        prefs: parsePrefs(s.prefs),
        lastPlan: parseLastPlan(s.last_plan),
        todos: parseTodos(s.todos),
        // 引擎健康态：仅接受合法值，非法/缺省保持现值（初始 online）
        ...(s.engine === 'online' || s.engine === 'degraded' ? { engine: s.engine as Engine } : {}),
        act: nextAct,
        ...(actChanged ? {
          planPushed: false, planShown: null,
          confirmState: null, confirmFailed: null,
          chips: [], askedSlot: null, pendingBatches: [],
        } : {}),
      };
      // 刷新后方案卡召回移到独立的纯 effect（见下方 planCardRestore effect）——
      // 不能放进 setState updater：updater 必须纯净，StrictMode 开发态双调用会让
      // planRestoredRef 的副作用泄漏进第二次计算（第一次已 add → 第二次跳过 → 恢复永远不生效）
      return next;
    });
  }, [buildActIndex, refreshNotifications]);

  // 刷新后方案卡召回（走查 P1-9 + 复测 10-03 A2）：act 带 planCard（S2 预览卡已落库 / S3 权威卡）、
  // 本会话没有草稿、且本页未召回过 → 重现确认卡（每会话仅一次）。effect 写法对 StrictMode 幂等：
  // 判断全部来自已提交 state，副作用只有 planRestoredRef.add + 一次 patch。
  // 已有草稿的会话不反推（「可以，去发」的草稿说明商家已在邮件页流程中，卡片不再强行弹回）。
  useEffect(() => {
    const a = state.act;
    if (!a || !a.planCard || state.planShown) return;
    if ((state.drafts || []).some(d => d.act_id === a.id)) return;
    if (planRestoredRef.current.has(a.id)) return;
    planRestoredRef.current.add(a.id);
    patch({ planShown: 'confirm', planPushed: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.act?.id, state.act?.planCard, state.planShown, state.drafts, patch]);

  const ensureAct = useCallback(async (): Promise<Act | null> => {
    // P0-N1：有锚点（loadState 刚恢复的未完结会话）绝不新建——旧实现读首帧闭包 state.act（恒 null），
    // 每次刷新都 createAct，后端建新会话时 closeOpenActs 把未完结 act 全部置 closed，进度全丢
    if (anchoredActRef.current) return anchoredActRef.current;
    try {
      const r = await createAct();
      anchoredActRef.current = r.act;
      actIndexRef.current.set(r.act.id, r.act);
      setState(prev => ({
        ...prev,
        act: r.act,
        acts: [r.act, ...prev.acts.filter(a => a.id !== r.act.id)],
        chips: r.chips,   // P0-N4：开场白 chips 随建会话响应下发，不再丢弃
        ...(r.store_banner ? { storeBanner: parseStoreBanner(r.store_banner) } : {}),
      }));
      return r.act;
    } catch {
      // 未登录/网络失败等导致建不了会话：返回 null，由调用方决定引导方式（不再静默丢消息）
      return null;
    }
  }, []);

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
    anchoredActRef.current = next;
    patch({
      act: next, historyOpen: false, activeTab: 'chat',
      planPushed: false, planShown: null,
      confirmState: null, confirmFailed: null,   // confirm 状态属于上一会话，切会话即失效
      chips: [],   // chips 属于上一会话的最新回复，切会话即失效
      askedSlot: null,   // 追问槽位同属上一会话
      pendingBatches: [],   // done 帧待确认批次同属上一会话的最新回复，一并失效
      chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
    });
  }, [state.streaming, state.act, patch, toast_]);

  // —— 多会话 #2：新建会话（新建 act 置顶并直接进入对话） ——
  const newConversation = useCallback(async () => {
    try {
      const r = await createAct();
      actIndexRef.current.set(r.act.id, r.act);
      anchoredActRef.current = r.act;
      patch({
        act: r.act, acts: [r.act, ...state.acts.filter(a => a.id !== r.act.id)],
        historyOpen: false, activeTab: 'chat',
        planPushed: false, planShown: null,
        confirmState: null, confirmFailed: null,   // 新会话无 confirm 状态
        chips: r.chips,   // P0-N4：开场白 chips 随建会话响应下发（服务端 opening 同源），不再置空丢失
        askedSlot: null,   // 新会话尚无追问
        pendingBatches: [],   // 新会话无待确认批次
        chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
      });
    } catch (e: any) {
      toast_('新建会话失败：' + (e?.message || e));
    }
  }, [state.acts, patch, toast_]);

  // —— Z5 待办「继续」→ POST /api/todos/:id/resume：以原 act 数据预填开新会话。
  // 200 {ok, act} → 用响应 act 切换会话（参照 switchAct 清会话级状态）+ loadState({preferActId}) 回合末刷新；
  // 409（该待办已 done）→ 静默刷新待办列表（不切会话不报错）；其余失败 toast。走裸 fetch 取状态码（api() 不透传 status）。
  const resumeTodo = useCallback(async (id: string) => {
    if (state.streaming) { toast_('回复生成中，稍等再切换'); return; }
    if (!id) return;
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(id)}/resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      });
      if (res.status === 409) {
        // 待办已完成：仅刷新（done 项随下次 /api/state 从 todos 消失），当前会话保持不动
        loadState().catch(() => {});
        return;
      }
      const data = await res.json().catch(() => null);
      const nextAct = data && data.act && typeof data.act.id === 'string' && data.act.id
        ? (data.act as Act) : null;
      if (!res.ok || !nextAct) { toast_('继续待办失败，请稍后再试'); return; }
      // 预填的新会话置为当前；不在本地列表时并入头部，并登记 actIndex（loadState 的 O(1) 查找要用）
      const acts = [nextAct, ...state.acts.filter((a) => a.id !== nextAct.id)];
      actIndexRef.current.set(nextAct.id, nextAct);
      anchoredActRef.current = nextAct;
      patch({
        act: nextAct, acts, activeTab: 'chat',
        planPushed: false, planShown: null,
        confirmState: null, confirmFailed: null,   // confirm 状态属于上一会话，切会话即失效
        chips: [],   // chips 属于上一会话的最新回复，切会话即失效
        askedSlot: null,   // 追问槽位同属上一会话
        pendingBatches: [],   // 待确认批次同属上一会话的最新回复，一并失效
        chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER,
      });
      await loadState({ preferActId: nextAct.id });   // 刷新 campaigns/todos/通知等，锚定新会话防旧闭包抢回
    } catch {
      toast_('继续待办失败，请稍后再试');
    }
  }, [state.streaming, state.acts, patch, toast_, loadState]);

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
    // 发送新消息即清空上一回复的 chips、追问槽位与待确认批次（新值由本轮 done 帧重新下发；
    // 用户点「确认建批」chip 后后端真正建批，本轮 done 帧无 batches → pendingBatches 随之清空）
    patch({ act: actWithUser, streaming: true, streamingText: '', chips: [], askedSlot: null, pendingBatches: [] });

    const finalize = (r: { reply: string; stage?: any; needs?: any; planCard?: PlanCard | null; chips?: unknown; askedSlot?: unknown; engine?: unknown; batches?: unknown }) => {
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
        // B4 追问槽位（与 chips 同源；goal 槽 chips 走输入框复合形态）：仅接受合法槽名
        const askedSlot = ASKED_SLOTS.includes(r.askedSlot as string) ? (r.askedSlot as string) : null;
        // Wave3：done 帧 batches（待确认建批方案）——只收结构完整项；缺省/空 → 清空（与 chips 同生命周期）
        const pendingBatches = parseBatches(r.batches);
        // engine：仅接受合法值，否则保持现值
        const engine = r.engine === 'online' || r.engine === 'degraded' ? r.engine : prev.engine;
        return {
          ...prev, act: nextAct, streaming: false, streamingText: '',
          engine, chips, askedSlot, pendingBatches,
          // 多会话 #2：acts 里的同一会话同步为新状态（历史列表摘要/时间随之更新）
          acts: prev.acts.map(a => (a.id === nextAct.id ? nextAct : a)),
          planPushed: pushConfirm ? true : prev.planPushed,
          planShown: pushConfirm ? 'confirm' : prev.planShown,
        };
      });
    };

    let got = false;       // 是否已收到 token 帧（= 服务端已开始交付，本轮 LLM 已计费）
    let last = '';         // 最近一帧累计文本（流中断时保留已到内容）
    // 回合结束拉一次 /api/state：批次管理（建批/暂停/恢复/改折扣…）由后端在本轮消息里处理，
    // campaigns/blackout/global_paused 只有这里能刷新（对话是驾驶舱，卡片不自调管理 API）
    const refreshBatchDomain = () => { loadState().catch(() => {}); };
    try {
      const result = await streamMessage(act.id, t, (full) => { got = true; last = full; patch({ streamingText: full }); });
      finalize(result);
      refreshBatchDomain();
    } catch {
      if (got) {
        // 已收到部分内容：服务端已完成并落库，不再降级重发（避免二次计费 + 重复回复），保留已到文本
        finalize({ reply: last });
        refreshBatchDomain();
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
        refreshBatchDomain();
      } catch (e: any) {
        toast_('发送失败：' + (e?.message || e));
        patch({ streaming: false, streamingText: '' });
      }
    }
  }, [state.act, state.streaming, patch, ensureAct, toast_, loadState]);

  // —— 模式切换 ——
  const setMode = useCallback(async (m: Mode) => {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ mode: m }) });
    await loadState();
    toast_(m === 'real' ? '已切换真实模式（仅显示真实归因）' : '已切换演示模式');
  }, [loadState, toast_]);

  // —— 保存配置 ——
  // aiKey/aiModel/aiBaseUrl 不再由设置页下发（AI 连接由服务端环境变量接管）；字段可选，传了才携带。
  const saveConfig = useCallback(async (body: { espKey: string; espFrom: string; shopBrand?: string; aiKey?: string; aiModel?: string; aiBaseUrl?: string }) => {
    const payload: Record<string, string> = {
      espKey: body.espKey.startsWith('•') ? '' : body.espKey,
      espFrom: body.espFrom,
    };
    if (typeof body.aiKey === 'string') payload.aiKey = body.aiKey.startsWith('•') ? '' : body.aiKey;
    if (typeof body.aiModel === 'string') payload.aiModel = body.aiModel;
    if (typeof body.aiBaseUrl === 'string') payload.aiBaseUrl = body.aiBaseUrl;
    if (typeof body.shopBrand === 'string') payload.shopBrand = body.shopBrand;
    const r = await api<{ status: Status }>('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    patch({ status: r.status });
    toast_('配置已保存（密钥仅存于服务端，不回传前端）');
  }, [patch, toast_]);

  // —— 重置 ——
  const resetData = useCallback(async () => {
    await api('/api/reset', { method: 'POST' });
    anchoredActRef.current = null;
    patch({ act: null, acts: [], planPushed: false, planShown: null, lastSent: null, chips: [], askedSlot: null, confirmState: null, confirmFailed: null, pendingBatches: [] });
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
    anchoredActRef.current = null;   // 锚点属账号数据，登出即失效（否则换号登录会锚到上一账号会话）
    patch({
      me: null, act: null, acts: [], drafts: [], audience: [], opportunities: null,
      planPushed: false, planShown: null, lastSent: null, chips: [], askedSlot: null,
      confirmState: null, confirmFailed: null,
      campaigns: [], blackout: EMPTY_BLACKOUT, global_paused: false, pendingBatches: [],   // 批次域属账号数据，登出一并清空
      welcome: null, storeBanner: null, prefs: {}, lastPlan: null,   // Wave4 新域同属账号数据
      todos: [],   // Z5 待办亦然
      notifications: [], unread: 0,   // Z7 通知亦然
      chatInput: '', chatPlaceholder: CHAT_PLACEHOLDER, drawerAud: null, historyOpen: false,
    });
    refreshMe();
    toast_('已退出登录');
  }, [patch, refreshMe, toast_]);

  // —— 受众「去聊这拨人」→ 新建 act（预选受众）+ 切对话 + 预填输入 ——
  const jumpToConfig = useCallback(async (intent: string, aud?: Audience) => {
    const r = await createAct({ audience: intentToAudience(intent) });
    actIndexRef.current.set(r.act.id, r.act);
    anchoredActRef.current = r.act;
    patch({
      act: r.act, acts: [r.act, ...state.acts.filter(a => a.id !== r.act.id)], planPushed: false, planShown: null, activeTab: 'chat',
      confirmState: null, confirmFailed: null,   // 新会话无 confirm 状态
      chips: [],   // preset 会话开场已定向受众，opening chips（受众三项）与下一问不同源，等首轮 done 帧
      askedSlot: null,
      pendingBatches: [],   // 新会话无待确认批次
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

  // —— 确认卡预建草稿（仅旧后端回退路径用）：/confirm 404（部署窗口期）时兜底建稿；新后端流程草稿一律由 confirm 服务端权威创建 ——
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
    switchTab, switchAct, loadState, newConversation, resumeTodo, sendMsg, setMode, saveConfig, resetData, doImport,
    authSubmit, authLogout, jumpToConfig, confirmPlan, sendConfirmedPlan, createCardDraft, sendEditedDraft, sendDraft, deleteDraft,
    refreshNotifications, markNotificationsRead,
    setChatInput: (v) => patch({ chatInput: v }),
    setChatPlaceholder: (v) => patch({ chatPlaceholder: v }),
    setPlanShown: (p) => patch({ planShown: p }),
    setPlanPushed: (v) => patch({ planPushed: v }),
    setEditingDraft: (d) => patch({ editingDraft: d }),
    setDrawerAud: (a) => patch({ drawerAud: a }),
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
