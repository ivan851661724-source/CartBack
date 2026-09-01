/**
 * CartBack 邮件生成服务 v3（Node.js / TypeScript）
 *
 * 端口自 Python scripts/mailgen.py（基于本地 emailgen 包）。
 * 供 Node.js backend/server.js 同进程调用：`require('./dist/mailgen').run(payload)`
 *
 * stdout 契约（CLI 模式）：只在 stdout 打一行 JSON，Node 端解析最后一个 JSON 对象。
 * debug：`node dist/mailgen.js --selftest` / `--selftest5 [--with-image]` 免密钥自检。
 */
import * as path from 'path';
import * as os from 'os';

import { loadConfig, BACKEND_DIR } from './config';
import { fromPlanCard, makeUser, type UserRecord } from './data-loader';
import { generateCopy, type CopyResult } from './copy-generator';
import { generateProductImage } from './image-generator';
import { buildEmailHtml } from './email-builder';
import { MailgenPayloadSchema, type MailgenPayload } from './schema';

const OUTPUT_DIR = path.resolve(BACKEND_DIR, 'output', 'images');

export interface MailgenResult {
  success: boolean;
  html?: string;
  image_path?: string;
  subject?: string;
  body?: string;
  copy_provider?: string;
  image_method?: string;
  warnings?: string[] | null;
  config_source?: string;
  error?: string;
  [k: string]: unknown;
}

function emit(result: MailgenResult): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function formatG(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(6)));
}

export async function run(payloadIn: Record<string, unknown>): Promise<MailgenResult> {
  const warnings: string[] = [];

  // schema 校验（宽松：未知字段透传，已知字段类型规整）
  const parsed = MailgenPayloadSchema.parse(payloadIn) as MailgenPayload;
  const payload = parsed as Record<string, unknown>;

  // 1. 配置
  const aiConfig = (payload.ai_config ?? null) as MailgenPayload['ai_config'] | null;
  const cfg = loadConfig({ aiConfig: (aiConfig as never) ?? null });

  // 2. UserRecord
  const draft = (payload.draft ?? null) as MailgenPayload['draft'] | null;
  let user: UserRecord;
  try {
    user = fromPlanCard(payload, (draft as Record<string, unknown>) ?? null);
  } catch (e) {
    return { success: false, error: `构造 UserRecord 失败: ${(e as Error).message}`, warnings };
  }

  // 3. 文案
  const forceRegen = Boolean(payload.force_regen_copy);
  let existing: { subject?: string; body?: string } | null = null;
  if (payload.subject || payload.body) {
    existing = { subject: String(payload.subject ?? ''), body: String(payload.body ?? '') };
  }
  let copy: CopyResult;
  try {
    copy = await generateCopy(cfg, user, { forceRegenerate: forceRegen, existing });
  } catch (e) {
    warnings.push(`文案生成异常，兜底使用原 subject/body：${(e as Error).message}`);
    copy = {
      subject: String(payload.subject || `${user.brand} — 你的专属福利`),
      body: String(payload.body || '点击按钮，回到购物车完成下单。'),
      provider: 'error_fallback',
      regenerated: false,
      user_id: user.user_id,
      email: user.email,
      discount: user.discount,
    };
  }

  const subject = copy.subject || String(payload.subject || '');
  const body = copy.body || String(payload.body || '');
  const copyProvider = copy.provider || 'unknown';

  // 4. 图片
  const skipImage = Boolean(payload.skip_image);
  let imageMethod = 'skip';
  let imagePath = '';
  if (!skipImage) {
    try {
      imagePath = await generateProductImage({
        config: cfg,
        user,
        productImagePath: (payload.product_image_path as string) || null,
        skip: false,
        outputDir: OUTPUT_DIR,
      });
      if (imagePath) {
        const qvReady = Boolean(cfg.qianwen_vision.api_key && cfg.qianwen_vision.base_url);
        imageMethod = qvReady ? 'wanx' : 'pollinations';
        const baseName = path.basename(imagePath);
        if (baseName.includes('_final') && !qvReady) imageMethod = 'pollinations+overlay';
        else if (baseName.includes('_final')) imageMethod = 'wanx+overlay';
      } else {
        imageMethod = 'empty';
        warnings.push('图片生成全部降级失败，返回空图（邮件里将只显示品牌头+文案+CTA）');
      }
    } catch (e) {
      imageMethod = 'error';
      warnings.push(`图片生成异常（非致命）: ${(e as Error).message}`);
      console.error(`[mailgen] image error: ${(e as Error).stack || (e as Error).message}`);
    }
  }

  // 5. HTML
  const useCid = false;
  let html: string;
  try {
    html = buildEmailHtml({
      subject,
      body,
      image_url: imagePath,
      cart_url: user.cart_url,
      brand_name: user.brand,
      discount: user.discount,
      cta_text: cfg.marketing.cta_button || 'Shop Now',
      use_cid: useCid,
    });
  } catch (e) {
    return {
      success: false,
      error: `HTML 合成失败: ${(e as Error).message}`,
      warnings,
      subject,
      body,
      copy_provider: copyProvider,
      image_method: imageMethod,
      image_path: imagePath,
    };
  }

  return {
    success: true,
    html,
    image_path: imagePath,
    subject,
    body,
    copy_provider: copyProvider,
    image_method: imageMethod,
    warnings: warnings.length ? warnings : null,
    config_source: cfg.source,
  };
}

