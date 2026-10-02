/**
 * CartBack v3 前端类型 —— 严格对齐后端 /api 响应（与 app.js 的 state 字段一一对应）。
 * 这些类型描述网络边界；组件内部 UI 状态（activeTab / planShown 等）见各组件。
 */

/** 运行模式 */
export type Mode = 'demo' | 'real';

/** 引导式对话 FSM 阶段（IGDE：S0→S3，逻辑不可改；closed = 会话已闭环结束） */
export type Stage = 'S0' | 'S1' | 'S2' | 'S3' | 'closed';

/** 引擎健康状态（GET /api/state 顶层 + SSE done 帧）：degraded = AI 未连接，走模板降级 */
export type Engine = 'online' | 'degraded';

/** 回复快捷 chips（SSE done 帧下发，针对最新一条 agent 回复；空数组 = 无 chips） */
export type Chips = string[];

/** 单个 needs 槽的值：显式/推断来源 + 采集时间（新契约三态对象） */
export interface NeedValue {
  value: string;
  source: 'explicit' | 'inferred';
  at: number;
}

/** 槽位兼容形态：新契约对象 | 旧版纯字符串（过渡期后端/历史数据） | 空 */
export type NeedSlot = NeedValue | string | null;

/** 配置状态（/api/bootstrap、/api/state 的 status；绝不含密钥明文） */
export interface Status {
  mode: Mode;
  aiConfigured: boolean;
  espConfigured: boolean;
  espFrom: string;
  aiProvider: string;
  aiModel: string;
  aiBaseUrl: string;
  espProvider: string;
  attributionWindowDays: number;
  emailTimeoutDays: number;
  sendRateLimitPerMin: number;
  shopDefaultLocale: string;
  shopBrand: string;    // M4：商家品牌名（邮件落款/页脚/发件人名；空 = 未配置）
  storeConfigured: boolean;
  storeTypes: string[];
}

/** 静默采集的 4 项需求（IGDE 核心 IP：audience/reason/goal/offer），每槽 null | 对象（兼容旧字符串） */
export interface Needs {
  audience?: NeedSlot;
  reason?: NeedSlot;
  goal?: NeedSlot;
  offer?: NeedSlot;
}

/** act.memory：槽位纠正 / 主动补充 / 偏好 / 追问计数（新契约序列化，本波仅透传） */
export interface ActMemory {
  corrections: { slot: string; old: string; new: string; at: number }[];
  extras: { key: string; value: string; at: number }[];
  prefs: Record<string, unknown>;
  ask_count: Record<string, number>;
}

/** 方案卡：信息齐了由引擎生成（pushConfirm / pushPlan 渲染）。注意：planCard 字段名后端未随 needs 改名，pain 保留 */
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
  memory?: ActMemory;      // 新契约：槽位纠正/补充等记忆（本波前端仅透传）
  filled_count?: number;   // 新契约：已填槽数（0-4；前端以 filledCount(needs) 实时计算为准）
  code_status?: string;    // 新契约：折扣码状态（本波恒 "none"，忽略）
  created_at?: number;
  updated_at?: number;
}

/** 邮件草稿 / 已发送（生命周期状态机） */
export type DraftStatus =
  | 'draft'
  | 'queued'      // 202 已入队（发送队列执行中）
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
  tag_distribution?: Array<{ tag_type: string; tag_value: string; count: number; avg_weight: number }>;
  image_prompt?: string;   // 万相出图提示词快照（EditModal 编辑态展示 / 生成图片复用）
  act_id?: string;    // 所属会话（刷新后由数据反推方案卡状态用，走查 P1-9）
}

/** 受众 / 高意向流失个体（CSV 导入或店铺拉取） */
export interface Audience {
  id?: string;        // 受众 id（画像抽屉拉消费者标签用）
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
  locale?: string;
  country?: string;
  email_status?: string; // 'email_invalid' = 退信剔除
  style?: string; // 风格品类 tech/fashion/business/outdoor
  gender?: string; // 性别 female/male/other
  age_range?: string; // 年龄段 18-24/25-34/…
  device?: string; // 设备 iPhone 15 等
  customer_segment?: string; // 客户分层 new/returning/vip
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
