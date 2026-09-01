/**
 * 图片叠加模块 — @napi-rs/canvas 后期叠加折扣徽章 / CTA 按钮 / 品牌名
 *
 * 端口自 Python emailgen/image_overlay.py（Pillow）。行为对齐：
 *  - 55+（senior）客群保留黑色横条 + 橙色实底 CTA 按钮
 *  - <=54（non-senior）移除横条，文字用投影 + 白色描边提对比
 *  - 画布/字体不可用时降级返回原图路径（等价 Pillow 缺失时的容错）
 */
import * as fs from 'fs';
import * as path from 'path';

interface CanvasModule {
  createCanvas: (w: number, h: number) => CanvasEl;
  loadImage: (src: string | Buffer) => Promise<ImageEl>;
  GlobalFonts: {
    registerFromPath: (p: string, family: string) => boolean;
    has: (family: string) => boolean;
  };
}
interface CanvasEl {
  width: number;
  height: number;
  getContext: (type: string) => CanvasCtx;
  toBuffer: (mime: string) => Buffer;
}
interface ImageEl {
  width: number;
  height: number;
}
interface CanvasCtx {
  drawImage: (img: ImageEl, x: number, y: number) => void;
  fillText: (text: string, x: number, y: number) => void;
  measureText: (text: string) => { width: number };
  fillRect: (x: number, y: number, w: number, h: number) => void;
  beginPath: () => void;
  roundRect: (x: number, y: number, w: number, h: number, r: number) => void;
  fill: () => void;
  stroke: () => void;
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
}

let canvasMod: CanvasModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  canvasMod = require('@napi-rs/canvas');
} catch {
  canvasMod = null;
}

const FONT_FAMILY = 'CartBackOverlay';
let fontRegistered = false;

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
];

function ensureFont(): boolean {
  if (fontRegistered) return true;
  if (!canvasMod) return false;
  if (canvasMod.GlobalFonts.has(FONT_FAMILY)) {
    fontRegistered = true;
    return true;
  }
  for (const fp of FONT_CANDIDATES) {
    try {
      if (fs.existsSync(fp) && canvasMod.GlobalFonts.registerFromPath(fp, FONT_FAMILY)) {
        fontRegistered = true;
        return true;
      }
    } catch {
      continue;
    }
  }
  return false; // 无可用字体，仍可绘制（用默认字体）
}

