/**
 * 用户/受众记录数据模型
 *
 * 集成进 CartBack 后，邮件草稿由 IGDE Agent 方案卡产出（subject/body/discount/audience/brand 等），
 * 受众画像信息可能不全，这里把所有字段都做成可空默认值，并新增 from_plan_card() 工厂函数。
 * 端口自 Python emailgen/data_loader.py。
 */
import * as fs from 'fs';
import * as readline from 'readline';

export interface UserRecord {
  user_id: string;
  email: string;
  brand: string;
  gender: string; // M / F / O
  age_range: string;
  device: string;
  product: string;
  product_cn: string;
  product_en: string;
  discount: number;
  goal: string;
  send_window: string;
  locale: string;
  preferred_language: string;
  price_sensitivity: string;
  customer_segment: string;
  style_preference: string; // tech / fashion / business / outdoor（受众风格品类标签代表值）
  cart_url: string;
  raw: Record<string, unknown>;
}

function strVal(v: unknown, def = ''): string {
  if (v === undefined || v === null) return def;
  return String(v);
}

/** 稳定字符串哈希（Python 侧用 hash()，进程随机；此处用确定性哈希做兜底 uid） */
function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 标签分布快照取某类 count 最高的代表值（tagDistribution 已按 count 降序，同 type 首条即最高）。 */
function topTagByType(dist: unknown, type: string): string {
  if (!Array.isArray(dist)) return '';
  for (const item of dist) {
    if (item && typeof item === 'object' && String((item as Record<string, unknown>).tag_type || '') === type) {
      return String((item as Record<string, unknown>).tag_value || '').trim();
    }
  }
  return '';
}

export function fromPlanCard(card: Record<string, unknown>, draft?: Record<string, unknown> | null): UserRecord {
  const d = draft || {};
  const discountRaw = (card.discount ?? d.discount ?? 8) as number | string;
  let discount = 8;
  const parsed = Number(discountRaw);
  if (!Number.isNaN(parsed)) discount = parsed; // 非数字 → 维持默认 8（对应 Python 的 except → 8.0）

  const audience = strVal(card.audience).trim();
  let locale = strVal(card.locale ?? d.locale, 'en').trim();
  if (locale.length === 2) locale = `${locale}-${locale.toUpperCase()}`;
  const preferredLanguage = strVal(card.preferred_language ?? d.preferred_language).trim();
  const productEn = strVal(card.product ?? card.product_en, 'Premium Phone Case').trim();
  const productCn = strVal(card.product_cn).trim();
  const brandRaw = strVal(card.brand ?? d.brand, 'CartBack').trim();
  const brand = brandRaw || 'CartBack';
  const cartUrl = strVal(card.cart_url ?? d.cart_url, 'https://cartback.demo').trim();
  const uid = strVal(d.id ?? card.id) || `dr_${String(stableHash(audience + brand) % 1_000_000).padStart(6, '0')}`;

  // 受众标签分布快照（server.js 传入）：每类取 count 最高代表值填充画像——
  // 此前恒为硬编码默认值（O/25-34/iPhone/空），新 5 维标签实际没进文案与图片 prompt
  const dist = card.tag_distribution ?? d.tag_distribution;
  const tagGender = topTagByType(dist, 'gender');
  const tagAge = topTagByType(dist, 'age_range');
  const tagDevice = topTagByType(dist, 'device');

  return {
    user_id: uid,
    email: '',
    brand,
    product_en: productEn,
    product_cn: productCn,
    product: productEn,
    discount,
    locale,
    preferred_language: preferredLanguage,
    cart_url: cartUrl,
    gender: tagGender === 'male' ? 'M' : tagGender === 'female' ? 'F' : 'O',
    age_range: tagAge || '25-34',
    device: tagDevice || 'iPhone',
    goal: 'abandonment_recovery',
    send_window: '10:30-21:00',
    price_sensitivity: topTagByType(dist, 'price_sensitivity'),
    customer_segment: topTagByType(dist, 'customer_segment'),
    style_preference: topTagByType(dist, 'style_preference'),
    raw: { ...card, draft: d },
  };
}

/** 构造一个可完全自定义字段的 UserRecord（selftest5 用，绕过 from_plan_card） */
export function makeUser(overrides: Record<string, unknown>): UserRecord {
  const base: UserRecord = {
    user_id: 'anon',
    email: '',
    brand: 'CartBack',
    gender: 'O',
    age_range: '25-34',
    device: 'iPhone',
    product: '',
    product_cn: '',
    product_en: '',
    discount: 8,
    goal: 'abandonment_recovery',
    send_window: '10:30-21:00',
    locale: 'en-US',
    preferred_language: '',
    price_sensitivity: '',
    customer_segment: '',
    style_preference: '',
    cart_url: 'https://cartback.demo',
    raw: {},
  };
  for (const k of Object.keys(overrides)) {
    const v = overrides[k];
    if (v !== undefined && k in base) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

export interface JsonlLoadResult {
  records: UserRecord[];
  warnings: string[];
}

/** 逐行加载 JSONL（保留原版能力，便于批量生成场景） */
export async function loadUserData(filePath: string): Promise<JsonlLoadResult> {
  if (!fs.existsSync(filePath)) throw new Error(`用户数据文件不存在: ${filePath}`);
  const records: UserRecord[] = [];
  const warnings: string[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed);
      records.push({
        user_id: strVal(data.user_id, `unknown_${lineNum}`),
        email: strVal(data.email),
        brand: strVal(data.brand, 'CartBack'),
        gender: strVal(data.gender, 'O'),
        age_range: strVal(data.age_range, '25-34'),
        device: strVal(data.device, 'iPhone'),
        product: strVal(data.product),
        product_cn: strVal(data.product_cn),
        product_en: strVal(data.product_en ?? data.product),
        discount: Number(data.discount ?? 0) || 0,
        goal: strVal(data.goal, 'abandonment_recovery'),
        send_window: strVal(data.send_window, '10:30-21:00'),
        locale: strVal(data.locale, 'en-US'),
        preferred_language: strVal(data.preferred_language),
        style_preference: strVal(data.style_preference),
        price_sensitivity: strVal(data.price_sensitivity),
        customer_segment: strVal(data.customer_segment),
        cart_url: strVal(data.cart_url, 'https://cartback.demo'),
        raw: data,
      });
    } catch (e) {
      warnings.push(`第 ${lineNum} 行 JSON 解析失败: ${(e as Error).message}`);
    }
  }
  return { records, warnings };
}

export function countUsers(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (line.trim()) count++;
  }
  return count;
}
