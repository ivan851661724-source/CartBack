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


def _senior_by_age_range(age_range: str | None) -> bool:
    """55+ 客群判定：age_range 第一个数字 >=55 返回 True；否则/异常 False"""
    if not age_range:
        return False
    try:
        import re as _re
        m = _re.match(r"\s*(\d+)", str(age_range))
        if not m:
            return False
        return int(m.group(1)) >= 55
    except Exception:
        return False


def overlay_marketing_text(
    image_path: str,
    discount: float,
    brand_name: str = "CartBack",
    cta_text: str = "Shop Now",
    output_path: str | None = None,
    *,
    age_range: str | None = None,
    senior_only_backgrounds: bool = True,
) -> str:
    """在营销图底部叠加：品牌名 + 折扣% OFF + CTA 按钮

    Args:
        age_range: 传入 UserRecord.age_range 时，叠加会按「55+才保留文字背景」规则走。
        senior_only_backgrounds: True（默认）→ 55+ 保留黑色横条/橙色实底；<=54 改用投影+描边。
                                False → 一律保留旧版黑横条+橙色实底（兼容）。

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
    orange_translucent = (255, 107, 53, 180)
    dark_overlay = (0, 0, 0, 130)
    shadow_black = (0, 0, 0, 150)
    outline_white_thin = (255, 255, 255, 220)

    # ---- A / B / C 三条规则：senior(55+) 保留实底；其余改用投影+描边，不画固定背景 ----
    senior = bool(senior_only_backgrounds and _senior_by_age_range(age_range))
    # 非 senior 时：不画整屏底部大黑横条（A），改用极细的透明渐变"文字可读性带"（可忽略）
    if senior:
        bar_height = H // 3
        bar_y = H - bar_height
        draw.rectangle([(0, bar_y), (W, H)], fill=dark_overlay)
        print(f"[overlay] 命中 senior(age_range={age_range!r})：保留黑色横条(A) + 橙色实底按钮(C)", flush=True)
    else:
        # 非 senior：去掉整条背景(A)。文字区域仍占底部 H/3 用于定位布局，但不画矩形。
        bar_height = H // 3
        bar_y = H - bar_height
        print(f"[overlay] non-senior(age_range={age_range!r})：移除黑色横条(A) + 橙色实底(C改轮廓描边)，用投影+描边提字", flush=True)

    # 帮助函数：画带投影/描边的 text（非 senior 对比性更依赖这一层；senior 只加轻投影）
    def draw_text_with_shadow(pos, text, font, fill, *, shadow=shadow_black, offset=2, outline=None):
        x, y = pos
        # 先画投影（轻微右下偏移）
        if shadow and offset and shadow[3] > 0:
            draw.text((x + offset, y + offset), text, fill=shadow, font=font)
        # 再画描边：上下左右 1px 浅色复制
        if outline:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    draw.text((x + dx, y + dy), text, fill=outline, font=font)
        draw.text((x, y), text, fill=fill, font=font)

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

    # 非 senior：加更多投影+描边来保字在背景图上的辨识度；senior：轻投影（背景已有横条）
    if senior:
        draw_text_with_shadow((start_x, base_y), discount_text, font_discount, fill=white,
                              shadow=(0,0,0,90), offset=2)
        draw_text_with_shadow(
            (start_x + discount_w + 10, base_y + discount_h - off_h),
            off_text, font_off, fill=orange,
            shadow=(0,0,0,90), offset=1,
        )
    else:
        draw_text_with_shadow((start_x, base_y), discount_text, font_discount, fill=white,
                              shadow=shadow_black, offset=3, outline=outline_white_thin)
        draw_text_with_shadow(
            (start_x + discount_w + 10, base_y + discount_h - off_h),
            off_text, font_off, fill=orange,
            shadow=shadow_black, offset=2, outline=outline_white_thin,
        )

    # CTA：C 保留，但非 senior 不画橙色实底 → 画「白字+橙色描边+细外框」风格；senior 保留原橙色实底按钮
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

    if senior:
        # C：senior → 保留橙色实填圆角按钮（完全原样式）
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
        draw_text_with_shadow((btn_x + pad_x, btn_y + pad_y), cta_upper, font_cta, fill=white,
                              shadow=(0,0,0,90), offset=1)
    else:
        # C：non-senior → 去掉实心橙色背景，改用「橙色薄边框+半透明橙色投影+白描边」的无实底 CTA 样式
        outline_thickness = max(2, int(min(W, H) * 0.004))  # 依分辨率动态
        try:
            # 画一个仅描边的圆角矩形（无 fill），Pillow 的 rounded_rectangle 在新版支持 outline+width
            draw.rounded_rectangle(
                [(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
                radius=radius,
                fill=None,
                outline=orange,
                width=outline_thickness,
            )
        except TypeError:
            # 老版本 rounded_rectangle 不支持 width；降级画一圈 rectangle 并加圆角点
            draw.rectangle(
                [(btn_x, btn_y), (btn_x + btn_w, btn_y + btn_h)],
                outline=orange,
            )
        # CTA 文字本身：橙色+深色投影+白色描边，保证无需按钮底色也能看清
        draw_text_with_shadow((btn_x + pad_x, btn_y + pad_y), cta_upper, font_cta, fill=orange,
                              shadow=shadow_black, offset=2, outline=outline_white_thin)

    # 品牌名（最底一条，非 senior 时也允许在横条区上沿画，只投影+描边提升字对比）
    try:
        brand_bbox = draw.textbbox((0, 0), str(brand_name), font=font_brand)
    except AttributeError:
        brand_sz = draw.textsize(str(brand_name), font=font_brand)
        brand_bbox = (0, 0, brand_sz[0], brand_sz[1])
    brand_w = brand_bbox[2] - brand_bbox[0]
    brand_x = (W - brand_w) // 2
    brand_y = max(bar_y - (brand_bbox[3] - brand_bbox[1]) - 8, 0)
    if senior:
        draw_text_with_shadow((brand_x, brand_y), str(brand_name), font_brand, fill=white,
                              shadow=(0,0,0,90), offset=1)
    else:
        draw_text_with_shadow((brand_x, brand_y), str(brand_name), font_brand, fill=white,
                              shadow=shadow_black, offset=2, outline=outline_white_thin)

    try:
        result = Image.alpha_composite(img, overlay).convert("RGB")
        result.save(output_path, "PNG")
        print(f"[overlay] ✅ 已输出: {output_path} (senior_mode={senior})", flush=True)
        return str(Path(output_path).absolute())
    except Exception as e:
        print(f"[overlay] 保存失败: {e}", flush=True)
        return str(src.absolute())
