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
}

function discountStr(discount: Optional<number>): string {
  if (discount == null) return '';
  const n = Number(discount);
  if (Number.isNaN(n)) return '';
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
    cta_text = 'Shop Now',
    use_cid = false,
  } = opts;

  const dStr = discountStr(discount);

  let imgTag: string;
  if (use_cid) {
    imgTag = `<img src="cid:hero-image" alt="${escapeHtml(dStr)} - ${escapeHtml(brand_name)}" />`;
  } else {
    const iu = safeStr(image_url);
    if (iu) {
      imgTag = `<img src="${escapeHtml(iu)}" alt="${escapeHtml(dStr)} - ${escapeHtml(brand_name)}" />`;
    } else {
      imgTag = '';
    }
  }

  const bodyHtml = escapeHtml(body)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>\n');

  const subjectSafe = escapeHtml(subject);
  const brandSafe = escapeHtml(brand_name);
  const ctaSafe = escapeHtml(cta_text);
  const cartSafe = escapeHtml(cart_url);
  const copyYear = '2026';

  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `  <title>${subjectSafe}</title>\n` +
    '  <style>\n' +
    '    * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    "    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; }\n" +
    '    .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }\n' +
    '    .email-header { background-color: #1a1a1a; padding: 20px; text-align: center; }\n' +
    '    .email-header .brand { color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: 1px; }\n' +
    '    .email-hero { width: 100%; display: block; background-color: #f0f0f0; }\n' +
    '    .email-hero img { width: 100%; height: auto; max-width: 600px; object-fit: cover; display: block; border: 0; }\n' +
    '    .email-body { padding: 30px 25px; }\n' +
    '    .email-subject { font-size: 20px; font-weight: 600; color: #1a1a1a; margin-bottom: 16px; line-height: 1.4; }\n' +
    '    .email-text { font-size: 15px; color: #444444; line-height: 1.7; margin-bottom: 24px; white-space: normal; }\n' +
    '    .cta-button { display: inline-block; background-color: #ff6b35; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; margin: 16px 0; }\n' +
    '    .email-footer { background-color: #f9f9f9; padding: 20px 25px; text-align: center; border-top: 1px solid #eeeeee; }\n' +
    '    .email-footer p { font-size: 12px; color: #999999; line-height: 1.6; }\n' +
    '    .email-footer a { color: #999999; text-decoration: none; }\n' +
    '    @media (max-width: 480px) {\n' +
    '      .email-container { width: 100% !important; }\n' +
    '      .email-body { padding: 20px 16px; }\n' +
    '      .cta-button { display: block; padding: 14px; }\n' +
    '    }\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="email-container">\n' +
    '    <div class="email-header">\n' +
    `      <div class="brand">${brandSafe}</div>\n` +
    '    </div>\n' +
    '    <div class="email-hero">\n' +
    `      ${imgTag}\n` +
    '    </div>\n' +
    '    <div class="email-body">\n' +
    `      <h2 class="email-subject">${subjectSafe}</h2>\n` +
    `      <div class="email-text">${bodyHtml}</div>\n` +
    '      <div style="text-align: center;">\n' +
    `        <a href="${cartSafe}" class="cta-button">${ctaSafe}</a>\n` +
    '      </div>\n' +
    '    </div>\n' +
    '    <div class="email-footer">\n' +
    `      <p>&copy; ${copyYear} ${brandSafe}. All rights reserved.<br>\n` +
    '      This email was sent because you left items in your cart.<br>\n' +
    `      <a href="${cartSafe}">Unsubscribe</a> &middot; <a href="${cartSafe}">View in browser</a></p>\n` +
    '    </div>\n' +
    '  </div>\n' +
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
