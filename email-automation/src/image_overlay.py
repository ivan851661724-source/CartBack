"""图片叠加模块 - 用 Pillow 在营销图片上叠加文字和 CTA 按钮"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import os


def overlay_marketing_text(
    image_path: str,
    discount: float,
    brand_name: str = "Leo's PhoneCase",
    cta_text: str = "Shop Now",
    output_path: str = None,
) -> str:
    """在图片上叠加营销文字（折扣 + CTA 按钮 + 品牌名）

    Args:
        image_path: 原始图片路径
        discount: 折扣百分比
        brand_name: 品牌名
        cta_text: CTA 按钮文字
        output_path: 输出路径（默认覆盖原文件名加 _final 后缀）

    Returns:
        输出图片路径
    """
    if not output_path:
        p = Path(image_path)
        output_path = str(p.parent / f"{p.stem}_final{p.suffix}")

    img = Image.open(image_path).convert("RGBA")
    W, H = img.size

    # 创建叠加层
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # --- 字体加载 ---
    font_paths = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/STHeiti Medium.ttc",
    ]

    def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
        for fp in font_paths:
            try:
                return ImageFont.truetype(fp, size)
            except (IOError, OSError):
                continue
        return ImageFont.load_default()

    font_discount = load_font(80, bold=True)
    font_off = load_font(50, bold=True)
    font_brand = load_font(28, bold=True)
    font_cta = load_font(32, bold=True)

    # --- 颜色 ---
    white = (255, 255, 255, 255)
    orange = (255, 107, 53, 255)
    dark_overlay = (0, 0, 0, 120)

    # --- 底部暗色条（文字背景） ---
    bar_height = H // 3
    bar_y = H - bar_height
    draw.rectangle([(0, bar_y), (W, H)], fill=dark_overlay)

    # --- 折扣文字 ---
    discount_text = f"{int(discount)}%"
    discount_bbox = draw.textbbox((0, 0), discount_text, font=font_discount)
    discount_w = discount_bbox[2] - discount_bbox[0]
    discount_h = discount_bbox[3] - discount_bbox[1]

    off_text = "OFF"
    off_bbox = draw.textbbox((0, 0), off_text, font=font_off)
    off_w = off_bbox[2] - off_bbox[0]

    total_w = discount_w + off_w + 10
    start_x = (W - total_w) // 2
    discount_y = bar_y + (bar_height - discount_h - off_bbox[3] + off_bbox[1]) // 2 - 5

    # 折扣数字
    draw.text((start_x, discount_y), discount_text, fill=white, font=font_discount)
    # OFF
    draw.text((start_x + discount_w + 10, discount_y + discount_h - off_bbox[3] + off_bbox[1]), off_text, fill=orange, font=font_off)

    # --- CTA 按钮 ---
    cta_text_full = cta_text.upper()
    cta_bbox = draw.textbbox((0, 0), cta_text_full, font=font_cta)
    cta_w = cta_bbox[2] - cta_bbox[0]
    cta_h = cta_bbox[3] - cta_bbox[1]
    cta_pad_x = 30
    cta_pad_y = 14
    cta_btn_w = cta_w + cta_pad_x * 2
    cta_btn_h = cta_h + cta_pad_y * 2
    cta_btn_x = (W - cta_btn_w) // 2
    cta_btn_y = discount_y + discount_h + 20

    # 按钮背景
    draw.rounded_rectangle(
        [(cta_btn_x, cta_btn_y), (cta_btn_x + cta_btn_w, cta_btn_y + cta_btn_h)],
        radius=12,
        fill=orange,
    )
    # 按钮文字
    draw.text(
        (cta_btn_x + cta_pad_x, cta_btn_y + cta_pad_y),
        cta_text_full,
        fill=white,
        font=font_cta,
    )

    # --- 品牌名 ---
    brand_bbox = draw.textbbox((0, 0), brand_name, font=font_brand)
    brand_w = brand_bbox[2] - brand_bbox[0]
    brand_x = (W - brand_w) // 2
    draw.text((brand_x, bar_y - 40), brand_name, fill=white, font=font_brand)

    # --- 合并图层 ---
    result = Image.alpha_composite(img, overlay)
    result = result.convert("RGB")
    # 保存为无损 PNG，避免有损压缩进一步降低画质
    result.save(output_path, "PNG")

    print(f"[叠加] ✅ 已生成: {output_path}")
    return output_path