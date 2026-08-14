/**
 * CartBack v3 前端 API 封装 —— 1:1 移植自 app.js 的 api() + sendMsg 的 SSE reader。
 *
 * 拓扑：同源经 Next.js rewrites 反代到后端 /api/*（cookie 自动携带，鉴权零改动）。
 *  - api()：fetch + credentials:'same-origin' + x-local-token 兼容头；403 抛错。
 *  - streamMessage()：/api/act/:id/message/stream 的 SSE 打字机，降级由调用方处理。
 *
 * React 文本默认转义，来自后端/LLM/CSV 的字符串直接 {value}，无需 esc()。
 */
import type { Act, PlanCard, Stage, Needs } from './types';

/** 本地令牌（bootstrap 下发；与 cb_session cookie 并存，cookie 优先鉴权） */
let authToken: string | null = null;
export function setToken(t: string | null) {
  authToken = t;
}
export function getToken(): string | null {
  return authToken;
}

/** 统一 JSON 请求；403 → 抛出（本地令牌不匹配） */
export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (authToken) headers['x-local-token'] = authToken;
  // 同源显式带 cookie：登录后自动携带 cb_session（session 优先鉴权）
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 403) throw new Error('鉴权失败（本地令牌不匹配）');
  return res.json() as Promise<T>;
}

/** SSE 流式 done 帧的 payload（与后端 finalize 结构一致） */
export interface StreamDone {
  reply: string;
  stage: Stage;
  needs: Needs;
  planCard?: PlanCard | null;
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

  // 60s 超时（与 app.js 一致），可与外部 signal 合并
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
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
        } else if (data.type === 'done') {
          clearTimeout(timer);
          return data.result as StreamDone;
        }
      }
    }
    clearTimeout(timer);
    if (!full) throw new Error('空流');
    // 流式降级：服务端未发 done 帧，但有 token 文本 → 用累计全文构造结果
    return { reply: full, stage: 'S0' as Stage, needs: {} as Needs, planCard: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 构造一个新 act（可带 preset 预选受众） */
export async function createAct(preset?: { audience?: string }): Promise<Act> {
  return api<Act & { act?: Act }>('/api/act', {
    method: 'POST',
    body: JSON.stringify(preset ? { preset } : {}),
  }).then((r: any) => r.act ?? r);
}
