/**
 * LLM 文案生成模块 — DeepSeek（主用，OpenAI 兼容）+ MiniMax（备用）
 *
 * 端口自 Python emailgen/copy_generator.py：
 *  - 默认采纳 Node 端 IGDE Agent 已产出的 subject+body（省 Token）
 *  - 仅 force_regenerate=True 或原文缺失时才真正调 LLM
 *  - 同时包含图片 prompt 构建器 generate_image_prompt（年龄/性别/价格/分层/语言差异化风格）
 */

import type { Config } from './config';
import type { UserRecord } from './data-loader';

export interface CopyResult {
  subject: string;
  body: string;
  user_id: string;
  email: string;
  discount: number;
  regenerated: boolean;
  provider: string;
  [k: string]: unknown;
}

interface ExistingCopy {
  subject?: string;
  body?: string;
}

/** Python f"{x:g}" 的近似：整数无小数、其余去尾零 */
function formatG(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(6)));
}

export function fallbackCopy(user: UserRecord): CopyResult {
  const pct = Number.isInteger(user.discount) ? user.discount : user.discount;
  const subject = `Your ${pct}% OFF Is Waiting — Don't Miss Out, ${user.brand}`;
  // 落款与「点击图片下单」提示由模板在图片后追加，body 只放开头+主体
  const body =
    `Hi there,\n\n` +
    `We noticed you left some items from ${user.brand} in your cart. ` +
    `Good news — we're giving you ${pct}% OFF to welcome you back.\n\n` +
    `Use this chance today before it expires.`;
  return {
    subject,
    body,
    user_id: user.user_id,
    email: user.email,
    discount: user.discount,
    regenerated: false,
    provider: 'fallback_template',
  };
}

export function buildPrompt(user: UserRecord): string {
  const genderMap: Record<string, string> = { M: 'male', F: 'female', O: 'other' };
  const genderDesc = genderMap[user.gender] || 'other';

  let writeIn: string;
  if (user.preferred_language) {
    writeIn = user.preferred_language;
  } else {
    const localeShort = (user.locale || 'en').toLowerCase().slice(0, 2);
    writeIn = ['en', 'in', 'de', 'fr', 'es', 'it', 'pt'].includes(localeShort)
      ? 'English'
      : localeShort === 'zh'
        ? 'Simplified Chinese'
        : 'English';
  }

  const userExtras: string[] = [];
  if (user.price_sensitivity) userExtras.push(`price sensitivity: ${user.price_sensitivity}`);
  if (user.customer_segment) userExtras.push(`customer segment: ${user.customer_segment}`);
  const extrasStr = userExtras.length ? `, ${userExtras.join(', ')}` : '';
  let toneHint = '';
  if (userExtras.length) {
    toneHint =
      '5. Adapt tone to the shopper tags: ' +
      'value-sensitive → lead with savings/deal urgency; premium → lead with quality/exclusivity; ' +
      'new customer → welcoming; returning → "glad to have you back"; VIP → exclusive VIP offer.\n';
  }

  const productLine = `PRODUCT: ${user.product_en || user.product || 'premium product'}${user.product_cn ? ` (${user.product_cn})` : ''}`;

  return (
    'You are an expert e-commerce email copywriter. Write a recovery email for an abandoned cart.\n\n' +
    `BRAND: ${user.brand}\n` +
    `TARGET USER: ${genderDesc}, age ${user.age_range}, ${user.device} user${extrasStr}\n` +
    `${productLine}\n` +
    `DISCOUNT: ${formatG(user.discount)}% OFF\n` +
    `GOAL: ${user.goal || 'abandonment_recovery'}\n` +
    `LOCALE: ${user.locale} (market region — for currency/cultural tone, NOT for language)\n` +
    `WRITE IN: ${writeIn} (recipient's preferred language — write the ENTIRE email in this language)\n\n` +
    'REQUIREMENTS:\n' +
    '1. Email subject line (under 50 characters, urgent and compelling)\n' +
    `2. Email body: greeting + ONE short main sentence about the ${formatG(user.discount)}% off recovery offer. Keep it to 2-3 short sentences total, under 40 words. ` +
    'NO signature, NO closing, and ABSOLUTELY NO call-to-action line (do NOT write anything like "tap/click the image/button", "shop now", "reclaim", "grab" — the click-to-order prompt and signature are added by the template separately). Just the greeting and the offer.\n' +
    '3. Keep it concise and conversion-focused\n' +
    `4. Write the entire email (subject + body) in ${writeIn}\n` +
    toneHint +
    '\nIMPORTANT: Output JSON only. No explanations, no thinking, no markdown. Just the raw JSON object.\n\n' +
    'OUTPUT FORMAT (JSON):\n{"subject": "...", "body": "..."}'
  );
}

