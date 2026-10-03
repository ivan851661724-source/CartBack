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
import { generateImagePrompt, generateSceneEditPrompt } from './copy-generator';
import { categoryProfile } from './category-profile';
import { overlayMarketingText } from './image-overlay';

// —— @napi-rs/canvas 惰性加载（批次 3 服务端压图用；与 image-overlay 同一容错模式） ——
interface CanvasLike {
  width: number;
  height: number;
  getContext: (type: string) => { drawImage: (img: unknown, x: number, y: number, w?: number, h?: number) => void };
  toBuffer: (mime: string, quality?: number) => Buffer;
}
let canvasMod: { createCanvas: (w: number, h: number) => CanvasLike; loadImage: (src: string | Buffer) => Promise<{ width: number; height: number }> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  canvasMod = require('@napi-rs/canvas');
} catch {
  canvasMod = null;
}

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

/**
 * 批次 3 万相图生图（requestWanxEdit）——上传图场景化。
 * 验证配方（2026-10-02 实测，成败关键）：同 {base}/chat/completions 端点、模型 qwen-image-2.0-pro、
 * content 用「原生 image 键 + 图在前文在后」形态。改用 OpenAI 常规 image_url 形态：
 * 图在前报 400，文在前返回 200 但图片被静默忽略（退化为纯文生图，状态码不算数，验收以成图与输入图产品一致为准）。
 */
