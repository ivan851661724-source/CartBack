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
  aiProvider: 'deepseek',
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-chat',
  aiKey: '',                    // 仅服务端持有
  // Agent 上下文预算：按 token 管理，不再按固定消息数硬截断
  aiContextWindowTokens: 32768,
  // 1024 起：thinking 系模型（deepseek-v4-flash 等）的思考 token 计入 completion 预算，
  // 512 会把 JSON envelope 拦腰截断 → 结构化解析失败、残渣透传给用户
  aiMaxOutputTokens: 1024,
  aiContextSafetyMargin: 1024,
  aiRecentTurns: 24,
  aiSummaryTriggerRatio: 0.72,
  aiMaxCallsPerTurn: 3,
  aiCriticMode: 'suspicious',   // 'always' | 'suspicious' | 'off'
  // 供应商专属参数透传（如 Token Plan thinking 系模型的 {"enable_thinking": false}：
  // 思考 token 计入输出预算且把 JSON envelope 挤截断，关掉后 JSON 合规 3/10 → 6/6、延迟减半）
  aiExtraBody: null,
  espProvider: 'resend',        // 'resend' | 'brevo' | 'smtp'（163/QQ 等标准 SMTP，授权码作密码）
  espApiUrl: 'https://api.resend.com/emails',
  espKey: '',                   // 仅服务端持有
  espFrom: '',                  // 真实发信用「已验证发件域名」邮箱，如 onear@yourdomain.com
  espSenderName: 'CartBack',    // 发件人显示名（Brevo sender.name）
  smtpHost: '',                 // 如 smtp.163.com（espProvider=smtp 时必填）
  smtpPort: 465,                // 465 implicit TLS
  smtpUser: '',                 // 完整邮箱
  smtpPass: '',                 // SMTP 授权码（非登录密码），仅服务端持有
  localToken: '',               // 端点鉴权令牌（本地生成）
  webhookSecret: '',            // /api/attribution webhook 校验密钥（本地生成；整改 2）
  adminEmails: [],              // 安全整改：全局配置管理员邮箱白名单（仅这些账号可写 /api/config 全局段）
  userLlmDailyLimit: 200,       // 安全整改：普通用户每日 AI 轮次/调用额度（0 = 不限；管理员不受限）
  attributionWindowDays: 7,
  emailTimeoutDays: 3,              // 已发送超此时长且无打开 → 超时态（异常条）
  sendRateLimitPerMin: 20,
  // —— 店后台连接器（架构 §2 B1）：邮件语种跟「收件人 locale」走，不是跟商家聊天语言 ——
  shopDefaultLocale: 'en',      // 店铺主客群语种（预览/默认）；逐收件人仍按其自身 locale 本地化
  shopBrand: 'CartBack',        // 品牌名（邮件头部 / 营销图叠加 / 文案品牌位）
  shopCartUrl: '', // 邮件 CTA 跳转默认购物车 URL
  publicBaseUrl: '',                    // CartBack 对外公网基址（含协议），邮件内联图片 src 用：${publicBaseUrl}/api/image/<path>
  // —— 视觉 / 邮件图像 AI（复用 emailgen；未单独配时可留空，内部走 Pollinations 免费兜底）——
  visionKey: '',
  visionBaseUrl: '',
  visionModel: 'wan2.7-image-pro',
  // 旧字段别名（兼容已有商家配置 import / 环境变量名）
  wanxKey: '',
  wanxBaseUrl: '',
  wanxModel: '',
  shopify: { shopDomain: '', apiVersion: '2024-04', accessToken: '' }, // Shopify 自定义应用 Admin Token
  stores: [],                   // 多个独立站：[{ type:'rest', baseUrl, apiKey, fieldMap }]
  // —— PRD v5 新增 ——
  g0Whitelist: [],              // G0 白名单：品牌名/专有名词（可含中文），设置页维护，白名单内不拦截
  breakerThreshold: 5,          // 熔断：连续失败 N 次进入 open
  breakerCooldownMs: 30000      // 熔断：open 冷却时长（ms）
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
  removeLegacyDemoConfig(cfg);
  if (!cfg.localToken) {
    cfg.localToken = crypto.randomBytes(24).toString('hex');
    save(cfg);
  }
  if (!cfg.webhookSecret) {
    cfg.webhookSecret = crypto.randomBytes(24).toString('hex');
    save(cfg);
  }
  // 环境变量最后覆盖（部署注入密钥用）；覆盖结果只留在内存，不回写 config.json
  applyEnvOverlay(cfg);
  removeLegacyDemoConfig(cfg);
  return cfg;
}

