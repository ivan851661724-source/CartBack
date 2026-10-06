/**
 * CartBack v3 前端 API 封装 —— 1:1 移植自 app.js 的 api() + sendMsg 的 SSE reader。
 *
 * 拓扑：同源经 Next.js rewrites 反代到后端 /api/*（cookie 自动携带，鉴权零改动）。
 *  - api()：fetch + credentials:'same-origin' + x-local-token 兼容头；403 抛错。
 *  - streamMessage()：/api/act/:id/message/stream 的 SSE 打字机，降级由调用方处理。
 *
 * React 文本默认转义，来自后端/LLM/CSV 的字符串直接 {value}，无需 esc()。
 */
import type { Act, BatchPreview, Chips, Checklist, Engine, PlanCard, Stage, Needs, StoreBanner } from './types';

/** 本地令牌（bootstrap 下发；与 cb_session cookie 并存，cookie 优先鉴权） */
let authToken: string | null = null;
export function setToken(t: string | null) {
  authToken = t;
}
export function getToken(): string | null {
  return authToken;
}

/** 401/403 = 未登录/本地令牌不匹配 —— 不是故障，调用方据此引导注册登录，而不是报错（走查 P0-1） */
export class ApiAuthError extends Error {
  constructor(message = '请先注册或登录') {
    super(message);
    this.name = 'ApiAuthError';
  }
}

/** 统一 JSON 请求；401/403 抛 ApiAuthError。创建等调用可要求其他 HTTP 错误也抛出，其余调用保留响应体处理。 */
export async function api<T = any>(path: string, opts: RequestInit = {}, rejectHttpErrors = false): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (authToken) headers['x-local-token'] = authToken;
  // 同源显式带 cookie：登录后自动携带 cb_session（session 优先鉴权）
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401 || res.status === 403) throw new ApiAuthError();
  const data = await res.json();
  if (rejectHttpErrors && !res.ok) throw new Error(data?.error || data?.reason || `请求失败（${res.status}）`);
  return data as T;
}

/** Risk text comes from the server for this exact business revision. */
export async function sendWithApproval<T>(draftId: string, payload: Record<string, unknown>): Promise<T> {
  const path = `/api/draft/${draftId}/send`;
  let result = await api<any>(path, { method: 'POST', body: JSON.stringify(payload) });
  if (result.requires_risk_confirmation && window.confirm(result.error + '\n确认承担该风险并发送？')) {
    result = await api<any>(path, { method: 'POST', body: JSON.stringify({ ...payload, acknowledge_risk: true }) });
  }
  return result as T;
}

export function sendFailureReason(reply: { error?: string; ok?: boolean; checklist?: Checklist }): string | null {
  if (reply.error) return reply.error;
  if (reply.ok === false) {
    const reasons = reply.checklist?.items.filter(i => !i.pass && i.blocking !== false && i.gate !== 'unsubscribe').map(i => i.reason || i.label).join('；');
    return reasons ? '发送未通过核对单：' + reasons : '发送未通过核对单，请检查发送条件';
  }
  return null;
}

/** 轮询等待结束不代表发送失败，任务仍由服务端队列继续执行。 */
export async function pollSendJob(jobId: string, timeoutMs = 120000): Promise<{ ok: boolean; pending?: boolean; result?: any; error?: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const j = await api<{ status: string; result?: any; error?: string; run_after?: number }>(`/api/jobs/${jobId}`);
      if (j.status === 'done') {
        if (j.result?.error) return { ok: false, error: j.result.error };
        if (j.result?.deferred || j.result?.rescheduled || j.result?.skipped === 'global_paused') return { ok: true, pending: true };
        if (j.result?.skipped && j.result.skipped !== 'already sent') return { ok: false, error: '发送任务未执行：' + j.result.skipped };
        return { ok: true, result: j.result };
      }
      if (j.status === 'failed') return { ok: false, error: j.error || '任务执行失败' };
      if (j.run_after && j.run_after > Date.now()) return { ok: true, pending: true };
    } catch { /* 网络抖动继续轮询 */ }
    await new Promise(r => setTimeout(r, 900));
  }
  return { ok: true, pending: true };
}