function escapeCtrl(ch: string): string {
  if (ch === '\n') return '\\n';
  if (ch === '\r') return '\\r';
  if (ch === '\t') return '\\t';
  return '';
}

export function extractJson(content: string): { subject: string; body: string } {
  let jsonStr: string;
  const m = content.match(/\{[\s\S]*?"subject"[\s\S]*?"body"[\s\S]*?\}/);
  if (m) {
    jsonStr = m[0];
  } else {
    const first = content.indexOf('{');
    const last = content.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      jsonStr = content.slice(first, last + 1);
    } else {
      throw new Error(`响应中找不到 JSON，内容前 200 字: ${JSON.stringify(content.slice(0, 200))}`);
    }
  }
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    jsonStr = jsonStr.replace(/[\x00-\x1f]/g, escapeCtrl);
    obj = JSON.parse(jsonStr);
  }
  if (typeof obj !== 'object' || obj === null) throw new Error(`解析结果不是 dict: ${typeof obj}`);
  const rec = obj as Record<string, unknown>;
  return { subject: String(rec.subject ?? '').trim(), body: String(rec.body ?? '').trim() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callProvider(
  name: 'deepseek' | 'minimax',
  config: Config,
  user: UserRecord,
  maxRetries: number,
): Promise<CopyResult> {
  const prompt = buildPrompt(user);
  let url: string;
  let headers: Record<string, string>;
  let payload: Record<string, unknown>;

  if (name === 'deepseek') {
    if (!config.deepseek) throw new Error('deepseek 未配置');
    const base = config.deepseek.base_url.replace(/\/$/, '');
    url = `${base}/chat/completions`;
    headers = { Authorization: `Bearer ${config.deepseek.api_key}`, 'Content-Type': 'application/json' };
    payload = {
      model: config.deepseek.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.8,
      // 阿里 qwen3 系列关推理：直接出答案，避免推理耗时长导致 /api/draft 超时（非 qwen 模型该参数被忽略）
      enable_thinking: false,
    };
  } else {
    const base = config.minimax.base_url.replace(/\/$/, '');
    url = `${base}/chat/completions`;
    headers = { Authorization: `Bearer ${config.minimax.api_key}`, 'Content-Type': 'application/json' };
    payload = {
      model: config.minimax.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.8,
    };
  }

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchWithTimeout(
        url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        60000,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const result = (await resp.json()) as Record<string, unknown>;
      const out = (result.output || {}) as Record<string, unknown>;
      const choices = (out.choices || result.choices || []) as unknown[];
      if (!choices.length) throw new Error(`响应无 choices: ${JSON.stringify(result).slice(0, 200)}`);
      const choice = choices[0] as Record<string, unknown>;
      const msg = (choice.message || {}) as Record<string, unknown>;
      let content = String(msg.content ?? '').trim();
      // 推理模型（deepseek-v4-pro 等）偶发 content 为空，最终答案在 reasoning_content 里
      if (!content) {
        const rc = String(msg.reasoning_content ?? '').trim();
        if (rc) content = rc;
      }
      if (name === 'minimax') {
        content = content.replace(/ thinking[\s\S]*? response/g, '').trim() || content;
      }
      const copyData = extractJson(content);
      return {
        subject: copyData.subject,
        body: copyData.body,
        user_id: user.user_id,
        email: user.email,
        discount: user.discount,
        regenerated: true,
        provider: name,
      };
    } catch (e) {
      lastErr = e as Error;
      console.error(`[copy:${name}] 第 ${attempt}/${maxRetries} 次失败: ${(e as Error).message}`);
      if (attempt < maxRetries) await sleep(3000);
    }
  }
  throw lastErr || new Error('unknown copy error');
}

