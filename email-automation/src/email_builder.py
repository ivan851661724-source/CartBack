"""HTML 邮件合成模块"""
from pathlib import Path
from typing import Optional


def build_email_html(
    subject: str,
    body: str,
    image_url: str,
    cart_url: str,
    brand_name: str = "Leo's PhoneCase",
    discount: Optional[float] = None,
    cta_text: str = "Shop Now",
    use_cid: bool = False,
) -> str:
    """合成 HTML 邮件

    Args:
        subject: 邮件主题
        body: 邮件正文文案
        image_url: 图片 URL 或本地路径（use_cid=True 时 path 被忽略，固定用 cid:hero-image）
        cart_url: 购物车/商品链接
        brand_name: 品牌名称
        discount: 折扣百分比
        cta_text: CTA 按钮文字
        use_cid: True=使用 CID 内嵌图片，False=使用外部 URL
    """
    discount_str = f"{int(discount)}% OFF" if discount else ""
    # CID 模式：图片 src 用 cid:hero-image（邮件发送时作为 inline attachment 嵌入）
    img_src = "cid:hero-image" if use_cid else image_url

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; }}
    .email-container {{ max-width: 600px; margin: 0 auto; background-color: #ffffff; }}
    .email-header {{ background-color: #1a1a1a; padding: 20px; text-align: center; }}
    .email-header .brand {{ color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: 1px; }}
    .email-hero {{ width: 100%; display: block; }}
    .email-hero img {{ width: 100%; height: auto; max-width: 600px; object-fit: cover; }}
    .email-body {{ padding: 30px 25px; }}
    .email-subject {{ font-size: 20px; font-weight: 600; color: #1a1a1a; margin-bottom: 16px; line-height: 1.4; }}
    .email-text {{ font-size: 15px; color: #444444; line-height: 1.7; margin-bottom: 24px; white-space: pre-wrap; }}
    .cta-button {{ display: inline-block; background-color: #ff6b35; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; margin: 16px 0; }}
    .email-footer {{ background-color: #f9f9f9; padding: 20px 25px; text-align: center; border-top: 1px solid #eeeeee; }}
    .email-footer p {{ font-size: 12px; color: #999999; line-height: 1.6; }}
    .email-footer a {{ color: #999999; text-decoration: none; }}
    @media (max-width: 480px) {{
      .email-container {{ width: 100% !important; }}
      .email-body {{ padding: 20px 16px; }}
      .cta-button {{ display: block; padding: 14px; }}
    }}
  </style>
</head>
<body>
  <div class="email-container">
    <!-- Header -->
    <div class="email-header">
      <div class="brand">{brand_name}</div>
    </div>

    <!-- Hero Image -->
    <div class="email-hero">
      <img src="{img_src}" alt="{discount_str} - {brand_name}" />
    </div>

    <!-- Body -->
    <div class="email-body">
      <h2 class="email-subject">{subject}</h2>
      <div class="email-text">{body}</div>

      <!-- CTA Button -->
      <div style="text-align: center;">
        <a href="{cart_url}" class="cta-button">{cta_text}</a>
      </div>
    </div>

    <!-- Footer -->
    <div class="email-footer">
      <p>© 2025 {brand_name}. All rights reserved.<br>
      This email was sent because you left items in your cart.<br>
      <a href="{cart_url}">Unsubscribe</a> · <a href="{cart_url}">View in browser</a></p>
    </div>
  </div>
</body>
</html>"""
    return html


def build_simple_email(
    subject: str,
    body: str,
    image_url: str,
    cart_url: str,
    brand_name: str,
    discount: float,
    use_cid: bool = False,
) -> str:
    """简化版邮件（用于预览）"""
    return build_email_html(
        subject=subject,
        body=body,
        image_url=image_url,
        cart_url=cart_url,
        brand_name=brand_name,
        discount=discount,
        use_cid=use_cid,
    )