/** SSE 流式 done 帧的 payload（与后端 finalize 结构一致） */
export interface StreamDone {
  act?: Act;
  reply: string;
  stage: Stage;
  needs: Needs;
  planCard?: PlanCard | null;
  engine?: Engine;   // 引擎健康态（旧 done 帧无此字段 → undefined，由调用方保持现值）
  chips?: Chips;     // 回复快捷 chips，针对最新一条 agent 回复；[] 或缺省 = 无 chips
  askedSlot?: string | null;  // B4 本轮实际追问的槽位（与 chips 同源）；goal 槽 chips 需要输入框复合形态（C4）
  batches?: BatchPreview[];  // Wave3：agent 提出的建批方案（待确认，尚未创建）；缺省 = 本轮无待确认批次
}

/**
 * 流式发送消息：读 /api/act/:id/message/stream 的 SSE。
 * @param onToken 每个 token 帧触发，传入目前为止累计的全文（调用方直接 setText）。
 * @returns done 帧的 result（含 reply/stage/needs/planCard）；流异常时 reject。
 */
export async function streamMessage(
  actId: string,
  message: string,
  onToken: (full: string) => void,
  signal?: AbortSignal,
): Promise<StreamDone> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['x-local-token'] = authToken;

  // 120s 超时（IGDE 一轮可含多次 LLM 调用 + critic；调用方仅在未收到任何 token 时才降级重发）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort());

  try {
    const res = await fetch(`/api/act/${actId}/message/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('stream http ' + res.status);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop()!;
      for (const p of parts) {
        const line = p.trim();
        if (!line.startsWith('data:')) continue;
        const data = JSON.parse(line.slice(5).trim());
        if (data.type === 'token') {
          full += data.value;
          onToken(full);
        } else if (data.type === 'replace') {
          // 服务端护栏/兜底替换了乐观流出的预览 → 全文重置为权威值
          full = data.value;
          onToken(full);
        } else if (data.type === 'error') {
          clearTimeout(timer);
          throw new Error(data.error || 'stream error');
        } else if (data.type === 'done') {
          clearTimeout(timer);
          return data.act?.id === actId ? { ...data.result, act: data.act } as StreamDone : data.result as StreamDone;
        }
      }
    }
    clearTimeout(timer);
    if (!full) throw new Error('空流');
    // 没有 done 就没有权威状态；调用方保留已收到的文字并重新读取会话。
    throw new Error('流式回复未完成');
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/act 的完整响应（P0-N4 复测 10-03）：chips/welcome/store_banner 与 act 同级下发，
 *  旧实现 .then(r => r.act ?? r) 把同级字段全部丢弃 → 开场白永远不带 chips（F1 出口丢失） */
export interface CreateActResult {
  act: Act;
  chips: Chips;
  welcome: boolean;
  store_banner: StoreBanner | null;
}

/** 构造一个新 act（可带 preset 预选受众）。响应含同级 chips（开场快捷选项）/ welcome（一次性欢迎语标记） */
export async function createAct(preset?: { audience?: string }): Promise<CreateActResult> {
  return api<Record<string, unknown>>('/api/act', {
    method: 'POST',
    body: JSON.stringify({ flow_version: 6, ...(preset ? { preset } : {}) }),
  }, true).then((r): CreateActResult => {
    const act = ((r && (r as { act?: Act }).act) ?? r) as Act;
    if (!act || typeof act.id !== 'string' || !act.id) throw new Error('创建会话响应无效，请重试');
    return {
      act,
      chips: Array.isArray(r?.chips) ? (r.chips as unknown[]).filter((c): c is string => typeof c === 'string') : [],
      welcome: Boolean(r?.welcome),
      store_banner: ((r?.store_banner ?? null) as StoreBanner | null) || null,
    };
  });
}

export async function saveDraftCopy(draftId: string, subject: string, body: string, version?: number) {
  const result = await api<{ ok?: boolean; draft?: import('./types').Draft; act?: Act; error?: string }>(`/api/draft/${draftId}`, {
    method: 'PUT', body: JSON.stringify({ subject, body, expected_business_version: version }),
  }, true);
  if (!result.ok || !result.draft) throw new Error(result.error || '保存邮件失败');
  return result;
}

/** POST /api/act/:id/confirm 的三种结局：ok=确认成功 / conflict=建码失败(409) / unsupported=旧后端无此接口(404) */
export type ConfirmOutcome =
  | { kind: 'ok'; act?: Act; planCard: PlanCard; checklist?: Checklist; previewOnly?: boolean }
  | { kind: 'conflict'; reason: string; options: string[]; act?: Act }
  | { kind: 'unsupported' };

/**
 * 确认卡「可以，去发」：POST /api/act/:id/confirm。
 * - 200 {ok, act, planCard, checklist, holdout}（act.stage=S3）→ ok
 * - 409 {ok:false, code_status:'failed', reason, options, act}（建码失败，不出 planCard）→ conflict
 * - 404 / 响应体不可解析（旧后端未部署此接口）→ unsupported（调用方回退预建草稿旧路径）
 * 其余状态（新后端在但异常）抛错，由调用方 toast——不盲目回退旧路径造成双重草稿。
 */
export async function confirmAct(actId: string, body?: Record<string, unknown>): Promise<ConfirmOutcome> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['x-local-token'] = authToken;
  let res: Response;
  try {
    res = await fetch(`/api/act/${actId}/${body?.id ? 'action' : 'confirm'}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('确认请求中断，请刷新方案后重试');
  }
  if (res.status === 401 || res.status === 403) throw new ApiAuthError();
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.ok && data && data.ok && data.planCard) {
    return { kind: 'ok', act: data.act, planCard: data.planCard as PlanCard, checklist: data.checklist as Checklist | undefined, previewOnly: data.preview_only === true };
  }
  if (res.status === 409 && data) {
    if (data.code_status !== 'failed') throw new Error(data.error || data.reason || '方案状态已变化，请重新核对');
    return {
      kind: 'conflict',
      reason: typeof data.reason === 'string' ? data.reason : '折扣码创建失败',
      options: Array.isArray(data.options) ? data.options.filter((o: unknown): o is string => typeof o === 'string') : [],
      act: data.act,
    };
  }
  if (res.status === 404) return { kind: 'unsupported' };
  throw new Error((data && typeof data.error === 'string' && data.error) || `确认失败（HTTP ${res.status}）`);
}

