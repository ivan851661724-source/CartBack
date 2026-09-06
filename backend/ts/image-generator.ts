/**
 * 图片生成模块 — 双轨策略
 *  1. 万相（wanx）：config.qianwen_vision 配 api_key+base_url 时调阿里万相文生图
 *  2. Pollinations 兜底：免 Key，通用图 + Pillow（→ @napi-rs/canvas）叠加折扣/CTA
 * 端口自 Python emailgen/image_generator.py。
 */
import * as fs from 'fs';
import * as path from 'path';

import type { Config } from './config';
import type { UserRecord } from './data-loader';
import { generateImagePrompt } from './copy-generator';
import { overlayMarketingText } from './image-overlay';

function extractImageUrl(data: Record<string, unknown>): string {
  const out = (data.output || {}) as Record<string, unknown>;
  const choices = (out.choices || data.choices || []) as unknown[];
  if (!choices.length) return '';
  const choice = choices[0] as Record<string, unknown>;
  const msg = (choice.message || {}) as Record<string, unknown>;
  const content = msg.content;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.image) return String(p.image);
      if (p.type === 'image_url' && p.image_url && typeof p.image_url === 'object') {
        return String((p.image_url as Record<string, unknown>).url ?? '');
      }
      if (p.url) return String(p.url);
    }
    return '';
  }

  if (typeof content === 'string') {
    const m = content.match(/\((https?:\/\/[^)]+)\)/) || content.match(/(https?:\/\/\S+)/);
    return m ? m[1] : '';
  }
  return '';
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

async function requestWanx(prompt: string, config: Config): Promise<string> {
  const q = config.qianwen_vision;
  const base = (q.base_url || '').replace(/\/$/, '');
  if (!base || !q.api_key) throw new Error('万相未配置（缺少 base_url 或 api_key）');
  const url = `${base}/chat/completions`;
  const headers = { Authorization: `Bearer ${q.api_key}`, 'Content-Type': 'application/json' };
  const payload = {
    model: q.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  const resp = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    180000,
  );
  if (resp.status !== 200) throw new Error(`万相 HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  const data = (await resp.json()) as Record<string, unknown>;
  const imageUrl = extractImageUrl(data);
  if (!imageUrl) throw new Error(`万相响应无图片 URL: ${JSON.stringify(data).slice(0, 400)}`);
  return imageUrl;
}

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function requestPollinations(discount: number, brand: string, seedSalt = ''): string {
  const prompt =
    'High-quality e-commerce marketing email hero image of a premium phone case, ' +
    'sleek modern smartphone case product photography, ' +
    'bright clean studio lighting, soft gradient background, ' +
    'professional brand aesthetic, newsletter banner style, ' +
    '8K detailed, no text overlay in the image, best quality';
  const encoded = encodeURIComponent(prompt);
  const seed =
    (Math.floor(Date.now() / 1000) + (stableHash(`${brand}_${discount}_${seedSalt}`) % 100000)) % 1000000;
  return `https://image.pollinations.ai/prompt/${encoded}?width=1200&height=1500&seed=${seed}&nologo=true`;
}

export async function downloadImage(
  imageUrl: string,
  tag: string,
  outputDir = 'output/images',
  timeout = 90,
): Promise<string> {
  const outDir = path.isAbsolute(outputDir) ? outputDir : path.resolve(process.cwd(), outputDir);
  fs.mkdirSync(outDir, { recursive: true });
  const safeTag = (tag.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'img');
  const filename = `${safeTag}_${Math.floor(Date.now() / 1000)}.png`;
  const localPath = path.join(outDir, filename);

  console.error(`[image] 下载 ${imageUrl.slice(0, 80)}…`);
  try {
    const resp = await fetchWithTimeout(imageUrl, {}, timeout * 1000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('image')) {
      const text = await resp.text();
      console.error(`[image] ⚠️ 响应不是图片 (${contentType}): ${text.slice(0, 200)}`);
      return '';
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) {
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      return '';
    }
    fs.writeFileSync(localPath, buf);
    console.error(`[image] ✅ 下载完成 (${buf.length} bytes) → ${localPath}`);
    return path.resolve(localPath);
  } catch (e) {
    console.error(`[image] 下载失败: ${(e as Error).message}`);
    try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface GenerateImageOpts {
  config: Config;
  user: UserRecord;
  productImagePath?: string | null;
  skip?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  outputDir?: string;
}

export async function generateProductImage(opts: GenerateImageOpts): Promise<string> {
  const { config, user } = opts;
  const skip = opts.skip ?? false;
  const productImagePath = opts.productImagePath ?? null;
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelay = opts.retryDelay ?? 12;
  const outputDir = opts.outputDir ?? 'output/images';

  if (skip) return '';

  // 已有本地产品图 → 直接叠加（或原样返回）
  if (productImagePath && fs.existsSync(productImagePath)) {
    if (config.marketing.overlay_text) {
      return overlayMarketingText({
        imagePath: productImagePath,
        discount: user.discount,
        brandName: user.brand,
        ctaText: config.marketing.cta_button,
        ageRange: user.age_range,
      });
    }
    return path.resolve(productImagePath);
  }

  const prompt = generateImagePrompt(user, config);
  const wanxReady = Boolean(config.qianwen_vision.api_key && config.qianwen_vision.base_url);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let imageUrl: string;
      if (wanxReady) {
        console.error(`[image] 第 ${attempt}/${maxRetries} 次，调用万相生成…`);
        imageUrl = await requestWanx(prompt, config);
      } else {
        console.error(`[image] 第 ${attempt}/${maxRetries} 次，Pollinations 兜底（overlay=true）…`);
        imageUrl = requestPollinations(user.discount, user.brand, String(attempt));
      }

      let local: string;
      if (imageUrl.startsWith('/') || imageUrl.startsWith('\\') || !imageUrl.includes('://')) {
        local = imageUrl;
      } else {
        local = await downloadImage(imageUrl, user.user_id, outputDir);
      }
      if (!local) throw new Error('图片下载为空');

      const needOverlay = !wanxReady ? true : Boolean(config.marketing.overlay_text);
      if (needOverlay) {
        const final = await overlayMarketingText({
          imagePath: local,
          discount: user.discount,
          brandName: user.brand,
          ctaText: config.marketing.cta_button,
          ageRange: user.age_range,
        });
        return final;
      }
      return path.resolve(local);
    } catch (e) {
      console.error(`[image] 第 ${attempt}/${maxRetries} 次失败: ${(e as Error).message}`);
      if (attempt < maxRetries) await sleep(retryDelay * 1000);
    }
  }
  console.error('[image] 达到最大重试次数，返回空');
  return '';
}
