'use strict';
/**
 * lib/posters.js — 海报生成管线（PRD §3.3 / /api/posters）
 *
 * 设计（确认弹出时入队异步生成，不阻塞发送）：
 *  - wan2.6-t2i（配了 visionKey 时）：DashScope 异步任务 API，n=3；临时 URL → 本地转存（24h 过期不影响后续展示）；
 *  - 未配 key / 失败 → @napi-rs/canvas 本地占位海报（品牌 + 折扣醒目 + 优惠码），status='placeholder' 可重试；
 *  - 产物写 output/posters/<draftId>_<i>.png，经 /api/image/<path> 服务。
 * 生成器可注入（测试传 t2iFn/占位开关），确定性可测。
 */
const fs = require('fs');
const path = require('path');

const W = 1200, H = 600;
const PALETTES = [
  { bg: '#1f2430', accent: '#ffb100', text: '#ffffff' },
  { bg: '#12291f', accent: '#3ddc84', text: '#ffffff' },
  { bg: '#2a1533', accent: '#e455ff', text: '#ffffff' }
];
const HEADLINES = ['YOUR CART MISSES YOU', 'STILL THINKING IT OVER?', 'LAST CALL — COME BACK'];

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

/** 本地占位海报（零网络、确定性）：品牌 + 折扣 + 优惠码 + CTA */
function drawPlaceholderPoster({ brand, discount, coupon, headline, palette }) {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, W, H);
  // 斜向色带（视觉层次）
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.lineTo(W, H * 0.35); ctx.lineTo(0, H);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;

  const big = Number(discount) >= 30 ? String(discount) : String(discount || 10);
  ctx.fillStyle = palette.text;
  ctx.font = 'bold 44px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText((brand || 'CartBack').toUpperCase(), 64, 56);

  ctx.font = 'bold 150px sans-serif';
  ctx.fillStyle = palette.accent;
  ctx.fillText(`${big}%`, 64, 170);
  ctx.font = 'bold 64px sans-serif';
  ctx.fillStyle = palette.text;
  ctx.fillText('OFF YOUR CART', 64, 340);

  ctx.font = '28px sans-serif';
  ctx.fillStyle = palette.text;
  ctx.globalAlpha = 0.85;
  ctx.fillText(headline || HEADLINES[0], 64, 440);
  if (coupon) {
    ctx.globalAlpha = 1;
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = palette.accent;
    ctx.fillText(`CODE: ${coupon}`, 64, 500);
  }
  ctx.globalAlpha = 1;
  ctx.font = '24px sans-serif';
  ctx.fillStyle = palette.text;
  ctx.fillText('Tap to complete your order →', W - 420, 520);
  return canvas.toBuffer('image/png');
}

/**
 * DashScope wan2.x-t2i 异步任务：创建任务 → 轮询 → 下载临时 URL 转存本地。
 * 任何失败抛错（调用方降级占位）。t2iFetch 可注入（测试桩）。
 */
async function wanxText2Image({ prompt, apiKey, baseUrl, model, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const create = await doFetch(baseUrl.replace(/\/+$/, '') + '/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: model || 'wan2.6-t2i',
      input: { prompt, negative_prompt: 'text errors, watermark, distorted letters, low quality' },
      parameters: { size: '1200*600', n: 1 }
    })
  });
  if (!create.ok) throw new Error('wanx create HTTP ' + create.status);
  const cj = await create.json();
  const taskId = cj && cj.output && cj.output.task_id;
  if (!taskId) throw new Error('wanx no task_id');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await doFetch(baseUrl.replace(/\/+$/, '') + '/tasks/' + taskId, {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    if (!poll.ok) continue;
    const pj = await poll.json();
    const status = pj && pj.output && pj.output.task_status;
    if (status === 'SUCCEEDED') {
      const url = pj.output.results && pj.output.results[0] && pj.output.results[0].url;
      if (!url) throw new Error('wanx no result url');
      return url;
    }
    if (status === 'FAILED') throw new Error('wanx task failed');
  }
  throw new Error('wanx poll timeout');
}

/**
 * 为草稿生成 3 款海报（队列 handler 调用；单张失败不阻塞其余）。
 * @param {object} o { draft, config, outDir, t2iFn }
 * @returns {posters: [{status, file, url?, method}]}
 */
async function generatePosters(o = {}) {
  const { draft = {}, config = {}, outDir } = o;
  ensureDir(outDir);
  const brand = config.shopBrand || 'CartBack';
  const discount = Number(draft.discount) || 10;
  const coupon = draft.coupon || '';
  const base = (config.publicBaseUrl || '').replace(/\/+$/, '');
  const t2iFn = o.t2iFn || ((prompt) => wanxText2Image({
    prompt, apiKey: config.visionKey, baseUrl: config.visionBaseUrl || 'https://dashscope.aliyuncs.com/api/v1',
    model: config.visionModel || 'wan2.6-t2i'
  }));
  const posters = [];
  for (let i = 0; i < 3; i++) {
    const file = path.join(outDir, `${(draft.id || 'draft').replace(/[^\w-]/g, '')}_${i + 1}.png`);
    let entry = { file, method: 'placeholder', status: 'ready', created_at: Date.now() };
    try {
      if (config.visionKey) {
        const prompt = `marketing poster for online store "${brand}", ${discount} percent off promotion, bold discount badge, brand color scheme, clean e-commerce style, 1200x600 banner`;
        const url = await t2iFn(prompt, i);
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        fs.writeFileSync(file, buf);   // 临时 URL → 本地转存（原 URL 24h 过期不影响）
        entry.method = 'wanx';
      } else {
        throw Object.assign(new Error('no vision key'), { code: 'NO_KEY_FALLBACK_PLACEHOLDER' });
      }
    } catch (e) {
      // 降级占位：本地 canvas 直出（不阻塞发送；可重新入队重试真图生成）
      const buf = drawPlaceholderPoster({ brand, discount, coupon, headline: HEADLINES[i % 3], palette: PALETTES[i % 3] });
      fs.writeFileSync(file, buf);
      entry.method = 'placeholder';
      entry.note = String(e && e.message || e);
    }
    entry.url = (base ? base : '') + '/api/image/' + encodeURIComponent(file);
    posters.push(entry);
  }
  return { posters };
}

module.exports = { generatePosters, drawPlaceholderPoster, wanxText2Image, HEADLINES, PALETTES, W, H };
