/**
 * CartBack v3 前端类型 —— 严格对齐后端 /api 响应（与 app.js 的 state 字段一一对应）。
 * 这些类型描述网络边界；组件内部 UI 状态（activeTab / planShown 等）见各组件。
 */

/** 运行模式 */
export type Mode = 'demo' | 'real';

/** 引导式对话 FSM 阶段（IGDE：S0→S3，逻辑不可改） */
export type Stage = 'S0' | 'S1' | 'S2' | 'S3';

/** 配置状态（/api/bootstrap、/api/state 的 status；绝不含密钥明文） */
export interface Status {
  mode: Mode;
  aiConfigured: boolean;
  espConfigured: boolean;
  espFrom: string;
  aiProvider: string;
  aiModel: string;
  espProvider: string;
  attributionWindowDays: number;
  emailTimeoutDays: number;
  sendRateLimitPerMin: number;
  shopDefaultLocale: string;
  storeConfigured: boolean;
  storeTypes: string[];
}

/** 静默采集的 4 项需求（IGDE 核心 IP：audience/pain/goal/offer） */
export interface Needs {
  audience?: string;
  pain?: string;
  goal?: string;
  offer?: string;
}

/** 方案卡：信息齐了由引擎生成（pushConfirm / pushPlan 渲染） */
export interface PlanCard {
  audience?: string;
  pain?: string;
  goal?: string;
  offer?: string;
  discount?: string;
  subject?: string;
  body?: string;
  sendTiming?: string;
  matchedCount?: number;
  coupon?: string;
  locale?: string;
}

/** 单条对话消息 */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** 一次挽回活动（对话会话 + 采集 + 方案） */
export interface Act {
  id: string;
  stage: Stage;
  needs: Needs;
  messages: Message[];
  planCard?: PlanCard | null;
}

/** 邮件草稿 / 已发送（生命周期状态机） */
export type DraftStatus =
  | 'draft'
  | 'sending'
  | 'sent'
  | 'recovering'
  | 'timeout'
  | 'failed'
  | 'recovered';

export interface Draft {
  id: string;
  subject: string;
  body: string;
  status: DraftStatus;
  matchedCount: number;
  sendTiming?: string;
  locale?: string;
  estGmv: number;
  cost: number;
}

/** 受众 / 高意向流失个体（CSV 导入或店铺拉取） */
export interface Audience {
  name: string;
  email: string;
  intent: string;
  risk: string; // '高' | '中' | '低'
  price: string; // '高' | '中' | '低'
  abandoned_value: number;
  estGmv: number;
  urgencyDays?: number | null;
  source?: string;
  score?: number | null;
}

/** 数据看板北极星 KPI（/api/state 的 kpis） */
export interface Kpis {
  sent: number;
  openRate: number;
  clickRate: number;
  convert: number;
  gmv: number;
  roi: number;
  cost: number;
  open: number;
  click: number;
  failed?: number;
  timeout?: number;
  estTotal?: number;
}

/** 7 日趋势点 */
export interface TrendPoint {
  gmv: number;
  [k: string]: number;
}

/** 运维指标条（架构 §7 B6） */
export interface Metrics {
  send_volume?: number;
  token_usage?: number;
  send_fail?: number;
  send_real?: number;
  guardrail_L0?: number;
  guardrail_L2?: number;
  guardrail_L4?: number;
  guardrail_L3?: number;
}

/** /api/opportunities —— 新流失主动提醒 */
export interface Opportunities {
  message: string;
  newCount?: number;
  untargeted?: number;
  opportunities: Audience[];
}

/** 发送结果（/api/draft/:id/send 的 result） */
export interface SendResult {
  recipients?: number;
  cost?: number;
  [k: string]: unknown;
}

/** /api/auth/me */
export interface User {
  id: string;
  email: string;
  name: string;
  status: string;
  created_at: string;
}
export interface Me {
  user: User;
  authMode?: 'session' | string;
}

/** 通用后端错误 */
export interface ApiError {
  error: string;
}
