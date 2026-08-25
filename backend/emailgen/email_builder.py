"""HTML 邮件合成模块

复用原 email_builder 的结构，同时新增：
- `use_cid`：邮件内嵌图片时用 cid:hero-image（供 Node 发送端用）
- `build_preview_card()`：给前端 MailView 预览用的精简版 HTML（避免内嵌 CID 在 HTTP 预览里加载失败）
- 严格 HTML 转义，防止主题/正文里的特殊字符破坏模板

注意：兼容 Python 3.9 —— f-string 的 {expr} 里禁止任何反斜杠，所以所有带 `\n` / `\"`
      的拼接必须先在 f-string 外面做好再以变量形式引用。
"""
from __future__ import annotations

import html
from typing import Optional


def _safe(s):
    return html.escape(str(s or ""), quote=True)


def build_email_html(
    subject,
    body,
    image_url,
    cart_url,
    brand_name="CartBack",
    discount=None,
    cta_text="Shop Now",
    use_cid=False,
):
    """合成完整 HTML 邮件。

    use_cid=True 时图片 src 固定为 cid:hero-image（发送端以 inline attachment 注入）。
    预览场景应使用 use_cid=False 且 image_url 传可访问的 /api/image/... HTTP 地址。
    """
    if discount is None:
        discount_str = ""
    else:
        try:
            pct = int(discount) if float(discount).is_integer() else discount
            discount_str = "%s%% OFF" % (pct,)
        except (TypeError, ValueError):
            discount_str = ""

    # CID 模式：图片 src 用 cid:hero-image；否则用转义后的外部 URL
    if use_cid:
        img_src = "cid:hero-image"
        img_tag = '<img src="cid:hero-image" alt="%s - %s" />' % (
            html.escape(discount_str, quote=True),
            html.escape(str(brand_name or ""), quote=True),
        )
    else:
        iu = str(image_url or "")
        if iu:
            img_tag = '<img src="%s" alt="%s - %s" />' % (
                html.escape(iu, quote=True),
                html.escape(discount_str, quote=True),
                html.escape(str(brand_name or ""), quote=True),
            )
        else:
            img_tag = ""

    # 正文换行转 <br>（在 f-string 外处理，避免 Python 3.9 f-string 反斜杠限制）
    body_html = _safe(body).replace("\r\n", "\n").replace("\n", "<br>\n")

    subject_safe = _safe(subject)
    brand_safe = _safe(brand_name)
    cta_safe = _safe(cta_text)
    cart_safe = _safe(cart_url)
    copy_year = "2026"

    tmpl = (
        '<!DOCTYPE html>\n'
        '<html lang="en">\n'
        '<head>\n'
        '  <meta charset="UTF-8">\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        '  <title>%(subject)s</title>\n'
        '  <style>\n'
        '    * { margin: 0; padding: 0; box-sizing: border-box; }\n'
        "    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; }\n"
        '    .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }\n'
        '    .email-header { background-color: #1a1a1a; padding: 20px; text-align: center; }\n'
        '    .email-header .brand { color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: 1px; }\n'
        '    .email-hero { width: 100%%; display: block; background-color: #f0f0f0; }\n'
        '    .email-hero img { width: 100%%; height: auto; max-width: 600px; object-fit: cover; display: block; border: 0; }\n'
        '    .email-body { padding: 30px 25px; }\n'
        '    .email-subject { font-size: 20px; font-weight: 600; color: #1a1a1a; margin-bottom: 16px; line-height: 1.4; }\n'
        '    .email-text { font-size: 15px; color: #444444; line-height: 1.7; margin-bottom: 24px; white-space: normal; }\n'
        '    .cta-button { display: inline-block; background-color: #ff6b35; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; margin: 16px 0; }\n'
        '    .email-footer { background-color: #f9f9f9; padding: 20px 25px; text-align: center; border-top: 1px solid #eeeeee; }\n'
        '    .email-footer p { font-size: 12px; color: #999999; line-height: 1.6; }\n'
        '    .email-footer a { color: #999999; text-decoration: none; }\n'
        '    @media (max-width: 480px) {\n'
        '      .email-container { width: 100%% !important; }\n'
        '      .email-body { padding: 20px 16px; }\n'
        '      .cta-button { display: block; padding: 14px; }\n'
        '    }\n'
        '  </style>\n'
        '</head>\n'
        '<body>\n'
        '  <div class="email-container">\n'
        '    <div class="email-header">\n'
        '      <div class="brand">%(brand)s</div>\n'
        '    </div>\n'
        '    <div class="email-hero">\n'
        '      %(img_tag)s\n'
        '    </div>\n'
        '    <div class="email-body">\n'
        '      <h2 class="email-subject">%(subject)s</h2>\n'
        '      <div class="email-text">%(body_html)s</div>\n'
        '      <div style="text-align: center;">\n'
        '        <a href="%(cart)s" class="cta-button">%(cta)s</a>\n'
        '      </div>\n'
        '    </div>\n'
        '    <div class="email-footer">\n'
        '      <p>&copy; %(year)s %(brand)s. All rights reserved.<br>\n'
        '      This email was sent because you left items in your cart.<br>\n'
        '      <a href="%(cart)s">Unsubscribe</a> &middot; <a href="%(cart)s">View in browser</a></p>\n'
        '    </div>\n'
        '  </div>\n'
        '</body>\n'
        '</html>\n'
    )
    return tmpl % {
        "subject": subject_safe,
        "brand": brand_safe,
        "img_tag": img_tag,
        "body_html": body_html,
        "cart": cart_safe,
        "cta": cta_safe,
        "year": copy_year,
    }


def build_preview_card(
    subject,
    body,
    image_http_url,
    cart_url,
    brand_name="CartBack",
    discount=None,
    cta_text="Shop Now",
):
    """给前端预览卡片使用（图片直接用 HTTP URL，不使用 CID）。"""
    return build_email_html(
        subject=subject,
        body=body,
        image_url=image_http_url,
        cart_url=cart_url,
        brand_name=brand_name,
        discount=discount,
        cta_text=cta_text,
        use_cid=False,
    )


def build_simple_email(
    subject,
    body,
    image_url,
    cart_url,
    brand_name,
    discount=None,
    use_cid=False,
):
    """简单别名（与原版 API 兼容）"""
    return build_email_html(
        subject=subject,
        body=body,
        image_url=image_url,
        cart_url=cart_url,
        brand_name=brand_name,
        discount=discount,
        use_cid=use_cid,
    )