function removeLegacyDemoConfig(cfg) {
  delete cfg.mode;
  if (Array.isArray(cfg.stores)) cfg.stores = cfg.stores.filter(s => s?.type !== 'mock');
  if (/^https?:\/\/cartback\.demo(?:[/?#]|$)/i.test(cfg.shopCartUrl || '')) cfg.shopCartUrl = '';
}

function save(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** 环境变量覆盖层（部署引导用，走查工程建议 #1）：设置页写入 config.json，重启后环境变量对这些字段优先。
 *  只有非空的环境变量才生效；结构化字段（JSON）解析失败时忽略该变量、保留原值。 */
function applyEnvOverlay(cfg) {
  const str = (k) => { const v = process.env[k]; return (v && v.trim()) ? v.trim() : null; };
  const int = (k) => { const v = str(k); return v && /^\d+$/.test(v) ? parseInt(v, 10) : null; };
  const json = (k) => { const v = str(k); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } };
  const csv = (k) => { const v = str(k); return v ? v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null; };
  const m = {
    adminEmails: csv('CARTBACK_ADMIN_EMAILS'),
    userLlmDailyLimit: int('CARTBACK_USER_LLM_DAILY_LIMIT'),
    aiProvider: str('CARTBACK_AI_PROVIDER'),
    aiKey: str('CARTBACK_AI_KEY'),
    aiBaseUrl: str('CARTBACK_AI_BASE_URL'),
    aiModel: str('CARTBACK_AI_MODEL'),
    aiExtraBody: json('CARTBACK_AI_EXTRA_BODY'),
    espProvider: str('CARTBACK_ESP_PROVIDER'),
    espKey: str('CARTBACK_ESP_KEY'),
    espApiUrl: str('CARTBACK_ESP_API_URL'),
    espFrom: str('CARTBACK_ESP_FROM'),
    espSenderName: str('CARTBACK_ESP_SENDER_NAME'),
    smtpHost: str('CARTBACK_SMTP_HOST'),
    smtpPort: int('CARTBACK_SMTP_PORT'),
    smtpUser: str('CARTBACK_SMTP_USER'),
    smtpPass: str('CARTBACK_SMTP_PASS'),
    visionKey: str('CARTBACK_VISION_KEY'),
    visionBaseUrl: str('CARTBACK_VISION_BASE_URL'),
    visionModel: str('CARTBACK_VISION_MODEL'),
    shopDefaultLocale: str('CARTBACK_SHOP_DEFAULT_LOCALE'),
    shopBrand: str('CARTBACK_SHOP_BRAND'),
    shopCartUrl: str('CARTBACK_SHOP_CART_URL'),
    publicBaseUrl: str('CARTBACK_PUBLIC_BASE_URL'),
    g0Whitelist: json('CARTBACK_G0_WHITELIST')
  };
  let changed = false;
  for (const [k, v] of Object.entries(m)) {
    if (v != null && cfg[k] !== v) { cfg[k] = v; changed = true; }
  }
  return changed;
}

/** 返回给前端的「配置状态」——绝不包含密钥明文 */
function status(cfg) {
  const storeConfigured = Boolean(
    (cfg.shopify && cfg.shopify.shopDomain && cfg.shopify.accessToken) ||
    (Array.isArray(cfg.stores) && cfg.stores.length)
  );
  return {
    aiConfigured: Boolean(cfg.aiKey),
    espConfigured: cfg.espProvider === 'smtp'
      ? Boolean(cfg.smtpHost && cfg.smtpUser && cfg.smtpPass && cfg.espFrom)
      : Boolean(cfg.espKey && cfg.espFrom),
    espFrom: cfg.espFrom ? cfg.espFrom.replace(/(.{2}).*(@.*)/, '$1***$2') : '',
    aiProvider: cfg.aiProvider,
    aiModel: cfg.aiModel || '',          // 回显给前端设置页（P1-3：避免刷新后模型名丢失）
    aiBaseUrl: cfg.aiBaseUrl || '',      // 非敏感（基地址非密钥），设置页回显便于核对专属基地址配套
    aiContextWindowTokens: cfg.aiContextWindowTokens,
    aiMaxOutputTokens: cfg.aiMaxOutputTokens,
    aiRecentTurns: cfg.aiRecentTurns,
    aiCriticMode: cfg.aiCriticMode,
    espProvider: cfg.espProvider,
    attributionWindowDays: cfg.attributionWindowDays,
    emailTimeoutDays: cfg.emailTimeoutDays,
    sendRateLimitPerMin: cfg.sendRateLimitPerMin,
    userLlmDailyLimit: cfg.userLlmDailyLimit,   // 安全整改：设置页/前端提示每用户日额度（非敏感）
    shopDefaultLocale: cfg.shopDefaultLocale || 'en',
    shopBrand: cfg.shopBrand || '',      // M4：设置页品牌名回显（非敏感；空串 = 未配置，邮件品牌走兜底链）
    g0Whitelist: Array.isArray(cfg.g0Whitelist) ? cfg.g0Whitelist : [],   // 设置页回显白名单（非敏感）
    storeConfigured,          // 是否已接入任意店后台（不暴露任何密钥/域名）
    storeTypes: storeConfigured
      ? ([
          (cfg.shopify && cfg.shopify.shopDomain && cfg.shopify.accessToken) ? 'shopify' : null,
          ...(Array.isArray(cfg.stores) ? cfg.stores.map(s => s.type).filter(Boolean) : [])
        ].filter(Boolean))
      : []
  };
}

// —— Wave 2 全局口径常量（单处权威，业务模块一律从这里引用，禁止再各自硬编码）——
// 频控窗口：PRD 口径为 7 天，挂起裁决先不动 72h（PRD §3.4 72h 频控维持现状，待裁决后只改这里）
const FREQUENCY_WINDOW_MS = 72 * 3600 * 1000;
// holdout 对照组：按 10% 从闸门过滤后的净值名单圈定；名单 < 200 人不冻结（J3 前置子集）
const HOLDOUT_RATIO = 0.1;
const HOLDOUT_MIN_LIST = 200;
// 发送时段闸门（D4①）：收件人时区 09:00–21:00 为合理时段，界外缓发
const SEND_WINDOW_START_HOUR = 9;
const SEND_WINDOW_END_HOUR = 21;
// estGmv 公式（D3）：reach_count × 客单价 × 挽回率(12% 行业参考) − 折扣成本；客单价缺失用行业默认
const RECOVERY_RATE_REFERENCE = 0.12;
const INDUSTRY_DEFAULT_AOV = 45; // USD

// —— Wave 5 全局口径常量（单处权威，业务模块一律从这里引用）——
// E1 冲动折扣拦截：offer 折扣 ≥25%（% off）先拦截给替代建议；大促季（停发日历命中区间 ±14 天）放宽到 40%
const E1_THRESHOLD = 25;
const E1_THRESHOLD_SALE = 40;
const SALE_WINDOW_DAYS = 14;
// I4「已挽回」排除窗口：归因 conversion 命中过的收件人 N 天内不再触达（窗口过后可再触达）
const RECOVERED_EXCLUSION_DAYS = 30;
const RECOVERED_EXCLUSION_WINDOW_MS = RECOVERED_EXCLUSION_DAYS * 86400000;
// A4 僵尸会话收口：S0/S1 闲置 >48h 收口；S2 可能正等确认，闲置 >7 天才收口
const ZOMBIE_S1_IDLE_MS = 48 * 3600 * 1000;
const ZOMBIE_S2_IDLE_MS = 7 * 86400000;

module.exports = {
  ROOT, PUBLIC_DIR, SERVER_DIR, CONFIG_FILE, DB_FILE,
  FREQUENCY_WINDOW_MS, HOLDOUT_RATIO, HOLDOUT_MIN_LIST,
  SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR,
  RECOVERY_RATE_REFERENCE, INDUSTRY_DEFAULT_AOV,
  E1_THRESHOLD, E1_THRESHOLD_SALE, SALE_WINDOW_DAYS,
  RECOVERED_EXCLUSION_DAYS, RECOVERED_EXCLUSION_WINDOW_MS,
  ZOMBIE_S1_IDLE_MS, ZOMBIE_S2_IDLE_MS,
  load, save, status, DEFAULTs: DEFAULTS
};
