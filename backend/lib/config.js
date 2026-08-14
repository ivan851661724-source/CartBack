'use strict';
/**
 * 服务端配置 / 密钥管理
 *
 * 安全架构 §6 关键约束：
 *  - AI / ESP 密钥只存于服务端「非 web 根目录」的 .server/config.json
 *  - 绝不进静态目录、绝不回传前端
 *  - web 根 = public/，.server/ 不在其下，静态托管无法访问
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 默认非 web 根 .server；测试可经 EY_SERVER_DIR 隔离，避免污染主配置/库
const SERVER_DIR = process.env.EY_SERVER_DIR ? path.resolve(process.env.EY_SERVER_DIR) : path.join(ROOT, '.server');
const CONFIG_FILE = path.join(SERVER_DIR, 'config.json');
const DB_FILE = path.join(SERVER_DIR, 'data.sqlite');

const DEFAULTS = {
  mode: 'demo',                 // 'demo' | 'real'
  aiProvider: 'deepseek',
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-chat',
  aiKey: '',                    // 仅服务端持有
  // Agent 上下文预算：按 token 管理，不再按固定消息数硬截断
  aiContextWindowTokens: 32768,
  aiMaxOutputTokens: 512,
  aiContextSafetyMargin: 1024,
  aiRecentTurns: 24,
  aiSummaryTriggerRatio: 0.72,
  aiMaxCallsPerTurn: 3,
  aiCriticMode: 'suspicious',   // 'always' | 'suspicious' | 'off'
  espProvider: 'resend',
  espApiUrl: 'https://api.resend.com/emails',
  espKey: '',                   // 仅服务端持有
  espFrom: '',                  // 真实发信用「已验证发件域名」邮箱，如 onear@yourdomain.com
  localToken: '',               // 端点鉴权令牌（本地生成）
  webhookSecret: '',            // /api/attribution webhook 校验密钥（本地生成；整改 2）
  attributionWindowDays: 7,
  emailTimeoutDays: 3,              // 已发送超此时长且无打开 → 超时态（异常条）
  sendRateLimitPerMin: 20,
  // —— 店后台连接器（架构 §2 B1）：邮件语种跟「收件人 locale」走，不是跟商家聊天语言 ——
  shopDefaultLocale: 'en',      // 店铺主客群语种（预览/默认）；逐收件人仍按其自身 locale 本地化
  shopify: { shopDomain: '', apiVersion: '2024-04', accessToken: '' }, // Shopify 自定义应用 Admin Token
  stores: []                    // 多个独立站：[{ type:'rest', baseUrl, apiKey, fieldMap }]
};

function ensureDir() {
  if (!fs.existsSync(SERVER_DIR)) fs.mkdirSync(SERVER_DIR, { recursive: true });
}

function load() {
  ensureDir();
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg = { ...cfg, ...raw };
    } catch (e) {
      // 损坏则重建，不致命
    }
  }
  if (!cfg.localToken) {
    cfg.localToken = crypto.randomBytes(24).toString('hex');
    save(cfg);
  }
  if (!cfg.webhookSecret) {
    cfg.webhookSecret = crypto.randomBytes(24).toString('hex');
    save(cfg);
  }
  return cfg;
}

function save(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** 返回给前端的「配置状态」——绝不包含密钥明文 */
function status(cfg) {
  const storeConfigured = Boolean(
    (cfg.shopify && cfg.shopify.shopDomain && cfg.shopify.accessToken) ||
    (Array.isArray(cfg.stores) && cfg.stores.length)
  );
  return {
    mode: cfg.mode,
    aiConfigured: Boolean(cfg.aiKey),
    espConfigured: Boolean(cfg.espKey),
    espFrom: cfg.espFrom ? cfg.espFrom.replace(/(.{2}).*(@.*)/, '$1***$2') : '',
    aiProvider: cfg.aiProvider,
    aiModel: cfg.aiModel || '',          // 回显给前端设置页（P1-3：避免刷新后模型名丢失）
    aiContextWindowTokens: cfg.aiContextWindowTokens,
    aiMaxOutputTokens: cfg.aiMaxOutputTokens,
    aiRecentTurns: cfg.aiRecentTurns,
    aiCriticMode: cfg.aiCriticMode,
    espProvider: cfg.espProvider,
    attributionWindowDays: cfg.attributionWindowDays,
    emailTimeoutDays: cfg.emailTimeoutDays,
    sendRateLimitPerMin: cfg.sendRateLimitPerMin,
    shopDefaultLocale: cfg.shopDefaultLocale || 'en',
    storeConfigured,          // 是否已接入任意店后台（不暴露任何密钥/域名）
    storeTypes: storeConfigured
      ? ([
          (cfg.shopify && cfg.shopify.shopDomain && cfg.shopify.accessToken) ? 'shopify' : null,
          ...(Array.isArray(cfg.stores) ? cfg.stores.map(s => s.type).filter(Boolean) : [])
        ].filter(Boolean))
      : []
  };
}

module.exports = {
  ROOT, PUBLIC_DIR, SERVER_DIR, CONFIG_FILE, DB_FILE,
  load, save, status, DEFAULTs: DEFAULTS
};
