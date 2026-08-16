#!/usr/bin/env python3
"""CartBack 邮件生成服务 — 供 Node.js 后端调用
用法: echo '{"subject":"...","body":"...","discount":8,"brand":"...","audience":"..."}' | python3 mailgen.py
输出: {"html":"...","image_path":"/path/to/image.png","success":true}
"""
import sys
import os
import json
import time
import requests
from pathlib import Path

# 确保 email-automation 的 src 在路径中
EMAIL_AUTO = os.path.expanduser("~/email-automation")
sys.path.insert(0, os.path.join(EMAIL_AUTO, "src"))
sys.path.insert(0, EMAIL_AUTO)  # config.py 在根目录

from image_generator import download_image
from image_overlay import overlay_marketing_text
from email_builder import build_email_html


def generate_image(discount: float, brand: str, cta: str = "Shop Now") -> str:
    """生成营销图片，叠加文字，返回本地路径"""
    prompt = (
        "High-quality e-commerce marketing email hero image of a premium phone case, "
        "sleek modern smartphone case product photography, "
        "bright clean studio lighting, soft gradient background, "
        "professional brand aesthetic, newsletter banner style, "
        "8K detailed, no text overlay in the image, best quality"
    )
    encoded = requests.utils.quote(prompt)
    url = f"https://image.pollinations.ai/prompt/{encoded}?width=1200&height=1500&seed={int(time.time())%100000}&nologo=true"

    local = download_image(url, f"cartback_{int(time.time())}")
    if not local:
        return ""

    final = overlay_marketing_text(
        image_path=local,
        discount=discount,
        brand_name=brand,
        cta_text=cta,
    )
    return final


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"success": False, "error": f"JSON parse error: {e}"}))
        return

    subject = data.get("subject", "")
    body = data.get("body", "")
    discount = float(data.get("discount", 8))
    brand = data.get("brand", "CartBack")
    audience = data.get("audience", "")
    cart_url = data.get("cart_url", "https://example.com")
    cta = data.get("cta", "Shop Now")

    # 生成图片
    image_path = ""
    try:
        image_path = generate_image(discount, brand, cta)
    except Exception as e:
        print(f"[mailgen] 图片生成失败: {e}", file=sys.stderr)

    # 构建 HTML
    use_cid = bool(image_path and os.path.exists(image_path))
    html = build_email_html(
        subject=subject,
        body=body,
        image_url=image_path,
        cart_url=cart_url,
        brand_name=brand,
        discount=discount,
        use_cid=use_cid,
    )

    result = {
        "success": True,
        "html": html,
        "image_path": image_path if use_cid else "",
        "subject": subject,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()