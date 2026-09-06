/**
 * 构建 selftest5 图片画廊（稳健缩略图，避免裂图）。
 * 端口自 Python scripts/build_st5_gallery.py。
 * 用法: node dist/gallery.js
 * 读取 output/images/ 最新 5 张图 → 小体积 JPEG 缩略图（base64 内嵌）→ output/st5_gallery_1.html / _2.html
 */
import * as fs from 'fs';
import * as path from 'path';

interface CanvasModule {
  createCanvas: (w: number, h: number) => CanvasEl;
  loadImage: (src: string | Buffer) => Promise<{ width: number; height: number }>;
}
interface CanvasEl {
  width: number;
  height: number;
  getContext: (t: string) => CanvasCtx;
  toBuffer: (mime: string) => Buffer;
}
interface CanvasCtx {
  drawImage: (img: { width: number; height: number }, x: number, y: number, w: number, h: number) => void;
}

let canvasMod: CanvasModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  canvasMod = require('@napi-rs/canvas');
} catch {
  canvasMod = null;
}

const BACKEND = path.resolve(__dirname, '..');
const IMG_DIR = path.join(BACKEND, 'output', 'images');
const OUT_DIR = path.join(BACKEND, 'output');

const PROFILES = [
  { key: 'st5_1', name: 'P1 美国Z世代时尚女大学生', device: 'iPhone 15', product_cn: '闪钻冰透壳', tags: 'F / 18-24 / value / new / English' },
  { key: 'st5_2', name: 'P2 美国中年硬核科技男(西语裔)', device: 'iPhone 15 Pro Max', product_cn: '军工磁吸防摔壳', tags: 'M / 35-44 / premium / returning / Spanish' },
  { key: 'st5_3', name: 'P3 德国商务男士', device: 'iPhone 14', product_cn: '真皮卡包翻盖壳', tags: 'M / 25-34 / premium / vip / German' },
  { key: 'st5_4', name: 'P4 加拿大中年实用女(魁北克法语)', device: 'iPhone 13', product_cn: '简约透明软壳', tags: 'F / 45-54 / value / returning / French' },
  { key: 'st5_5', name: 'P5 澳洲年轻户外男(意裔)', device: 'iPhone 15 Pro', product_cn: '防水户外防护壳', tags: 'M / 18-24 / standard / new / Italian' },
];

function latestFor(key: string): string | null {
  if (!fs.existsSync(IMG_DIR)) return null;
  const files = fs
    .readdirSync(IMG_DIR)
    .filter((f) => f.startsWith(`${key}_`) && f.endsWith('.png'))
    .sort();
  return files.length ? path.join(IMG_DIR, files[files.length - 1]) : null;
}

async function makeThumbB64Async(p: string): Promise<string> {
  if (!canvasMod) throw new Error('@napi-rs/canvas 未安装');
  const im = await canvasMod.loadImage(p);
  const w = im.width;
  const h = im.height;
  const nw = 160;
  const nh = Math.max(1, Math.floor((h * nw) / w));
  const canvas = canvasMod.createCanvas(nw, nh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(im, 0, 0, nw, nh);
  const raw = canvas.toBuffer('image/jpeg');
  const b64 = Buffer.from(raw).toString('base64');
  process.stderr.write(`[thumb] ${path.basename(p)} → JPEG ${raw.length} bytes, b64 ${b64.length} chars\n`);
  return `data:image/jpeg;base64,${b64}`;
}

const STYLE =
  '<style>\n' +
  ':root[data-widget-theme="light"]{--bg:#fff;--card:#f8f9fb;--text:#1a1a1a;--sub:#6b7280;' +
  '--accent:#ff6b35;--border:#e5e7eb;--tag:#eef2f7;--tagt:#374151;--dev:#1e3a8a;}\n' +
  ':root[data-widget-theme="dark"]{--bg:#0f1115;--card:#181b22;--text:#f3f4f6;--sub:#9ca3af;' +
  '--accent:#ff8a5b;--border:#2a2f3a;--tag:#222732;--tagt:#cbd5e1;--dev:#93c5fd;}\n' +
  '.gw{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,' +
  "'Segoe UI',Roboto,sans-serif;padding:12px;}\n" +
  '.gt{font-size:15px;font-weight:700;margin:0 0 3px;}\n' +
  '.gs{font-size:11px;color:var(--sub);margin:0 0 10px;}\n' +
  '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}\n' +
  '.card{border:1px solid var(--border);border-radius:9px;overflow:hidden;}\n' +
  '.thumb{width:100%;height:150px;object-fit:cover;display:block;}\n' +
  '.meta{padding:6px 8px 8px;}\n' +
  '.pid{font-size:10.5px;font-weight:700;color:var(--accent);}\n' +
  '.pn{font-size:12px;font-weight:600;margin:1px 0 2px;line-height:1.2;}\n' +
  '.pd{font-size:10.5px;color:var(--dev);font-weight:600;margin-bottom:2px;}\n' +
  '.pt{font-size:10px;color:var(--tagt);}\n' +
  '@media(max-width:420px){.grid{grid-template-columns:1fr;}.thumb{height:185px;}}\n' +
  '</style>\n';

async function buildGallery(
  profiles: typeof PROFILES,
  title: string,
  subtitle: string,
  outPath: string,
): Promise<string> {
  const cards: string[] = [];
  for (const p of profiles) {
    const fp = latestFor(p.key);
    if (!fp || !fs.existsSync(fp)) {
      process.stderr.write(`[warn] 找不到 ${p.key} 的图\n`);
      continue;
    }
    const src = await makeThumbB64Async(fp);
    cards.push(
      `<div class="card"><img class="thumb" alt="${p.key}" src="${src}"/>` +
        `<div class="meta"><div class="pid">${p.key.toUpperCase()}</div>` +
        `<div class="pn">${p.name}</div>` +
        `<div class="pd">${p.product_cn} · ${p.device}</div>` +
        `<div class="pt">${p.tags}</div></div></div>`,
    );
  }
  const html =
    STYLE +
    '<div class="gw" data-dynamic-ui-widget data-template="comparison">\n' +
    `<p class="gt">${title}</p>\n` +
    `<p class="gs">${subtitle}</p>\n` +
    '<div class="grid">\n' +
    cards.join('\n') +
    '\n</div></div>\n';
  fs.writeFileSync(outPath, html, 'utf8');
  const size = fs.statSync(outPath).size;
  process.stderr.write(`[done] → ${outPath} (${size} bytes)\n`);
  return outPath;
}

async function main(): Promise<number> {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const sub1 = 'P1 Z世代女 / P2 中年科技男 / P3 德国商务男 — 手持手机壳近景，场景虚化 bokeh';
  const sub2 = 'P4 中年实用女 / P5 澳洲户外男 — 已修复 P4 裂图，主体明确为手机壳';
  await buildGallery(PROFILES.slice(0, 3), '手机壳近景手持 + 场景虚化 bokeh（v3 · 1/2）', sub1, path.join(OUT_DIR, 'st5_gallery_1.html'));
  await buildGallery(PROFILES.slice(3), '手机壳近景手持 + 场景虚化 bokeh（v3 · 2/2）', sub2, path.join(OUT_DIR, 'st5_gallery_2.html'));
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`[gallery] fatal: ${e && (e as Error).stack || e}\n`);
    process.exit(1);
  });
}

export { buildGallery };