// ---------------------------------------------------------------------------
// selftest / selftest5（与 Python 版 CLI 对齐，便于 CI / 本地自检）
// ---------------------------------------------------------------------------

const SELFTEST5_PROFILES: Array<Record<string, unknown> & { name: string }> = [
  {
    name: 'P1 美国Z世代时尚女大学生 — 闪钻冰透壳',
    user_id: 'st5_1', email: '', brand: 'Lumière', gender: 'F', age_range: '18-24',
    device: 'iPhone 15', product_en: 'Glitter Rhinestone Clear Case', product_cn: '闪钻冰透手机壳',
    product: 'Glitter Rhinestone Clear Case', discount: 15.0, goal: 'abandonment_recovery',
    locale: 'en-US', preferred_language: 'English', price_sensitivity: 'value', customer_segment: 'new',
    cart_url: 'https://cartback.demo/u1',
  },
  {
    name: 'P2 美国中年硬核科技男(西语裔) — 军工磁吸防摔壳',
    user_id: 'st5_2', email: '', brand: 'AegisGuard', gender: 'M', age_range: '35-44',
    device: 'iPhone 15 Pro Max', product_en: 'Rugged Armor MagSafe Case', product_cn: '军工磁吸防摔壳',
    product: 'Rugged Armor MagSafe Case', discount: 12.0, goal: 'abandonment_recovery',
    locale: 'en-US', preferred_language: 'Spanish', price_sensitivity: 'premium', customer_segment: 'returning',
    cart_url: 'https://cartback.demo/u2',
  },
  {
    name: 'P3 德国商务男士 — 真皮卡包翻盖壳',
    user_id: 'st5_3', email: '', brand: 'NordHülle', gender: 'M', age_range: '25-34',
    device: 'iPhone 14', product_en: 'Premium Leather Wallet Case', product_cn: '真皮卡包翻盖壳',
    product: 'Premium Leather Wallet Case', discount: 10.0, goal: 'abandonment_recovery',
    locale: 'de-DE', preferred_language: 'German', price_sensitivity: 'premium', customer_segment: 'vip',
    cart_url: 'https://cartback.demo/u3',
  },
  {
    name: 'P4 加拿大中年实用女(魁北克法语) — 简约透明软壳',
    user_id: 'st5_4', email: '', brand: 'MapleShell', gender: 'F', age_range: '45-54',
    device: 'iPhone 13', product_en: 'Simple Transparent Soft Case', product_cn: '简约透明软壳',
    product: 'Simple Transparent Soft Case', discount: 20.0, goal: 'abandonment_recovery',
    locale: 'en-CA', preferred_language: 'French', price_sensitivity: 'value', customer_segment: 'returning',
    cart_url: 'https://cartback.demo/u4',
  },
  {
    name: 'P5 澳洲年轻户外男(意裔) — 防水户外防护壳',
    user_id: 'st5_5', email: '', brand: 'OutbackGear AU', gender: 'M', age_range: '18-24',
    device: 'iPhone 15 Pro', product_en: 'Waterproof Rugged Outdoor Case', product_cn: '防水户外防护壳',
    product: 'Waterproof Rugged Outdoor Case', discount: 8.0, goal: 'abandonment_recovery',
    locale: 'en-AU', preferred_language: 'Italian', price_sensitivity: 'standard', customer_segment: 'new',
    cart_url: 'https://cartback.demo/u5',
  },
];

async function selftest(): Promise<number> {
  process.stderr.write(
    '[selftest] 开始邮件生成自检（无 AI Key，走 fallback 模板 + Pollinations 图片兜底）…\n',
  );
  const payload: Record<string, unknown> = {
    subject: '',
    body: '',
    discount: 12,
    brand: 'CartBack Selftest',
    audience: '加购未付的老客',
    cart_url: 'https://cartback.demo/selftest',
    locale: 'en-US',
    skip_image: true,
  };
  const r = await run(payload);
  if (!r.success) {
    process.stderr.write(`[selftest] ❌ 失败: ${JSON.stringify(r)}\n`);
    emit(r);
    return 2;
  }
  process.stderr.write(
    `[selftest] ✅ 成功。copy_provider=${r.copy_provider} ` +
      `image_method=${r.image_method} html_len=${(r.html || '').length} ` +
      `image_path=${r.image_path || '(empty)'}\n`,
  );
  emit(r);
  return 0;
}