async function requestWanxEdit(imageDataUrl: string, prompt: string, config: Config): Promise<string> {
  const q = config.qianwen_vision;
  const base = (q.base_url || '').replace(/\/$/, '');
  if (!base || !q.api_key) throw new Error('万相未配置（缺少 base_url 或 api_key）');
  const url = `${base}/chat/completions`;
  const headers = { Authorization: `Bearer ${q.api_key}`, 'Content-Type': 'application/json' };
  const payload = {
    model: q.edit_model || 'qwen-image-2.0-pro',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', image: imageDataUrl },   // 原生 image 键（非 image_url）
        { type: 'text', text: prompt },           // 图在前、文在后
      ],
    }],
  };
  const resp = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    180000,
  );
  if (resp.status !== 200) throw new Error(`万相图生图 HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  const data = (await resp.json()) as Record<string, unknown>;
  const imageUrl = extractImageUrl(data);
  if (!imageUrl) throw new Error(`万相图生图响应无图片 URL: ${JSON.stringify(data).slice(0, 400)}`);
  return imageUrl;
}

/**
 * 服务端压图：输入图先压至 ≤1024px JPEG（130KB 实测通过），再转 data URL 供图生图。
 * canvas 不可用时原字节直读（超限风险由上限校验兜底）。
 */
async function compressToJpegDataUrl(srcPath: string, maxDim = 1024): Promise<string> {
  if (canvasMod) {
    try {
      const img = await canvasMod.loadImage(srcPath);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = canvasMod.createCanvas(w, h);
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const buf = canvas.toBuffer('image/jpeg', 0.85);
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch (e) {
      console.error(`[image] 压图失败，改用原图直读: ${(e as Error).message}`);
    }
  }
  const buf = fs.readFileSync(srcPath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Pollinations 英文兜底场景按品类档案取（旧版整句写死 premium phone case，非手机壳品类出图全错位） */
function requestPollinations(user: UserRecord, seedSalt = ''): string {
  const profile = categoryProfile(user.category);
  const product = (user.product_en || user.product || '').trim() || 'premium product';
  const prompt =
    `High-quality e-commerce marketing email hero image of ${product}, ` +
    `${profile.en_scene}, ` +
    'bright clean studio lighting, soft gradient background, ' +
    'professional brand aesthetic, newsletter banner style, ' +
    '8K detailed, no text overlay in the image, best quality';
  const encoded = encodeURIComponent(prompt);
  const seed =
    (Math.floor(Date.now() / 1000) + (stableHash(`${user.brand}_${user.discount}_${seedSalt}`) % 100000)) % 1000000;
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
  /** 编辑态「生成图片」：覆盖默认画像 prompt（为空则按受众标签画像构建） */
  promptOverride?: string | null;
}

/**
 * 产图结果：path 为本地图绝对路径（空 = 全部档位失败）；
 * method 记录实际生效档位（draft.mailgen_meta.image_method 落此值，用于线上统计图生图命中率与回退观测）：
 *   wanx-edit(+overlay)          档1 图生图（上传图场景化）
 *   upload(+overlay)             档2 原图直出/叠字
 *   wanx|pollinations            文生图（无上传图现链路）
 *   wanx|pollinations-fallback(+overlay)  文生图（上传图两档均失败后的兜底）
 */
export interface GenerateImageResult {
  path: string;
  method: string;
}

export async function generateProductImage(opts: GenerateImageOpts): Promise<GenerateImageResult> {
  const { config, user } = opts;
  const skip = opts.skip ?? false;
  const productImagePath = opts.productImagePath ?? null;
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelay = opts.retryDelay ?? 12;
  const outputDir = opts.outputDir ?? 'output/images';

  if (skip) return { path: '', method: '' };

  // —— 已有本地产品图（商家上传的商品图）：三档回退 = 图生图 → 原图叠字 → 文生图（现链路） ——
  let uploadFallback = false; // 走到文生图兜底时给 method 加 -fallback 后缀（观测档1/档2均失败的比例）
  if (productImagePath && fs.existsSync(productImagePath)) {
    const overlayOpts = {
      imagePath: productImagePath,
      discount: user.discount,
      brandName: user.brand,
      ctaText: config.marketing.cta_button,
      ageRange: user.age_range,
    };
    // 档 1：万相图生图（产品保真 + 场景替换；万相已配置才可用）
    if (config.qianwen_vision.api_key && config.qianwen_vision.base_url) {
      try {
        console.error('[image] 档1 万相图生图（上传图场景化）…');
        const editPrompt = generateSceneEditPrompt(user);
        const dataUrl = await compressToJpegDataUrl(productImagePath, 1024);
        const imageUrl = await requestWanxEdit(dataUrl, editPrompt, config);
        const local = await downloadImage(imageUrl, user.user_id, outputDir);
        if (!local) throw new Error('图生图下载为空');
        if (config.marketing.overlay_text) {
          const final = await overlayMarketingText({ ...overlayOpts, imagePath: local });
          return { path: final, method: 'wanx-edit+overlay' };
        }
        return { path: path.resolve(local), method: 'wanx-edit' };
      } catch (e) {
        console.error(`[image] 图生图失败，回落档2 原图叠字: ${(e as Error).message}`);
      }
    }
    // 档 2：原图叠字（管道现成）；overlay 关闭时直接用原图
    try {
      if (config.marketing.overlay_text) {
        const final = await overlayMarketingText(overlayOpts);
        return { path: final, method: 'upload+overlay' };
      }
      return { path: path.resolve(productImagePath), method: 'upload' };
    } catch (e) {
      console.error(`[image] 原图叠字失败，回落档3 文生图: ${(e as Error).message}`);
      uploadFallback = true; // 档3：文生图——落到底部统一生成链路（与无上传图同路径）
    }
  }

  const prompt = (opts.promptOverride || '').trim() || generateImagePrompt(user, config);
  const wanxReady = Boolean(config.qianwen_vision.api_key && config.qianwen_vision.base_url);
  const methodBase = (wanxReady ? 'wanx' : 'pollinations') + (uploadFallback ? '-fallback' : '');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let imageUrl: string;
      if (wanxReady) {
        console.error(`[image] 第 ${attempt}/${maxRetries} 次，调用万相生成…`);
        imageUrl = await requestWanx(prompt, config);
      } else {
        console.error(`[image] 第 ${attempt}/${maxRetries} 次，Pollinations 兜底（overlay=true）…`);
        imageUrl = requestPollinations(user, String(attempt));
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
        return { path: final, method: `${methodBase}+overlay` };
      }
      return { path: path.resolve(local), method: methodBase };
    } catch (e) {
      console.error(`[image] 第 ${attempt}/${maxRetries} 次失败: ${(e as Error).message}`);
      if (attempt < maxRetries) await sleep(retryDelay * 1000);
    }
  }
  console.error('[image] 达到最大重试次数，返回空');
  return { path: '', method: '' };
}