export async function generateCopy(
  config: Config,
  user: UserRecord,
  opts: { maxRetries?: number; forceRegenerate?: boolean; existing?: ExistingCopy | null } = {},
): Promise<CopyResult> {
  const maxRetries = opts.maxRetries ?? 2;
  const forceRegenerate = opts.forceRegenerate ?? false;
  const existing = opts.existing ?? null;

  // 快速路径：Agent 已写好，直接用
  if (!forceRegenerate && existing) {
    const subj = String(existing.subject ?? '').trim();
    const body = String(existing.body ?? '').trim();
    if (subj && body) {
      return {
        subject: subj,
        body,
        user_id: user.user_id,
        email: user.email,
        discount: user.discount,
        regenerated: false,
        provider: 'igde_pass_through',
      };
    }
  }

  if (config.deepseek && config.deepseek.api_key) {
    return callProvider('deepseek', config, user, maxRetries);
  }
  if (config.minimax.api_key) {
    return callProvider('minimax', config, user, maxRetries);
  }
  return fallbackCopy(user);
}

// ---------------------------------------------------------------------------
// 图片 Prompt 生成
// ---------------------------------------------------------------------------

// 简短中文风格表（年龄+性别 → 一句风格/背景描述）。用户反馈：短自然语言 prompt 效果优于长英文约束模板。
const STYLE_CN_BY_AGE_GENDER: Record<string, string> = {
  '18-24|F': 'Instagram风格柔和粉紫渐变背景',
  '18-24|M': 'Instagram风格鲜艳渐变背景',
  '25-34|M': '极简轻奢深炭金背景',
  '25-34|F': '现代柔和中性渐变背景',
  '35-44|M': '硬朗工业风暗色金属背景',
  '35-44|F': '现代职业中性背景',
  '45-54|F': '自然生活暖色背景',
  '45-54|M': '经典高级木皮质感背景',
};

// preferred_language → 人群族裔描述（中文简短）
const ETHNICITY_BY_LANG: Record<string, string> = {
  english: '白人',
  spanish: '西语裔',
  german: '德裔',
  french: '法裔',
  italian: '意裔',
};

// 取年龄区间代表值：18-24→20，25-34→30，35-44→40，45-54→50，55+→58
function representativeAge(ageRange: string): number {
  const m = ageRange.match(/\s*(\d+)/);
  if (!m) return 30;
  const lo = parseInt(m[1], 10);
  if (lo < 25) return 20;
  if (lo < 35) return 30;
  if (lo < 45) return 40;
  if (lo < 55) return 50;
  return 58;
}

/**
 * 生成简短中文自然语言图片 prompt（无约束指令模板）。
 * 结构：{人群}手持{机型}{产品}的电商广告图，{风格}，手持特写浅景深，
 *       底部渲染{折扣}% OFF和{CTA}文字，真实摄影，高级感，8k
 */
export function generateImagePrompt(user: UserRecord, config: Config): string {
  const age = (user.age_range || '25-34').trim();
  const gender = (user.gender || 'O').toUpperCase();

  let style = STYLE_CN_BY_AGE_GENDER[`${age}|${gender}`];
  if (!style) {
    style =
      gender === 'F'
        ? '现代柔和渐变背景'
        : gender === 'M'
          ? '现代暗色渐变背景'
          : '现代电商中性渐变背景';
  }
  const override = (config.marketing.image_style || '').trim();
  if (override && override.toLowerCase() !== 'tech') style = override;

  const ageNum = representativeAge(age);
  const ethnicity = ETHNICITY_BY_LANG[(user.preferred_language || '').toLowerCase()] || '';
  const genderWord = gender === 'F' ? '女性' : gender === 'M' ? '男性' : '';
  const demographic = `${ageNum}岁${ethnicity}${genderWord}`;

  const product = (user.product_cn || user.product_en || user.product || '手机壳').trim();
  const device = (user.device || 'iPhone').trim();

  let discountPct = 10;
  const d = Number(user.discount);
  if (!Number.isNaN(d)) discountPct = Math.trunc(d);
  const cta = (config.marketing.cta_button || 'Shop Now').toUpperCase().trim();

  return `${demographic}手持${device}${product}的电商广告图，${style}，手持特写浅景深，底部渲染${discountPct}% OFF和${cta}文字，真实摄影，高级感，8k`;
}
