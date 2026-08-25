"""图片叠加模块 — Pillow 后期叠加折扣徽章 / CTA 按钮 / 品牌名

当使用通用产品图（如 Pollinations）时，图像模型本身不知道品牌/折扣/CTA，必须靠这个模块后期叠加。
当使用万相定制图（overlay_text=False）时可跳过。

注意：原版 email-automation 里强依赖 Pillow，这里做成「Pillow 缺失时降级为不叠加，直接返回原图路径」
      避免因为一个包导致整条链路中断。
"""
from __future__ import annotations

from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore
    _PIL_OK = True
except Exception:  # pragma: no cover
    _PIL_OK = False


_FONT_CANDIDATES_MACOS = (
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/STHeiti Medium.ttc",
)
_FONT_CANDIDATES_LINUX = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
)
_FONT_CANDIDATES_WINDOWS = (
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
)

ALL_FONT_CANDIDATES = _FONT_CANDIDATES_MACOS + _FONT_CANDIDATES_LINUX + _FONT_CANDIDATES_WINDOWS


def overlay_marketing_text(
    image_path: str,
    discount: float,
    brand_name: str = "CartBack",
    cta_text: str = "Shop Now",
    output_path: str | None = None,
) -> str:
    """在营销图底部叠加：品牌名 + 折扣% OFF + CTA 按钮

    返回：叠加后的图片路径（绝对）。Pillow 不可用或失败时返回原图路径。
    """
    src = Path(image_path)
    if not src.exists():
        return image_path

    if not _PIL_OK:
        print("[overlay] Pillow 未安装，跳过叠加，返回原图", flush=True)
        return str(src.absolute())

    if output_path is None:
        output_path = str(src.parent / f"{src.stem}_final{src.suffix}")

    try:
        img = Image.open(src).convert("RGBA")
    except Exception as e:
        print(f"[overlay] 打开图片失败: {e}", flush=True)
        return str(src.absolute())

    W, H = img.size
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def load_font(size: int):
        for fp in ALL_FONT_CANDIDATES:
            try:
                return ImageFont.truetype(fp, size)
            except (IOError, OSError):
                continue
        return ImageFont.load_default()

    # 尺寸按图宽动态缩放，适配不同分辨率
    base = min(W, H)
    font_discount = load_font(max(36, int(base * 0.10)))
    font_off = load_font(max(22, int(base * 0.062)))
    font_brand = load_font(max(16, int(base * 0.035)))
    font_cta = load_font(max(18, int(base * 0.040)))

    white = (255, 255, 255, 255)
    orange = (255, 107, 53, 255)
    dark_overlay = (0, 0, 0, 130)

    bar_height = H // 3
    bar_y = H - bar_height
    draw.rectangle([(0, bar_y), (W, H)], fill=dark_overlay)

    # 折扣文字
    try:
        discount_pct = int(discount)
    except (TypeError, ValueError):
        discount_pct = int(float(discount or 0))
    discount_text = f"{discount_pct}%"
    off_text = "OFF"

    # 水平居中：折扣数字 + OFF 总宽度
    try:
        discount_bbox = draw.textbbox((0, 0), discount_text, font=font_discount)
        off_bbox = draw.textbbox((0, 0), off_text, font=font_off)
    except AttributeError:  # 老 Pillow 没有 textbbox
        discount_bbox = draw.textsize(discount_text, font=font_discount)
        off_bbox = draw.textsize(off_text, font=font_off)
        discount_bbox = (0, 0, discount_bbox[0], discount_bbox[1])
        off_bbox = (0, 0, off_bbox[0], off_bbox[1])

    discount_w = discount_bbox[2] - discount_bbox[0]
    discount_h = discount_bbox[3] - discount_bbox[1]
    off_w = off_bbox[2] - off_bbox[0]
    off_h = off_bbox[3] - off_bbox[1]

    total_w = discount_w + 10 + off_w
    start_x = (W - total_w) // 2
    base_y = bar_y + int((bar_height - discount_h - off_h) * 0.18)

    draw.text((start_x, base_y), discount_text, fill=white, font=font_discount)
    draw.text(
        (start_x + discount_w + 10, base_y + discount_h - off_h),
        off_text,
        fill=orange,
        font=font_off,
    )

    # CTA 按钮
    cta_upper = cta_text.upper()
    try:
        cta_bbox = draw.textbbox((0, 0), cta_upper, font=font_cta)
    except AttributeError:
        cta_sz = draw.textsize(cta_upper, font=font_cta)
        cta_bbox = (0, 0, cta_sz[0], cta_sz[1])
    cta_w = cta_bbox[2] - cta_bbox[0]
    cta_h = cta_bbox[3] - cta_bbox[1]
    pad_x = max(20, int(W * 0.05))
    pad_y = max(10, int(H * 0.015))
    btn_w = cta_w + pad_x * 2
    btn_h = cta_h + pad_y * 2
    btn_x = (W - btn_w) // 2
    btn_y = base_y + discount_h + max(10, int(H * 0.02))
    radius = max(8, min(24, int(min(btn_w, btn_h) * 0.18)))

    try:
        draw.rounded_rectangle(
            [(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
            radius=radius,
            fill=orange,
        )
    except AttributeError:  # 老 Pillow
        draw.rectangle(
            [(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
            fill=orange,
        )
    draw.text((btn_x + pad_x, btn_y + pad_y), cta_upper, fill=white, font=font_cta)

    # 品牌名（最顶一条，暗色带的上方）
    try:
        brand_bbox = draw.textbbox((0, 0), str(brand_name), font=font_brand)
    except AttributeError:
        brand_sz = draw.textsize(str(brand_name), font=font_brand)
        brand_bbox = (0, 0, brand_sz[0], brand_sz[1])
    brand_w = brand_bbox[2] - brand_bbox[0]
    brand_x = (W - brand_w) // 2
    draw.text((brand_x, max(bar_y - (brand_bbox[3] - brand_bbox[1]) - 8, 0)), str(brand_name), fill=white, font=font_brand)

    try:
        result = Image.alpha_composite(img, overlay).convert("RGB")
        result.save(output_path, "PNG")
        print(f"[overlay] ✅ 已输出: {output_path}", flush=True)
        return str(Path(output_path).absolute())
    except Exception as e:
        print(f"[overlay] 保存失败: {e}", flush=True)
        return str(src.absolute())
