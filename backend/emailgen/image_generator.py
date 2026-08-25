"""图片生成模块

双轨策略：
1. **wanx_enabled**：当 config.qianwen_vision 配置了 api_key + base_url 时，调用阿里万相
   （Token Plan 兼容模式 /chat/completions 多模态）生成高质量定制营销图。
2. **Fallback**：若未配置万相，用原版 Pollinations（免 Key）生成通用产品图，再用 Pillow 叠加
   折扣文字/CTA 按钮。保证零配置也能出图，不阻塞草稿生成。
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Dict

import requests

from .config import Config
from .copy_generator import generate_image_prompt
from .data_loader import UserRecord
from .image_overlay import overlay_marketing_text


# ---------------------------------------------------------------------------
# 万相（Token Plan 兼容模式）
# ---------------------------------------------------------------------------


def _extract_image_url(data: Dict[str, Any]) -> str:
    out = data.get("output") or {}
    choices = out.get("choices") or data.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or {}
    content = msg.get("content")

    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("image"):
                return part["image"]
            if part.get("type") == "image_url" and isinstance(part.get("image_url"), dict):
                return part["image_url"].get("url", "")
            if part.get("url"):
                return part["url"]
        return ""

    if isinstance(content, str):
        m = re.search(r"\((https?://[^)]+)\)", content) or re.search(r"(https?://\S+)", content)
        return m.group(1) if m else ""

    return ""


def _request_wanx(prompt: str, config: Config) -> str:
    q = config.qianwen_vision
    base = (q.base_url or "").rstrip("/")
    if not base or not q.api_key:
        raise RuntimeError("万相未配置（缺少 base_url 或 api_key）")
    url = f"{base}/chat/completions"
    headers = {
        "Authorization": f"Bearer {q.api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": q.model,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": prompt}]},
        ],
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=180)
    if resp.status_code != 200:
        raise RuntimeError(f"万相 HTTP {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    image_url = _extract_image_url(data)
    if not image_url:
        raise RuntimeError(f"万相响应无图片 URL: {str(data)[:400]}")
    return image_url


# ---------------------------------------------------------------------------
# Pollinations 免 Key 兜底
# ---------------------------------------------------------------------------


def _request_pollinations(discount: float, brand: str, seed_salt: str = "") -> str:
    prompt = (
        "High-quality e-commerce marketing email hero image of a premium phone case, "
        "sleek modern smartphone case product photography, "
        "bright clean studio lighting, soft gradient background, "
        "professional brand aesthetic, newsletter banner style, "
        "8K detailed, no text overlay in the image, best quality"
    )
    encoded = requests.utils.quote(prompt)
    seed = (int(time.time()) + abs(hash((brand, discount, seed_salt))) % 100_000) % 1_000_000
    return (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1200&height=1500&seed={seed}&nologo=true"
    )


# ---------------------------------------------------------------------------
# 下载 / 入口
# ---------------------------------------------------------------------------


def download_image(image_url: str, tag: str, output_dir: str = "output/images", timeout: int = 90) -> str:
    """下载远程图片到本地 output/images/，返回绝对路径；失败返回空串"""
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_tag = re.sub(r"[^\w.-]+", "_", str(tag))[:60] or "img"
    filename = f"{safe_tag}_{int(time.time())}.png"
    local_path = out_dir / filename

    print(f"[image] 下载 {image_url[:80]}…", flush=True)
    try:
        resp = requests.get(image_url, timeout=timeout, stream=True)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        if "image" not in content_type:
            preview = resp.text[:200] if resp.text else "(empty)"
            print(f"[image] ⚠️ 响应不是图片 ({content_type}): {preview}")
            return ""
        total = 0
        with open(local_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
                total += len(chunk)
        if total == 0:
            local_path.unlink(missing_ok=True)
            return ""
        print(f"[image] ✅ 下载完成 ({total} bytes) → {local_path}", flush=True)
        return str(local_path.absolute())
    except Exception as e:
        print(f"[image] 下载失败: {e}")
        try:
            local_path.unlink(missing_ok=True)
        except Exception:
            pass
        return ""


def generate_product_image(
    config: Config,
    user: UserRecord,
    product_image_path: str | None = None,
    skip: bool = False,
    max_retries: int = 3,
    retry_delay: int = 12,
    output_dir: str = "output/images",
) -> str:
    """生成营销图片主入口

    Args:
        product_image_path: 如果有现成的本地产品图，直接跳过生成走叠加层。
        skip: 为 True 时完全不生成图片（仅测文案/HTML 用）。
    返回：本地图片路径（绝对）或空串
    """
    if skip:
        return ""

    # 已有本地产品图 → 直接叠加文字（极快）
    if product_image_path and os.path.exists(product_image_path):
        if getattr(config.marketing, "overlay_text", True):
            return overlay_marketing_text(
                image_path=product_image_path,
                discount=user.discount,
                brand_name=user.brand,
                cta_text=config.marketing.cta_button,
            )
        return str(Path(product_image_path).absolute())

    prompt = generate_image_prompt(user, config)
    wanx_ready = bool(config.qianwen_vision.api_key and config.qianwen_vision.base_url)

    for attempt in range(1, max_retries + 1):
        try:
            if wanx_ready:
                print(f"[image] 第 {attempt}/{max_retries} 次，调用万相生成…", flush=True)
                image_url = _request_wanx(prompt, config)
            else:
                # 万相未配置：Pollinations 兜底 + 必做文字叠加（因为通用图里没有折扣/CTA）
                print(f"[image] 第 {attempt}/{max_retries} 次，Pollinations 兜底（overlay=True）…", flush=True)
                image_url = _request_pollinations(user.discount, user.brand, seed_salt=str(attempt))

            if image_url.startswith("/") or image_url.startswith("\\") or "://" not in image_url:
                local = image_url
            else:
                local = download_image(image_url, user.user_id, output_dir=output_dir)

            if not local:
                raise RuntimeError("图片下载为空")

            # 万相的 overlay_text 默认 False（文字已由模型画进图）；Pollinations 强制 True
            need_overlay = (
                True
                if not wanx_ready
                else bool(getattr(config.marketing, "overlay_text", False))
            )
            if need_overlay:
                final = overlay_marketing_text(
                    image_path=local,
                    discount=user.discount,
                    brand_name=user.brand,
                    cta_text=config.marketing.cta_button,
                )
                return final
            return str(Path(local).absolute())

        except Exception as e:
            print(f"[image] 第 {attempt}/{max_retries} 次失败: {e}", flush=True)
            if attempt < max_retries:
                time.sleep(retry_delay)

    print("[image] 达到最大重试次数，返回空", flush=True)
    return ""
