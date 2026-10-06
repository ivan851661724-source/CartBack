/**
 * HTML 邮件合成模块
 *
 * 端口自 Python emailgen/email_builder.py，模板逐字节保留：
 *  - use_cid：邮件内嵌图片时用 cid:hero-image（发送端以 inline attachment 注入）
 *  - 预览场景用 use_cid=false 且 image_url 传 /api/image/... 可访问的 HTTP 地址
 *  - 严格 HTML 转义（等价 Python html.escape(s, quote=True)）
 */
type Optional<T> = T | null | undefined;

/** 等价 Python html.escape(str, quote=True)：& < > " ' 全转义，& 最先 */
export function escapeHtml(input: unknown): string {
  const s = input == null ? '' : String(input);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function safeStr(s: unknown): string {
  return s == null ? '' : String(s);
}

export interface BuildEmailHtmlOpts {
  subject: unknown;
  body: unknown;
  image_url: unknown;
  cart_url: unknown;
  brand_name?: unknown;
  discount?: Optional<number>;
  cta_text?: unknown;
  use_cid?: boolean;
  /** 图片可点击跳转的目标 URL（产品页/购物车页）；为空则图片不可点击 */
  image_link?: unknown;
  /** 收件人习惯语言（preferred_language），用于本地化「点击图片下单」提示与落款 */
  lang?: unknown;
  /** 页脚 Unsubscribe 热区链接（为空回退 cart_url）；邮件合规要求的真实退订入口 */
  unsubscribe_url?: unknown;
  /** 页脚 View in browser 热区链接（为空回退 cart_url）：浏览器内查看整封邮件 */
  view_url?: unknown;
  /** preheader（收件箱预览行）：空则取正文首句截断 */
  preheader?: unknown;
}

// 「点击图片下单」提示 + 落款，按 preferred_language 本地化（无匹配则中文兜底）
const PROMPT_BY_LANG: Record<string, string> = {
  english: 'Tap the image above to pick up where you left off.',
  spanish: 'Toca la imagen de arriba para continuar con tu pedido.',
  german: 'Tippe auf das Bild oben, um deinen Einkauf abzuschließen.',
  french: "Touchez l'image ci-dessus pour reprendre votre commande.",
  italian: "Tocca l'immagine sopra per completare l'ordine.",
  chinese: '点击上方图片，立即回到购物车完成下单。',
};
const SIGNATURE_BY_LANG: Record<string, string> = {
  english: 'The {brand} Team',
  spanish: 'El equipo de {brand}',
  german: 'Das {brand}-Team',
  french: "L'équipe {brand}",
  italian: 'Il team di {brand}',
  chinese: '{brand} 团队',
};

// locale 码 → 语言全称（preferred_language 可能是全称如 "English"，也可能只传 locale 如 "en"/"en-US"）
const LOCALE_TO_LANG: Record<string, string> = {
  en: 'english', 'en-us': 'english', 'en-gb': 'english', 'en-au': 'english', 'en-ca': 'english',
  es: 'spanish', 'es-es': 'spanish', 'es-mx': 'spanish',
  de: 'german', 'de-de': 'german',
  fr: 'french', 'fr-fr': 'french', 'fr-ca': 'french',
  it: 'italian', 'it-it': 'italian',
  zh: 'chinese', 'zh-cn': 'chinese', 'zh-tw': 'chinese',
};
function resolveLangKey(lang: string): string {
  const k = (lang || '').toLowerCase().trim();
  if (!k) return 'chinese';
  if (PROMPT_BY_LANG[k]) return k; // 全称直接命中
  if (LOCALE_TO_LANG[k]) return LOCALE_TO_LANG[k]; // locale 码映射
  // 处理 "en-US" 这类带连字符的：取主语言
  const main = k.split(/[-_]/)[0];
  return LOCALE_TO_LANG[main] || 'chinese';
}

function discountStr(discount: Optional<number>): string {
  if (discount == null) return '';
  const n = Number(discount);
  // 0 = 无钩子方案：不得产生「0% OFF」假折扣文案（正文徽标与 img alt 同源此函数）
  if (Number.isNaN(n) || n <= 0) return '';
  // Python: int(discount) if float(discount).is_integer() else discount
  const pct = Number.isInteger(n) ? n : n;
  return `${pct}% OFF`;
}

export function buildEmailHtml(opts: BuildEmailHtmlOpts): string {
  const {
    subject,
    body,
    image_url,
    cart_url,
    brand_name = 'CartBack',
    discount = null,
    use_cid = false,
    image_link = '',
    lang = '',
    unsubscribe_url = '',
    view_url = '',
    preheader = '',
  } = opts;

  const dStr = discountStr(discount);
  // 无折扣时 alt 只用品牌名，不留「 - 品牌」残缺格式
  const imgAlt = [dStr, safeStr(brand_name)].filter(Boolean).join(' - ');

  let imgTag: string;
  if (use_cid) {
    imgTag = `<img src="cid:hero-image" alt="${escapeHtml(imgAlt)}" style="width:100%;height:auto;max-width:600px;display:block;border:0;" />`;
  } else {
    const iu = safeStr(image_url);
    if (iu) {
      imgTag = `<img src="${escapeHtml(iu)}" alt="${escapeHtml(imgAlt)}" style="width:100%;height:auto;max-width:600px;display:block;border:0;" />`;
    } else {
      imgTag = '';
    }
  }
  // 图片可点击跳转独立站产品页（正文内联 + 可点击）
  const link = safeStr(image_link);
  if (imgTag && link) {
    imgTag = `<a href="${escapeHtml(link)}">${imgTag}</a>`;
  }

  // 按习惯语言本地化「点击图片下单」提示与落款
  const langKey = resolveLangKey(safeStr(lang));
  const brandSafeForSig = escapeHtml(brand_name);
  const promptText = PROMPT_BY_LANG[langKey] ?? PROMPT_BY_LANG.chinese;
  const signatureText = (SIGNATURE_BY_LANG[langKey] ?? SIGNATURE_BY_LANG.chinese).replace(
    '{brand}',
    brandSafeForSig,
  );

  const bodyHtml = escapeHtml(body)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>\n');

  const subjectSafe = escapeHtml(subject);
  const brandSafe = escapeHtml(brand_name);
  const cartSafe = escapeHtml(cart_url);
  // 页脚热区：Unsubscribe / View in browser 指向真实入口（为空回退 cart_url，保持旧行为）
  const unsubSafe = escapeHtml(safeStr(unsubscribe_url)) || cartSafe;
  const viewSafe = escapeHtml(safeStr(view_url)) || cartSafe;
  const copyYear = '2026';

  // M8 preheader：收件箱预览行（正文首句截断）
  const bodyPlain = String(body ?? '').replace(/\s+/g, ' ').trim();
  const preheaderText = escapeHtml(safeStr(preheader) || bodyPlain.slice(0, 90));

  // M7 邮件客户端兼容：table(role=presentation) + 全 inline style（Outlook Word 引擎不解析 <style>）。
  // 视觉与旧 div 版 1:1 平移：600px 白卡、#f5f5f5 页面底、同字号/行高/配色。
  const FONT =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `  <title>${subjectSafe}</title>\n` +
    '</head>\n' +
    '<body style="margin:0;padding:0;background-color:#f5f5f5;">\n' +
    // preheader：隐藏预览行（mso-hide:all 兼容 Outlook）
    `  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheaderText}</div>\n` +
    '  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;">\n' +
    '    <tr><td align="center" style="padding:24px 12px;">\n' +
    '      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;">\n' +
    // 主体（标题 + 正文）在图片之前（正文样式并入 td，整封信只有 preheader 一个 div）
    '        <tr><td style="padding:30px 25px 0;font-family:' + FONT + ';font-size:15px;color:#444444;line-height:1.7;">\n' +
    `          <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#1a1a1a;line-height:1.4;">${subjectSafe}</h2>\n` +
    `          ${bodyHtml}\n` +
    '        </td></tr>\n' +    // 图片（可点击，作为 CTA）
    '        <tr><td style="padding:24px 0 0;background-color:#f0f0f0;">\n' +
    `          ${imgTag}\n` +
    '        </td></tr>\n' +
    // 「点击图片下单」提示 + 落款 在图片之后
    '        <tr><td style="padding:0 25px 20px;font-family:' + FONT + ';">\n' +
    `          <p style="margin:20px 0 10px;font-size:15px;font-weight:600;color:#ff6b35;line-height:1.7;">${promptText}</p>\n` +
    `          <p style="margin:0;font-size:14px;color:#888888;line-height:1.6;">${signatureText}</p>\n` +
    '        </td></tr>\n' +
    '        <tr><td style="background-color:#f9f9f9;border-top:1px solid #eeeeee;padding:20px 25px;text-align:center;font-family:' + FONT + ';">\n' +
    `          <p style="margin:0;font-size:12px;color:#999999;line-height:1.6;">&copy; ${copyYear} ${brandSafe}. All rights reserved.<br>\n` +
    '          This email was sent because you left items in your cart.<br>\n' +
    `          <a href="${unsubSafe}" style="color:#999999;text-decoration:none;">Unsubscribe</a> &middot; <a href="${viewSafe}" style="color:#999999;text-decoration:none;">View in browser</a></p>\n` +
    '        </td></tr>\n' +
    '      </table>\n' +
    '    </td></tr>\n' +
    '  </table>\n' +
    '</body>\n' +
    '</html>\n'
  );
}

export function buildPreviewCard(opts: Omit<BuildEmailHtmlOpts, 'use_cid'>): string {
  return buildEmailHtml({ ...opts, use_cid: false });
}

export function buildSimpleEmail(opts: BuildEmailHtmlOpts): string {
  return buildEmailHtml(opts);
}