/** GET /api/act/:id/checklist 的结果：ok=现算核对单 / refused=会话归档或方案不在可发送形态 */
export type ChecklistOutcome =
  | { kind: 'ok'; checklist: Checklist; holdout?: Checklist['holdout'] }
  | { kind: 'refused'; reason: string }
  | { kind: 'unsupported' };

/**
 * 刷新恢复（复测 10-06 P2）：已准备方案卡的核对单现算拉取（只读，不产生副作用）。
 * - 200 {ok, checklist, holdout} → ok（核对单绑定当前业务状态，按钮据此禁用/放行）
 * - 409（会话已归档 / 无已准备方案）→ refused（前端保持发送按钮禁用）
 * - 404 / 响应体不可解析（旧后端）→ unsupported（调用方维持无核对单禁用态）
 */
export async function fetchActChecklist(actId: string): Promise<ChecklistOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/act/${actId}/checklist`, {
      method: 'GET',
      headers: authToken ? { 'x-local-token': authToken } : undefined,
      credentials: 'same-origin',
    });
  } catch {
    return { kind: 'refused', reason: '网络异常，暂时无法核对发送条件' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'refused', reason: '请先登录' };
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.ok && data && data.ok && data.checklist && Array.isArray(data.checklist.items)) {
    return { kind: 'ok', checklist: data.checklist as Checklist, holdout: data.holdout };
  }
  if (res.status === 404) return { kind: 'unsupported' };
  return { kind: 'refused', reason: (data && typeof data.error === 'string' && data.error) || '发送条件核对失败' };
}
