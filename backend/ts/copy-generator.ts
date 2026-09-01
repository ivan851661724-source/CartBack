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
  const body =
    `Hi there,\n\n` +
    `We noticed you left some items from ${user.brand} in your cart. ` +
    `Good news — we're giving you ${pct}% OFF to welcome you back.\n\n` +
    `Use this chance today before it expires.\n\n` +
    `Tap the button below to pick up where you left off.\n\n` +
    `See you soon,\nThe ${user.brand} Team`;
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
    `2. Email body (friendly but urgent tone, ${formatG(user.discount)}% off as main hook, include a clear CTA phrase like "Shop Now", localized to the write-in language)\n` +
    '3. Keep it concise and conversion-focused (3-6 short paragraphs max)\n' +
    `4. Write the entire email (subject + body + CTA) in ${writeIn}\n` +
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
      max_tokens: 1000,
      temperature: 0.8,
    };
  } else {
    const base = config.minimax.base_url.replace(/\/$/, '');
    url = `${base}/chat/completions`;
    headers = { Authorization: `Bearer ${config.minimax.api_key}`, 'Content-Type': 'application/json' };
    payload = {
      model: config.minimax.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
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

const STYLE_BY_AGE_GENDER: Record<string, string> = {
  '18-24|F':
    'Instagram-style aesthetic, soft solid pastel gradient (blush pink / lavender / peach), diverse young female hand holding the phone case close to camera, trendy cafe / dorm scene softly blurred as background bokeh, bright natural lighting, vibrant',
  '18-24|M':
    'Instagram-style vivid gradient (teal / sunset orange), adventurous young male hand holding the phone case close to camera, outdoor landscape (beach / trail) softly blurred as background bokeh, sunlit, social-media trend',
  '25-34|M':
    'clean minimal luxury, dark charcoal with warm gold accents, suited male hand holding the phone case close to camera, modern office desk softly blurred as background bokeh, European elegance',
  '25-34|F':
    'modern chic, soft neutral gradient, elegant female hand holding the phone case close to camera, boutique / studio scene softly blurred as background bokeh, soft studio lighting, sophisticated',
  '35-44|M':
    'rugged industrial aesthetic, dark gunmetal / matte black, masculine hand holding the phone case close to camera, workshop / gear scene softly blurred as background bokeh, dramatic lighting',
  '35-44|F':
    'modern professional, clean neutral tones, confident female hand holding the phone case close to camera, office scene softly blurred as background bokeh, soft studio lighting',
  '45-54|F':
    'natural lifestyle, warm earthy tones, mature female hand holding the phone case close to camera, cozy home / kitchen scene softly blurred as background bokeh, soft daylight, inviting',
  '45-54|M':
    'classic premium, warm wood and leather tones, distinguished mature male hand holding the phone case close to camera, study / library scene softly blurred as background bokeh, refined',
};

const LANG_MODEL: Record<string, string> = {
  spanish: 'Hispanic / Latino model, warm vibrant Latin cultural aesthetic',
  german: 'European model, clean Bauhaus-inspired minimalism, precise',
  french: 'French-style elegance, romantic soft tones, chic',
  italian: 'Mediterranean warmth, passionate, Italian design flair',
  english: 'diverse multicultural model, modern Western market',
};

function buildImageStyle(user: UserRecord): string {
  const parts: string[] = [];
  const age = user.age_range || '25-34';
  const gender = (user.gender || 'O').toUpperCase();
  let core = STYLE_BY_AGE_GENDER[`${age}|${gender}`];
  if (!core) {
    if (gender === 'F') core = 'clean modern, soft gradient, elegant female lifestyle, bright natural lighting';
    else if (gender === 'M') core = 'clean modern, dark gradient, masculine product photography, dramatic lighting';
    else core = 'clean modern e-commerce style, neutral gradient, product-focused';
  }
  parts.push(core);

  const ps = (user.price_sensitivity || '').toLowerCase();
  if (ps === 'value') parts.push('bright cheerful approachable, colorful, deal-friendly savings vibe');
  else if (ps === 'premium') parts.push('luxury high-end, dark elegant, gold / platinum accents, exclusive');
  else if (ps === 'standard') parts.push('balanced practical, clean and honest, real-world usage');

  const seg = (user.customer_segment || '').toLowerCase();
  if (seg === 'new') parts.push('fresh welcoming, bright inviting');
  else if (seg === 'returning') parts.push('warm familiar, appreciation and loyalty feel');
  else if (seg === 'vip') parts.push('ultra-exclusive VIP, black and gold, opulent prestige');

  const lang = (user.preferred_language || '').toLowerCase();
  const modelHint = LANG_MODEL[lang];
  if (modelHint && (core.includes('hand') || core.includes('model'))) parts.push(modelHint);

  return parts.join('; ');
}

export function generateImagePrompt(user: UserRecord, config: Config): string {
  let style = buildImageStyle(user);
  const override = (config.marketing.image_style || '').trim();
  if (override && override.toLowerCase() !== 'tech') style = override;

  let discountPct = 10;
  const d = Number(user.discount);
  if (!Number.isNaN(d)) discountPct = Math.trunc(d);
  const cta = (config.marketing.cta_button || 'Shop Now').trim();
  const brand = (user.brand || 'CartBack').trim();
  const product = (user.product_en || user.product || 'premium product').trim();
  const device = (user.device || '').trim();

  let subjectDesc: string;
  if (device) {
    subjectDesc =
      `a ${product} (a phone case) fitted on a ${device} smartphone. ` +
      'The phone case itself is the single, dominant, sharply-focused hero subject ' +
      'of the image — centered, large in frame, fully visible with its texture, ' +
      'material and design details clearly readable.';
  } else {
    subjectDesc =
      `a ${product} (a phone case). The phone case itself is the single, dominant, ` +
      'sharply-focused hero subject of the image — centered, large in frame, fully ' +
      'visible with its texture, material and design details clearly readable.';
  }

  const age = (user.age_range || '25-34').trim();
  let ageLo = 25;
  const am = age.match(/\s*(\d+)/);
  if (am) ageLo = parseInt(am[1], 10);
  const seniorUsers = ageLo >= 55;

  const darkBg = ['dark', 'gunmetal', 'charcoal', 'matte black', 'black and gold'].some((w) =>
    style.toLowerCase().includes(w),
  );
  const lightHint = darkBg ? 'dramatic studio lighting with rim light' : 'bright natural lighting';

  let textHint: string;
  if (seniorUsers) {
    if (darkBg) {
      textHint =
        'high-contrast white text over a soft pale gradient band or translucent light strip behind each line for mature-reader legibility; keep strips thin and subtle';
    } else {
      textHint =
        'high-contrast text (dark on a soft light band, or white on a soft gradient band) to ensure legibility for mature readers; keep bands thin and low-opacity';
    }
  } else {
    if (darkBg) {
      textHint =
        'high-contrast white text placed directly on the dark blurred background with a subtle drop shadow only if needed; NO solid box, NO gradient band, NO banner strip, NO light strip behind any lettering';
    } else {
      textHint =
        'high-contrast text placed directly on the blurred background with a subtle drop shadow only if needed; NO solid box, NO gradient band, NO banner strip behind any lettering';
    }
  }

  let textArea: string;
  if (seniorUsers) {
    textArea =
      'Marketing text in the lower area over a subtle, low-opacity gradient band for senior-readability legibility — keep the band thin and non-intrusive so the phone case remains the hero. ';
  } else {
    textArea =
      'Marketing text sits cleanly in the lower area directly on the blurred background — NO banners, NO solid boxes, NO gradient bands, NO cards, NO strips behind any text; text floats freely with drop shadow only. ';
  }

  return (
    '海外电商邮件营销广告图。 ' +
    `Subject: ${subjectDesc} ` +
    `Style: ${style}. ` +
    'Composition: premium e-commerce marketing hero banner. CRITICAL FRAMING: ' +
    'extreme close-up shot, the phone case is held in a hand and fills 60-70% of the frame, ' +
    'centered in the upper area, sharply in focus. Shallow depth of field (f/1.8), ' +
    'background heavily blurred into soft bokeh so the scene/model stays secondary and ' +
    'never competes with the phone case. The phone case is the unmistakable hero. ' +
    `${textArea}` +
    'Render these English texts accurately and crisply into the image: ' +
    `a large bold discount badge reading "${discountPct}% OFF", ` +
    `a rounded CTA button labeled "${cta}", ` +
    `and the brand name "${brand}". ` +
    `Typography: clean modern sans-serif, ${textHint}, ` +
    'perfect spelling, no gibberish, no extra or duplicated characters, no Chinese characters. ' +
    `Lighting: ${lightHint}. ` +
    'High quality, photorealistic, 8k.'
  );
}
