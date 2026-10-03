/**
 * 商品库客户端（批次 1 上传链路）—— 上传/列表/删除 + 客户端压图。
 *
 * 上传通道：前端 canvas 压图（最长边 ≤1024px、JPEG 逐步降质）至 ≤2MB 后 base64 随 JSON 提交
 * （后端原生 http 无 multipart，计划约束：优先 base64 零新依赖）。
 */
import { api } from './api';

export interface ProductItem {
  id: string;
  name: string;
  category: string; // phone_case | apparel | jewelry | generic | ''（空 = 服务端推断/通用）
  content_type: string;
  bytes: number;
  created_at: number;
  image_url: string; // /api/image/<encoded path>，同源反代可直出
}

/** 品类点选项（与后端 lib/products.js CATEGORIES 同键） */
export const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'phone_case', label: '手机壳' },
  { value: 'apparel', label: '服装' },
  { value: 'jewelry', label: '饰品' },
  { value: 'generic', label: '通用' },
];

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function readAsImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片文件')); };
    img.src = url;
  });
}

/** EXIF 方向修正：手机原图常带旋转标记，canvas 直接画会方向错误；优先 createImageBitmap 解析方向 */
async function readAsBitmapUpright(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 老浏览器不支持 options，回退 Image 元素 */ }
  }
  return readAsImage(file);
}

/**
 * 客户端压图：最长边压到 ≤maxDim，JPEG 导出并逐步降质/降尺寸直至 ≤maxBytes。
 * 先铺白底再绘制：PNG 透明底（商品抠图）转 JPEG 若不铺底会变黑底。
 * 失败（如 canvas 不可用/非图片）抛错，调用方提示用户。
 */
export async function compressImageFile(file: File, maxBytes = MAX_UPLOAD_BYTES, maxDim = 1024): Promise<string> {
  const img = await readAsBitmapUpright(file);
  const width = 'width' in img ? img.width : 0;
  const height = 'height' in img ? img.height : 0;
  if (!width || !height) throw new Error('无法读取图片尺寸');
  let scale = Math.min(1, maxDim / Math.max(width, height));
  let quality = 0.85;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持图片压缩');
  for (let i = 0; i < 8; i++) {
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    // data URL base64 体积 ≈ 1.37×二进制；此处直接量 dataUrl 长度即可
    if (dataUrl.length * 0.75 <= maxBytes) return dataUrl;
    if (quality > 0.5) quality -= 0.15;
    else scale *= 0.85;
  }
  throw new Error('图片压缩后仍超过 2MB，请换更小的图片');
}

/** 商品库列表（user_id 隔离由服务端会话保证） */
export async function listProducts(): Promise<ProductItem[]> {
  const r = await api<{ products?: ProductItem[]; error?: string }>('/api/products');
  if (r && r.error) throw new Error(r.error);
  return Array.isArray(r?.products) ? r.products : [];
}

/** 上传商品：压图 → base64 随 JSON 提交；category 留空 = 服务端读图推断兜底 */
export async function uploadProduct(file: File, category: string, name?: string): Promise<ProductItem> {
  const imageData = await compressImageFile(file);
  const r = await api<{ product?: ProductItem; error?: string }>('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      image_data: imageData,
      content_type: 'image/jpeg',
      category: category || '',
      name: (name || file.name.replace(/\.[a-z0-9]+$/i, '')).slice(0, 80),
    }),
  });
  if (r?.error || !r?.product) throw new Error(r?.error || '上传失败');
  return r.product;
}

export async function deleteProduct(id: string): Promise<void> {
  const r = await api<{ deleted?: boolean; error?: string }>(`/api/products/${id}`, { method: 'DELETE' });
  if (r?.error) throw new Error(r.error);
}
