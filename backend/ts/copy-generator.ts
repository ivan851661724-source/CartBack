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
  if (user.style_preference) userExtras.push(`style preference: ${user.style_preference}`);
  const extrasStr = userExtras.length ? `, ${userExtras.join(', ')}` : '';
  let toneHint = '';
  if (userExtras.length) {
    toneHint =
      '5. Adapt tone to the shopper tags: ' +
      'price sensitivity high → lead with savings/deal urgency; low → lead with quality/exclusivity; mid → balanced; ' +
      'new customer → welcoming; returning → "glad to have you back"; VIP → exclusive VIP offer.\n' +
      '6. If style preference is given, pick the content angle accordingly: ' +
      'tech → performance & specs; fashion → style & pairing; business → efficiency & professionalism; ' +
      'outdoor → durability & adventure. Angle only — never invent new facts.\n';
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
  const existing = opts.existing ?? null;

  const hasDeepseek = Boolean(config.deepseek && config.deepseek.api_key);
  const hasMinimax = Boolean(config.minimax && config.minimax.api_key);
  const hasAI = hasDeepseek || hasMinimax;

  // 透传 Agent 已写好的文案（IGDE 规则模板）——仅作「无 AI key」或「LLM 失败」时的兜底
  const passthrough = (): CopyResult | null => {
    if (!existing) return null;
    const subj = String(existing.subject ?? '').trim();
    const body = String(existing.body ?? '').trim();
    if (!subj || !body) return null;
    return {
      subject: subj, body, user_id: user.user_id, email: user.email,
      discount: user.discount, regenerated: false, provider: 'igde_pass_through',
    };
  };

  // 无 AI key：透传 Agent 文案，再不行用 fallback 模板（生产降级路径）
  if (!hasAI) {
    return passthrough() || fallbackCopy(user);
  }

  // 有 AI key：默认走专门文案 LLM（与本地 email-automation 一致）。
  // 此前的「省 token 透传快速路径」已弃用——IGDE 规则模板文案质量明显低于 LLM copywriter，
  // 且与设计稿/本地测得的转化文案不一致。forceRegenerate 现无实际作用，保留参数仅为兼容。
  try {
    if (hasDeepseek) return await callProvider('deepseek', config, user, maxRetries);
    return await callProvider('minimax', config, user, maxRetries);
  } catch (e) {
    console.error(`[copy] LLM 调用失败，降级透传 Agent 文案: ${(e as Error).message}`);
    return passthrough() || fallbackCopy(user);
  }
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

// preferred_language / locale → 人群族裔描述（中文简短）。兼容全称(English)与 locale 码(en/en-US)
const ETHNICITY_BY_LANG: Record<string, string> = {
  english: '白人', en: '白人', 'en-us': '白人', 'en-gb': '白人', 'en-au': '白人', 'en-ca': '白人',
  spanish: '西语裔', es: '西语裔', 'es-es': '西语裔', 'es-mx': '西语裔',
  german: '德裔', de: '德裔', 'de-de': '德裔',
  french: '法裔', fr: '法裔', 'fr-fr': '法裔', 'fr-ca': '法裔',
  italian: '意裔', it: '意裔', 'it-it': '意裔',
};
// 解析族裔：优先全称/locale 码精确命中，再取主语言子串兜底（preferred_language 此前恒空 → 族裔恒空，现已由 fromPlanCard 从 language 标签回填）
function resolveEthnicity(lang: string): string {
  const k = (lang || '').toLowerCase().trim();
  if (!k) return '';
  if (ETHNICITY_BY_LANG[k]) return ETHNICITY_BY_LANG[k];
  const main = k.split(/[-_]/)[0];
  return ETHNICITY_BY_LANG[main] || '';
}

// 风格品类标签 → 背景质感加味（不覆盖年龄性别风格表，只追加；与文案角度指令同口径）
const STYLE_FLAVOR_BY_PREFERENCE: Record<string, string> = {
  tech: '科技感',
  fashion: '时尚杂志感',
  business: '商务质感',
  outdoor: '户外自然光',
};

// price_sensitivity 标签 → 视觉氛围加味（价格敏感人群突出折扣紧迫感，premium 突出轻奢）
const PRICE_FLAVOR: Record<string, string> = {
  high: '突出折扣优惠的促销紧迫感',
  value: '突出折扣优惠的促销紧迫感',
  premium: '高级轻奢质感',
  low: '高级轻奢质感',
};
// customer_segment 标签 → 关系氛围加味
const SEGMENT_FLAVOR: Record<string, string> = {
  new: '亲切欢迎氛围',
  returning: '老友重逢氛围',
  vip: '专属尊享感',
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
  // 受众风格品类标签（来自 tag_distribution 代表值）→ 质感加味
  const flavor = STYLE_FLAVOR_BY_PREFERENCE[(user.style_preference || '').trim().toLowerCase()] || '';

  const ageNum = representativeAge(age);
  // 族裔：preferred_language（fromPlanCard 已从 language 标签回填）→ 兜底 locale，避免恒空
  const ethnicity = resolveEthnicity(user.preferred_language || user.locale);
  const genderWord = gender === 'F' ? '女性' : gender === 'M' ? '男性' : '';
  const demographic = `${ageNum}岁${ethnicity}${genderWord}`;

  const product = (user.product_cn || user.product_en || user.product || '手机壳').trim();
  const device = (user.device || 'iPhone').trim();

  // price_sensitivity / customer_segment 标签 → 视觉氛围加味（此前仅文案用，图片 prompt 未消费）
  const priceFlavor = PRICE_FLAVOR[(user.price_sensitivity || '').trim().toLowerCase()] || '';
  const segFlavor = SEGMENT_FLAVOR[(user.customer_segment || '').trim().toLowerCase()] || '';

  let discountPct = 10;
  const d = Number(user.discount);
  if (!Number.isNaN(d)) discountPct = Math.trunc(d);
  const cta = (config.marketing.cta_button || 'Shop Now').toUpperCase().trim();

  const extraFlavors = [flavor, priceFlavor, segFlavor].filter(Boolean).join('，');
  return `${demographic}手持${device}${product}的电商广告图，${style}${extraFlavors ? `，${extraFlavors}` : ''}，手持特写浅景深，底部渲染${discountPct}% OFF和${cta}文字，真实摄影，高级感，8k`;
}
