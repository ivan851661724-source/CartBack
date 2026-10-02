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

/** 折扣码状态（planCard.discount.code_status）：created=已在店铺创建 / reused=沿用店内已有码 / none=未创建 */
export type CodeStatus = 'created' | 'reused' | 'none';

/** 新契约 planCard.discount 对象（旧数据该键可能是纯字符串 → 读取处需 typeof 兼容） */
export interface PlanCardDiscount {
  text: string;
  code: string | null;
  code_status: CodeStatus;
}

/** estGmv 算式（方案卡点击展开）：people 人 × 客单 aov × 挽回率 rate% − 折扣成本 discount_cost */
export interface EstGmvFormula {
  people: number;
  aov: number;
  rate: number;           // 挽回率（百分数值，如 12 表示 12%）
  discount_cost: number;
}

/** 新契约 estGmv：source=store 店铺实数 / demo 演示数据 */
export interface PlanCardEstGmv {
  amount: number;
  currency: string;       // 'USD'
  formula?: EstGmvFormula;
  source?: 'store' | 'demo';
}

/** 发送前核对单闸门（恒 5 项，服务端 confirm 下发 / send 409 刷新） */
export type ChecklistGate = 'window' | 'frequency' | 'whitelabel' | 'unsubscribe' | 'amount_code';

export interface ChecklistItem {
  gate: ChecklistGate | string;
  label: string;          // 中文
  pass: boolean;
  reason?: string;        // 未过原因（中文，红字展示）
}

/** 对照组（holdout）：frozen=false 时以 note 说明不设组原因 */
export interface Holdout {
  frozen: boolean;
  count: number;
  ratio?: number;         // 冻结比例（0.1 或 10 均按 10% 展示）
  note?: string;
}

/** 发送前核对单（confirm 200 下发；send 闸门 409 时服务端兜底返回最新值） */
export interface Checklist {
  items: ChecklistItem[]; // 恒 5 项
  all_pass: boolean;
  holdout?: Holdout | null;
}

/**
 * 方案卡（新契约 Wave2）：confirm 接口 200 下发，draft_id 指向后端已建草稿（发送直接复用）。
 * pain 键已删除，流失原因语义并入 reason。旧契约遗留字段保留为可选（过渡期旧后端
 * done 帧 / 历史会话仍可能下发，读取处需判空；discount 新旧形态不同，读取处需 typeof 兼容）。
 */
export interface PlanCard {
  // —— 新契约 ——
  draft_id?: string;                // confirm 时后端已建草稿，发送直接 POST /api/draft/:id/send
  audience?: string;
  reach_count?: number;
  reason?: string;                  // 流失原因（替代旧 pain）
  discount?: PlanCardDiscount;
  estGmv?: PlanCardEstGmv;
  signature?: string;
  unsubscribe_ok?: boolean;
  send_window?: string;
  language?: string;
  inferred_slots?: string[];
  // —— 旧契约遗留（新代码勿依赖） ——
  goal?: string;
  offer?: string;
  subject?: string;
  body?: string;
  sendTiming?: string;
  matchedCount?: number;
  coupon?: string;
  locale?: string;
}

/**
 * 批次域（Wave3，PRD：批次的管理动作全部在对话里完成，列表页只读展示）。
 * 数据源：GET /api/state 顶层 campaigns / blackout / global_paused；管理动作经对话消息驱动，
 * 后端处理完成后由下一轮 loadState 刷新（前端除暂停/恢复快捷按钮发消息外，不调批次管理 API）。
 */

/** 批次六态：草稿灰 / 排队蓝 / 发送中绿 / 已暂停橙 / 已完成黑 / 已冻结红 */
export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'done' | 'frozen';

/** 一个发送批次（与 act 关联：campaign.act_id === act.id 时在对话流并列展示） */
export interface Campaign {
  id: string;
  act_id: string;
  name: string;            // 如 "A 加购未付"（快捷按钮取首词拼「A 批次暂停」消息）
  audience_desc: string;   // 人群一句话
  status: CampaignStatus;
  discount: { text: string; code: string | null; code_status: CodeStatus };
  reach_count: number;     // 预计触达
  sent_count: number;      // 已发
  pending_count: number;   // 未发
  holdout_count: number;   // 对照组冻结
  excluded: Array<{ reason: string; count: number }>;   // 自动排除摘要（已下单/退信等）
  stats: { opened: number; clicked: number; recovered: number; net: number };
  scheduled_at?: string | number;
  resume_note?: string;    // 顺延/恢复说明（如「黑五已过，已恢复排程」）
  created_at?: string | number;
}

/** 停发日历（blackout）：active=有区间命中当前；ranges 为全部区间（label 如「黑五」） */
export interface BlackoutRange { from: string; to: string; label: string }

export interface Blackout {
  active: boolean;
  ranges: BlackoutRange[];
}

/** done 帧 batches：agent 提出的建批方案（待用户确认，尚未真正创建）。
 * 与 chips 同生命周期：随下一条用户消息 / 切会话清空；确认后由 /api/state 的 campaigns 承接。 */
export interface BatchPreview {
  name: string;
  audience_desc: string;
  offer_text: string;
  reach_count: number;
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
  code_status?: string;    // 新契约：折扣码状态（created/reused/none/failed；方案卡以 planCard.discount 为准）
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
  currency?: string;   // estGmv 币种（新契约 'USD'；缺省按 ¥ 展示，SentBanner 用）
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
