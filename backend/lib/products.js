'use strict';
/**
 * 商品库（批次 1 上传链路 + 批次 2 品类字段）
 *
 * 上传走现有 JSON 通道：前端压图 ≤2MB 后 base64 随 JSON 提交（backend/server.js 为原生 http，
 * 无 multipart 解析能力——计划文档约束：优先 base64，不满足再引入 busboy，端点请求体抽象不变）。
 * 校验三件套：content-type 白名单 + 魔数嗅探 + 大小上限；文件名 sanitize 复用 downloadImage 的 safeTag 模式。
 */
const fs = require('fs');
const path = require('path');
const { uid } = require('./store');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 计划文档：前端压图至 ≤2MB 后提交，服务端同样卡 2MB

// 商品库数量上限（计划文档风险表「上传图占用磁盘增长」响应项：商品库设数量上限；
// 配额细化随批次 4 再定，此上限为当前硬卡口）。超出返回 409，先删后传。
const MAX_PRODUCTS_PER_USER = 50;

// 品类档案键（批次 2 品类档案表）：商家点选为主，推断兜底，空 = generic（通用模板）
const CATEGORIES = ['phone_case', 'apparel', 'jewelry', 'generic'];

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** 魔数嗅探：png / jpeg / webp，其余一律拒绝（非图片文件被拒 = 批次 1 退出条件） */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp';
  return null;
}

/** 复用 downloadImage 的 safeTag 模式：非 \w.- 连字符化 + 截断 60 */
function safeTag(tag) {
  return String(tag || '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'img';
}

/** data URL（data:image/jpeg;base64,xxx）或裸 base64 + content_type → Buffer；失败返回 null */
function decodeImageDataUrl(body) {
  const raw = String(body.image_data || body.data_url || body.image_base64 || '').trim();
  if (!raw) return null;
  const m = raw.match(/^data:([^;,]+);base64,(.+)$/s);
  const b64 = m ? m[2] : raw;
  const declaredMime = (m ? m[1] : String(body.content_type || '')).toLowerCase();
  // content-type 白名单：声明了非图片 MIME 直接拒（魔数嗅探仍是最终权威）
  if (declaredMime && !declaredMime.startsWith('image/')) return null;
  let buf = null;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return null; }
  if (!buf || !buf.length) return null;
  buf.declaredMime = declaredMime;
  return buf;
}

/**
 * 保存上传商品：数量上限 → 校验 → 落盘 output/uploads/{userId}/{productId}_{ts}.{ext} → 商品记录入 store。
 * 返回 { error?: [status, msg], product?: row }
 */
function saveUploadedProduct(store, userId, body) {
  // 数量上限（磁盘增长防护）：按当前归属统计，本地模式（userId=null）按全库计
  if (store.getProductsByUser(userId).length >= MAX_PRODUCTS_PER_USER) {
    return { error: [409, `商品库已满（上限 ${MAX_PRODUCTS_PER_USER} 张），请先删除不需要的商品图`] };
  }
  const buf = decodeImageDataUrl(body);
  if (!buf) return { error: [400, '缺少图片数据（image_data 需为 base64 或 data URL）'] };
  if (buf.length > MAX_UPLOAD_BYTES) return { error: [413, '图片超过 2MB，请压缩后重试'] };

  const sniffed = sniffImageType(buf);
  if (!sniffed) return { error: [415, '仅支持 PNG / JPEG / WEBP 图片'] };

  const id = uid('prd_');
  const ts = Math.floor(Date.now() / 1000);
  // 与 server.js /api/image 端点同口径：output 根固定在 backend/ 下（__dirname=lib 的上一级），
  // 不用 process.cwd()（部署方式不同 cwd 会漂移，导致上传图 404）
  const outDir = path.join(path.resolve(__dirname, '..'), 'output', 'uploads', safeTag(userId || 'local'));
  fs.mkdirSync(outDir, { recursive: true });
  const fileAbs = path.join(outDir, `${safeTag(id)}_${ts}.${sniffed}`);
  fs.writeFileSync(fileAbs, buf);

  const name = String(body.name || '').trim().slice(0, 80) || `商品 ${ts}`;
  const category = CATEGORIES.includes(body.category) ? body.category : '';
  const now = Date.now();
  const product = {
    id,
    user_id: userId || null,   // 归属以服务端会话为准（同 audience/addAudience 口径，不可信输入不得自带）
    name,
    category,
    file_path: fileAbs,
    content_type: MIME_BY_EXT[sniffed],
    bytes: buf.length,
    created_at: now,
    updated_at: now,
  };
  store.upsertProduct(product);
  return { product };
}

/** 解析本商家的商品图本地路径（/api/draft/:id/image 的 product_image_id → generateMailHtml 管道入口） */
function resolveProductImagePath(store, userId, productId) {
  if (!productId) return null;
  const p = store.getProduct(String(productId));
  if (!p) return null;
  // 越权防护：只允许取本人（或本地模式无归属）的商品
  if (p.user_id && p.user_id !== userId) return null;
  if (!p.file_path || !fs.existsSync(p.file_path)) return null;
  return p.file_path;
}

/** 删除商品行 + 落盘文件（文件缺失视为已删，幂等） */
function deleteProductFile(store, userId, productId) {
  const p = store.getProduct(String(productId));
  if (!p) return false;
  if (p.user_id && p.user_id !== userId) return false;
  store.deleteProduct(p.id);
  try { fs.unlinkSync(p.file_path); } catch (e) { /* 文件已不存在：幂等 */ }
  return true;
}

/**
 * 品类推断兜底（批次 2）：商家上传未点选品类时，用已配置的对话 LLM（qwen3.7-plus 等多模态，
 * 与文案/生图共用 Token Plan key）读图推断；无 key 或失败 → ''（上层落通用模板）。
 * 有界 20s、非致命；返回 CATEGORIES 之一或 ''。
 */
async function inferCategory(dataUrl, config) {
  const key = config.aiKey;
  const base = (config.aiBaseUrl || '').replace(/\/$/, '');
  if (!key || !base || !dataUrl) return '';
  const url = `${base}/chat/completions`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const text = '这是一张电商商品图。判断商品品类，只回复以下英文单词之一，不要任何其他内容：phone_case（手机壳）、apparel（服装）、jewelry（饰品）、generic（其他所有品类）。';
  const attempts = [
    // OpenAI 常规 image_url 形态（对话多模态模型标准形态）
    { model: config.aiModel, max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text }] }] },
    // 万相验证的原生 image 键形态（图在前、文在后）——不同网关兼容性不同，两种都试
    { model: config.aiModel, max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: [{ type: 'image', image: dataUrl }, { type: 'text', text }] }] },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    for (const payload of attempts) {
      try {
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
        if (!resp.ok) continue;
        const data = await resp.json();
        const choice = data.choices && data.choices[0];
        let content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
        if (!content && choice && choice.message && Array.isArray(choice.message.content)) {
          content = choice.message.content.map(p => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : '').join('');
        }
        const word = String(content || '').toLowerCase().replace(/[^a-z_]/g, '');
        const hit = CATEGORIES.find(c => word.includes(c));
        if (hit) return hit;
      } catch (e) { /* 下一形态 / 最终落空 */ }
    }
  } finally {
    clearTimeout(timer);
  }
  return '';
}

module.exports = {
  CATEGORIES,
  MAX_UPLOAD_BYTES,
  MAX_PRODUCTS_PER_USER,
  sniffImageType,
  safeTag,
  decodeImageDataUrl,
  saveUploadedProduct,
  resolveProductImagePath,
  deleteProductFile,
  inferCategory,
};
