/**
 * 配置加载模块 — 支持 YAML 文件 + 环境变量 + Node 注入（stdin JSON 的 ai_config 字段）
 *
 * 优先级：Node 注入 > 环境变量 > emailgen_config.yaml > 内置默认值。
 * 端口自 Python emailgen/config.py，行为保持一致。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let yamlImport: typeof import('js-yaml') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  yamlImport = require('js-yaml');
} catch {
  yamlImport = null; // js-yaml 缺失时退化为纯默认值
}

export interface MiniMaxConfig {
  api_key: string;
  model: string;
  base_url: string;
}
export interface DeepSeekConfig {
  api_key: string;
  model: string;
  base_url: string;
}
export interface QianwenVisionConfig {
  api_key: string;
  model: string;
  image_size: string;
  base_url: string;
}
export interface BrevoConfig {
  api_key: string;
  sender_email: string;
  sender_name: string;
}
export interface EmailSMTPConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  sender_email: string;
  sender_name: string;
  use_ssl: boolean;
  use_tls: boolean;
  cart_url: string;
}
export interface MarketingConfig {
  discount_priority: boolean;
  urgency_cta: boolean;
  send_window_start: string;
  send_window_end: string;
  image_main_text: string;
  cta_button: string;
  image_style: string;
  overlay_text: boolean;
}

export interface Config {
  minimax: MiniMaxConfig;
  deepseek: DeepSeekConfig | null;
  qianwen_vision: QianwenVisionConfig;
  brevo: BrevoConfig;
  email: EmailSMTPConfig | null;
  marketing: MarketingConfig;
  input_file: string;
  output_dir: string;
  source: string;
}

interface AiConfig {
  provider?: string;
  aiProvider?: string;
  apiKey?: string;
  key?: string;
  baseUrl?: string;
  aiBaseUrl?: string;
  model?: string;
  aiModel?: string;
  visionKey?: string;
  wanxKey?: string;
  visionBaseUrl?: string;
  wanxBaseUrl?: string;
  visionModel?: string;
  wanxModel?: string;
  [k: string]: unknown;
}

function defaults(): Config {
  return {
    minimax: { api_key: '', model: 'MiniMax-M2.7', base_url: 'https://api.minimax.chat/v1' },
    deepseek: null,
    qianwen_vision: { api_key: '', model: 'wan2.7-image-pro', image_size: '768*1152', base_url: '' },
    brevo: { api_key: '', sender_email: 'hello@example.com', sender_name: 'CartBack' },
    email: null,
    marketing: {
      discount_priority: true,
      urgency_cta: true,
      send_window_start: '10:30',
      send_window_end: '21:00',
      image_main_text: 'discount_percentage',
      cta_button: 'Shop Now',
      image_style: 'tech',
      overlay_text: false,
    },
    input_file: 'user_data.jsonl',
    output_dir: 'output/images',
    source: 'defaults',
  };
}

// backend 根目录（dist/ 的上一级）
const BACKEND_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILENAMES = ['emailgen_config.yaml', 'emailgen_config.yml'];

function findYamlPath(explicitPath?: string): string | null {
  if (explicitPath) {
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }
  const candidates: string[] = [];
  // 兼容旧布局：backend/emailgen/ 下
  for (const name of DEFAULT_CONFIG_FILENAMES) candidates.push(path.join(BACKEND_ROOT, 'emailgen', name));
  // 新布局：backend 根
  for (const name of DEFAULT_CONFIG_FILENAMES) candidates.push(path.join(BACKEND_ROOT, name));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readYaml(p: string): Record<string, unknown> {
  if (!yamlImport) return {};
  try {
    const data = yamlImport.load(fs.readFileSync(p, 'utf8'));
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function setStr<T extends object>(target: T, field: keyof T, envKey: string): void {
  const v = process.env[envKey];
  if (v !== undefined) (target as Record<string, unknown>)[field as string] = v;
}

function applyEnv(cfg: Config): void {
  if (!cfg.deepseek) cfg.deepseek = { api_key: '', model: 'deepseek-chat', base_url: 'https://api.deepseek.com' };
  setStr(cfg.deepseek, 'api_key', 'CARTBACK_DEEPSEEK_KEY');
  setStr(cfg.deepseek, 'base_url', 'CARTBACK_DEEPSEEK_URL');
  setStr(cfg.deepseek, 'model', 'CARTBACK_DEEPSEEK_MODEL');
  setStr(cfg.minimax, 'api_key', 'CARTBACK_MINIMAX_KEY');
  setStr(cfg.minimax, 'base_url', 'CARTBACK_MINIMAX_URL');
  setStr(cfg.qianwen_vision, 'api_key', 'CARTBACK_WANX_KEY');
  setStr(cfg.qianwen_vision, 'base_url', 'CARTBACK_WANX_URL');
  setStr(cfg.qianwen_vision, 'model', 'CARTBACK_WANX_MODEL');
  setStr(cfg.marketing, 'cta_button', 'CARTBACK_CTA');
  setStr(cfg.marketing, 'image_style', 'CARTBACK_IMAGE_STYLE');
  // 空的 deepseek key 退回 None 语义（与 Python 一致：未配置时 deepseek 可为 None）
  if (cfg.deepseek && !cfg.deepseek.api_key) cfg.deepseek = null;
}

function applyNodeInjection(cfg: Config, aiConfig?: AiConfig | null): void {
  if (!aiConfig) return;
  const provider = String(aiConfig.provider || aiConfig.aiProvider || 'deepseek').toLowerCase();
  const key = String(aiConfig.apiKey || aiConfig.key || '').trim();
  const base = String(aiConfig.baseUrl || aiConfig.aiBaseUrl || '').trim();
  const model = String(aiConfig.model || aiConfig.aiModel || '').trim();

  if (provider === 'deepseek' && key) {
    if (!cfg.deepseek) cfg.deepseek = { api_key: '', model: 'deepseek-chat', base_url: 'https://api.deepseek.com' };
    cfg.deepseek.api_key = key;
    if (base) cfg.deepseek.base_url = base;
    if (model) cfg.deepseek.model = model;
  } else if (provider === 'minimax' && key) {
    cfg.minimax.api_key = key;
    if (base) cfg.minimax.base_url = base;
    if (model) cfg.minimax.model = model;
  }

  const vk = String(aiConfig.visionKey || aiConfig.wanxKey || '').trim();
  const vu = String(aiConfig.visionBaseUrl || aiConfig.wanxBaseUrl || '').trim();
  const vm = String(aiConfig.visionModel || aiConfig.wanxModel || '').trim();
  if (vk) cfg.qianwen_vision.api_key = vk;
  if (vu) cfg.qianwen_vision.base_url = vu;
  if (vm) cfg.qianwen_vision.model = vm;
}

export function loadConfig(opts: { configPath?: string; aiConfig?: AiConfig | null } = {}): Config {
  const cfg = defaults();
  const yamlPath = findYamlPath(opts.configPath);
  if (yamlPath) {
    const raw = readYaml(yamlPath);
    cfg.source = `yaml:${path.basename(yamlPath)}`;
    const m = (raw.minimax || {}) as Record<string, unknown>;
    const ds = (raw.deepseek || {}) as Record<string, unknown>;
    const q = (raw.qianwen_vision || {}) as Record<string, unknown>;
    const b = (raw.brevo || {}) as Record<string, unknown>;
    const e = (raw.email || {}) as Record<string, unknown>;
    const mk = (raw.marketing || {}) as Record<string, unknown>;
    const d = (raw.data || {}) as Record<string, unknown>;

    for (const k of ['api_key', 'model', 'base_url'] as const) {
      if (m[k]) cfg.minimax[k] = String(m[k]);
    }
    if (ds && ds.api_key) {
      cfg.deepseek = {
        api_key: String(ds.api_key ?? ''),
        model: String(ds.model ?? 'deepseek-chat'),
        base_url: String(ds.base_url ?? 'https://api.deepseek.com'),
      };
    }
    for (const k of ['api_key', 'model', 'image_size', 'base_url'] as const) {
      if (q[k]) cfg.qianwen_vision[k] = String(q[k]);
    }
    for (const k of ['api_key', 'sender_email', 'sender_name'] as const) {
      if (b[k]) cfg.brevo[k] = String(b[k]);
    }
    if (e && e.smtp_host) {
      cfg.email = {
        smtp_host: String(e.smtp_host ?? ''),
        smtp_port: Number(e.smtp_port ?? 465),
        smtp_user: String(e.smtp_user ?? ''),
        smtp_password: String(e.smtp_password ?? ''),
        sender_email: String(e.sender_email ?? ''),
        sender_name: String(e.sender_name ?? ''),
        use_ssl: Boolean(e.use_ssl ?? true),
        use_tls: Boolean(e.use_tls ?? false),
        cart_url: String(e.cart_url ?? ''),
      };
    }
    if (mk && typeof mk === 'object') {
      const ar = (mk.abandonment_recovery || mk) as Record<string, unknown>;
      for (const [k, fk] of [
        ['discount_priority', 'discount_priority'],
        ['urgency_cta', 'urgency_cta'],
        ['overlay_text', 'overlay_text'],
      ] as const) {
        if (ar[k] !== undefined && ar[k] !== null) (cfg.marketing as unknown as Record<string, unknown>)[fk] = Boolean(ar[k]);
      }
      const sw = (ar.send_window || {}) as Record<string, unknown>;
      if (sw.start) cfg.marketing.send_window_start = String(sw.start);
      if (sw.end) cfg.marketing.send_window_end = String(sw.end);
      const ir = (ar.image_requirements || {}) as Record<string, unknown>;
      if (ir.main_text) cfg.marketing.image_main_text = String(ir.main_text);
      if (ir.cta_button) cfg.marketing.cta_button = String(ir.cta_button);
      if (ir.style) cfg.marketing.image_style = String(ir.style);
    }
    if (d && d.input_file) cfg.input_file = String(d.input_file);
  } else {
    const dsKey = process.env.CARTBACK_DEEPSEEK_KEY;
    if (dsKey) cfg.deepseek = { api_key: dsKey, model: 'deepseek-chat', base_url: 'https://api.deepseek.com' };
    cfg.source = 'env+defaults';
  }

  applyEnv(cfg);
  applyNodeInjection(cfg, opts.aiConfig ?? null);
  return cfg;
}

export const BACKEND_DIR = BACKEND_ROOT;
export const OS_PLATFORM = os.platform();