function seniorByAgeRange(ageRange?: string | null): boolean {
  if (!ageRange) return false;
  const m = String(ageRange).match(/\s*(\d+)/);
  if (!m) return false;
  return parseInt(m[1], 10) >= 55;
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`;
}

export interface OverlayOpts {
  imagePath: string;
  discount: number;
  brandName?: string;
  ctaText?: string;
  outputPath?: string;
  ageRange?: string | null;
  seniorOnlyBackgrounds?: boolean;
}

/**
 * 在营销图底部叠加：品牌名 + 折扣% OFF + CTA 按钮。
 * 返回叠加后的图片绝对路径；画布/字体不可用或失败时返回原图路径。
 */
export async function overlayMarketingText(opts: OverlayOpts): Promise<string> {
  const {
    imagePath,
    discount,
    brandName = 'CartBack',
    ctaText = 'Shop Now',
    outputPath,
    ageRange = null,
    seniorOnlyBackgrounds = true,
  } = opts;

  const src = imagePath;
  if (!fs.existsSync(src)) return src;
  if (!canvasMod) {
    console.error('[overlay] @napi-rs/canvas 未安装，跳过叠加，返回原图');
    return path.resolve(src);
  }

  const outPath = outputPath || path.join(path.dirname(src), `${path.basename(src, path.extname(src))}_final${path.extname(src)}`);
  const hasFont = ensureFont();

  let img: ImageEl;
  try {
    img = await canvasMod.loadImage(src);
  } catch (e) {
    console.error(`[overlay] 打开图片失败: ${(e as Error).message}`);
    return path.resolve(src);
  }

  const W = img.width;
  const H = img.height;
  const canvas = canvasMod.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  const fontFam = hasFont ? FONT_FAMILY : 'sans-serif';
  const base = Math.min(W, H);
  const fontDiscount = Math.max(36, Math.floor(base * 0.1));
  const fontOff = Math.max(22, Math.floor(base * 0.062));
  const fontBrand = Math.max(16, Math.floor(base * 0.035));
  const fontCta = Math.max(18, Math.floor(base * 0.04));

  const white = rgba(255, 255, 255, 255);
  const orange = rgba(255, 107, 53, 255);
  const darkOverlay = rgba(0, 0, 0, 130);
  const shadowBlack = rgba(0, 0, 0, 150);
  const outlineWhiteThin = rgba(255, 255, 255, 220);

  const senior = Boolean(seniorOnlyBackgrounds && seniorByAgeRange(ageRange));
  const barHeight = Math.floor(H / 3);
  const barY = H - barHeight;

  if (senior) {
    ctx.fillStyle = darkOverlay;
    ctx.fillRect(0, barY, W, H - barY);
    console.error(`[overlay] 命中 senior(age_range=${JSON.stringify(ageRange)})：保留黑色横条(A) + 橙色实底按钮(C)`);
  } else {
    console.error(`[overlay] non-senior(age_range=${JSON.stringify(ageRange)})：移除黑色横条(A) + 橙色实底(C改轮廓描边)，用投影+描边提字`);
  }

  function drawTextWithShadow(
    pos: [number, number],
    text: string,
    fontPx: number,
    fill: string,
    o: { shadow?: string; offset?: number; outline?: string } = {},
  ): void {
    const [x, y] = pos;
    const offset = o.offset ?? 0;
    ctx.font = `${fontPx}px ${fontFam}`;
    if (o.shadow && offset > 0 && o.shadow) {
      ctx.fillStyle = o.shadow;
      ctx.fillText(text, x + offset, y + offset);
    }
    if (o.outline) {
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          if (dx === 0 && dy === 0) continue;
          ctx.fillStyle = o.outline;
          ctx.fillText(text, x + dx, y + dy);
        }
      }
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  let discountPct: number;
  const dnum = Number(discount);
  if (!Number.isNaN(dnum)) discountPct = Math.trunc(dnum);
  else discountPct = Math.trunc(Number(discount) || 0);
  const discountText = `${discountPct}%`;
  const offText = 'OFF';

  ctx.font = `${fontDiscount}px ${fontFam}`;
  const discountW = ctx.measureText(discountText).width;
  const discountH = fontDiscount;
  ctx.font = `${fontOff}px ${fontFam}`;
  const offW = ctx.measureText(offText).width;
  const offH = fontOff;

  const totalW = discountW + 10 + offW;
  const startX = Math.floor((W - totalW) / 2);
  const baseY = barY + Math.floor((barHeight - discountH - offH) * 0.18);

  if (senior) {
    drawTextWithShadow([startX, baseY], discountText, fontDiscount, white, {
      shadow: rgba(0, 0, 0, 90),
      offset: 2,
    });
    drawTextWithShadow([startX + discountW + 10, baseY + discountH - offH], offText, fontOff, orange, {
      shadow: rgba(0, 0, 0, 90),
      offset: 1,
    });
  } else {
    drawTextWithShadow([startX, baseY], discountText, fontDiscount, white, {
      shadow: shadowBlack,
      offset: 3,
      outline: outlineWhiteThin,
    });
    drawTextWithShadow([startX + discountW + 10, baseY + discountH - offH], offText, fontOff, orange, {
      shadow: shadowBlack,
      offset: 2,
      outline: outlineWhiteThin,
    });
  }

  // CTA 按钮
  const ctaUpper = ctaText.toUpperCase();
  ctx.font = `${fontCta}px ${fontFam}`;
  const ctaW = ctx.measureText(ctaUpper).width;
  const ctaH = fontCta;
  const padX = Math.max(20, Math.floor(W * 0.05));
  const padY = Math.max(10, Math.floor(H * 0.015));
  const btnW = ctaW + padX * 2;
  const btnH = ctaH + padY * 2;
  const btnX = Math.floor((W - btnW) / 2);
  const btnY = baseY + discountH + Math.max(10, Math.floor(H * 0.02));
  const radius = Math.max(8, Math.min(24, Math.floor(Math.min(btnW, btnH) * 0.18)));

  if (senior) {
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, radius);
    ctx.fillStyle = orange;
    ctx.fill();
    drawTextWithShadow([btnX + padX, btnY + padY], ctaUpper, fontCta, white, {
      shadow: rgba(0, 0, 0, 90),
      offset: 1,
    });
  } else {
    const outlineThickness = Math.max(2, Math.floor(Math.min(W, H) * 0.004));
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, radius);
    ctx.strokeStyle = orange;
    ctx.lineWidth = outlineThickness;
    ctx.stroke();
    drawTextWithShadow([btnX + padX, btnY + padY], ctaUpper, fontCta, orange, {
      shadow: shadowBlack,
      offset: 2,
      outline: outlineWhiteThin,
    });
  }

  // 品牌名
  const brandStr = String(brandName);
  ctx.font = `${fontBrand}px ${fontFam}`;
  const brandW = ctx.measureText(brandStr).width;
  const brandH = fontBrand;
  const brandX = Math.floor((W - brandW) / 2);
  const brandY = Math.max(barY - brandH - 8, 0);
  if (senior) {
    drawTextWithShadow([brandX, brandY], brandStr, fontBrand, white, {
      shadow: rgba(0, 0, 0, 90),
      offset: 1,
    });
  } else {
    drawTextWithShadow([brandX, brandY], brandStr, fontBrand, white, {
      shadow: shadowBlack,
      offset: 2,
      outline: outlineWhiteThin,
    });
  }

  try {
    const buf = canvas.toBuffer('image/png');
    fs.writeFileSync(outPath, buf);
    console.error(`[overlay] ✅ 已输出: ${outPath} (senior_mode=${senior})`);
    return path.resolve(outPath);
  } catch (e) {
    console.error(`[overlay] 保存失败: ${(e as Error).message}`);
    return path.resolve(src);
  }
}