async function selftest5(withImage: boolean): Promise<number> {
  let aiConfig: MailgenPayload['ai_config'] | null = null;
  const rawCfg = process.env.CARTBACK_AI_CONFIG;
  if (rawCfg) {
    try {
      aiConfig = JSON.parse(rawCfg);
    } catch (e) {
      process.stderr.write(`[selftest5] CARTBACK_AI_CONFIG JSON 解析失败: ${(e as Error).message}\n`);
    }
  }
  const cfg = loadConfig({ aiConfig: (aiConfig as never) ?? null });
  const hasAi = Boolean((cfg.deepseek && cfg.deepseek.api_key) || cfg.minimax.api_key);
  if (!hasAi) {
    process.stderr.write(
      '[selftest5] ⚠️ 未配置 AI 密钥，将走 _fallback_copy 模板（gender/age/device/goal/' +
        'preferred_language/price_sensitivity/customer_segment 不影响输出）。' +
        '请用环境变量 CARTBACK_AI_CONFIG 注入。\n',
    );
  } else {
    const prov = cfg.deepseek && cfg.deepseek.api_key ? 'deepseek' : 'minimax';
    const mdl = prov === 'deepseek' ? cfg.deepseek!.model : cfg.minimax.model;
    process.stderr.write(`[selftest5] AI 已配置 (provider=${prov}, model=${mdl})，开始 5 套画像测试…\n`);
  }

  const results: unknown[] = [];
  for (let i = 0; i < SELFTEST5_PROFILES.length; i++) {
    const p = SELFTEST5_PROFILES[i];
    const name = p.name;
    const user = makeUser(p);
    process.stderr.write(
      `[selftest5] (${i + 1}/5) ${name} — lang=${user.preferred_language || user.locale} ` +
        `price=${user.price_sensitivity || '-'} seg=${user.customer_segment || '-'} disc=${formatG(user.discount)}%\n`,
    );

    let subject = '';
    let body = '';
    let provider = 'unknown';
    try {
      const copy = await generateCopy(cfg, user, { forceRegenerate: true });
      subject = copy.subject || '';
      body = copy.body || '';
      provider = copy.provider || 'unknown';
    } catch (e) {
      provider = `error: ${(e as Error).message}`;
      process.stderr.write(`[selftest5]   文案生成失败: ${(e as Error).message}\n`);
    }

    let imageMethod = 'skip';
    let imagePath = '';
    if (withImage) {
      try {
        imagePath = await generateProductImage({
          config: cfg, user, skip: false, outputDir: OUTPUT_DIR,
        });
        const qv = Boolean(cfg.qianwen_vision.api_key && cfg.qianwen_vision.base_url);
        imageMethod = imagePath ? (qv ? 'wanx' : 'pollinations') : 'empty';
      } catch (e) {
        imageMethod = `error: ${(e as Error).message}`;
      }
    }

    let html: string;
    try {
      html = buildEmailHtml({
        subject, body, image_url: imagePath, cart_url: user.cart_url,
        brand_name: user.brand, discount: user.discount,
        cta_text: cfg.marketing.cta_button || 'Shop Now', use_cid: false,
      });
    } catch (e) {
      html = `<!-- HTML build failed: ${(e as Error).message} -->`;
    }

    results.push({
      name,
      tags: {
        gender: user.gender, age_range: user.age_range, device: user.device,
        brand: user.brand, product_en: user.product_en, product_cn: user.product_cn,
        discount: user.discount, goal: user.goal, locale: user.locale,
        preferred_language: user.preferred_language, price_sensitivity: user.price_sensitivity,
        customer_segment: user.customer_segment,
      },
      subject, body, copy_provider: provider, image_method: imageMethod,
      html_len: html.length, html,
    });
  }

  emit({ success: true, ai_on: hasAi, image_on: withImage, profiles: results });
  return 0;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest') {
    process.exit(await selftest());
  }
  if (argv[0] === '--selftest5') {
    const withImage = argv.includes('--with-image');
    process.exit(await selftest5(withImage));
  }

  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    emit({ success: false, error: `stdin JSON 解析失败: ${(e as Error).message}` });
    return;
  }
  let result: MailgenResult;
  try {
    result = await run(payload);
  } catch (e) {
    const tb = (e as Error).stack || String(e);
    process.stderr.write(`[mailgen] 未捕获异常:\n${tb}\n`);
    result = { success: false, error: `未预期错误: ${(e as Error).message}` };
  }
  emit(result);
}

// CLI 入口：直接运行 dist/mailgen.js 时才执行 main
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[mailgen] fatal: ${e && (e as Error).stack || e}\n`);
    process.exit(1);
  });
}

export const _platform = os.platform();
