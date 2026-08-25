"""LLM 文案生成模块 — DeepSeek（主用，OpenAI 兼容）+ MiniMax（备用）

和原版 copy_generator.py 的关键差异：
1. 增加了 from_node=True 分支：当 Node 端的 IGDE Agent 已经产出了 subject + body（默认情况），
   本模块直接采纳它们，不重复消耗 LLM Token。仅当传入 force_regenerate=True 或原始文案缺失时
   才真正调用 AI 重写。
2. Config / UserRecord 改用本包内的模块（避免依赖外部路径）。
3. 超时与错误更详细，便于 Node 端把原因写进 draft.html 给商家看。
"""
from __future__ import annotations

import json as json_lib
import re
import time
from typing import Any, Dict

import requests

from .config import Config
from .data_loader import UserRecord


def generate_copy(
    config: Config,
    user: UserRecord,
    max_retries: int = 2,
    force_regenerate: bool = False,
    existing: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """生成邮件文案

    Args:
        config:         配置（AI 密钥等）
        user:           目标受众画像（含 brand/discount/locale）
        max_retries:    失败重试次数
        force_regenerate: True 时即使 existing 有 subject+body 也重新生成
        existing:       Node 端 IGDE 已产出的 {"subject","body"}；若非空且非强刷则直接返回
    """
    # 快速路径：Agent 已经写好了，直接用（省 Token + 保持上下文一致性）
    if not force_regenerate and existing:
        subj = str(existing.get("subject") or "").strip()
        body = str(existing.get("body") or "").strip()
        if subj and body:
            return {
                "subject": subj,
                "body": body,
                "user_id": user.user_id,
                "email": user.email,
                "discount": user.discount,
                "regenerated": False,
                "provider": "igde_pass_through",
            }

    # 慢路径：调用 LLM 重新生成
    if config.deepseek and config.deepseek.api_key:
        return _call_provider("deepseek", config, user, max_retries)
    if config.minimax.api_key:
        return _call_provider("minimax", config, user, max_retries)

    # 没有配置任何 AI：使用基于品牌/折扣的模板兜底，确保系统可演示
    return _fallback_copy(user)


# ---------------------------------------------------------------------------
# Provider 实现
# ---------------------------------------------------------------------------


def _build_prompt(user: UserRecord) -> str:
    gender_map = {"M": "male", "F": "female", "O": "other"}
    gender_desc = gender_map.get(user.gender, "other")
    locale_short = (user.locale or "en").lower()[:2]
    write_in = (
        "English" if locale_short in ("en", "in", "de", "fr", "es", "it", "pt")
        else "Simplified Chinese" if locale_short == "zh"
        else "English"
    )
    return (
        "You are an expert e-commerce email copywriter. Write a recovery email for an abandoned cart.\n\n"
        f"BRAND: {user.brand}\n"
        f"TARGET USER: {gender_desc}, age {user.age_range}, Tier-{user.city_tier} city, {user.device} user\n"
        f"PRODUCT: {user.product_en or user.product or 'premium product'}"
        + (f" ({user.product_cn})" if user.product_cn else "")
        + f"\n"
        f"DISCOUNT: {user.discount:g}% OFF\n"
        f"GOAL: {user.goal or 'abandonment_recovery'}\n"
        f"LOCALE: {user.locale}\n\n"
        "REQUIREMENTS:\n"
        "1. Email subject line (under 50 characters, urgent and compelling)\n"
        f'2. Email body (friendly but urgent tone, {user.discount:g}% off as main hook, "Shop Now" CTA)\n'
        "3. Keep it concise and conversion-focused (3-6 short paragraphs max)\n"
        f"4. Write in {write_in}\n\n"
        "IMPORTANT: Output JSON only. No explanations, no thinking, no markdown. Just the raw JSON object.\n\n"
        'OUTPUT FORMAT (JSON):\n{"subject": "...", "body": "..."}'
    )


def _call_provider(name: str, config: Config, user: UserRecord, max_retries: int) -> Dict[str, Any]:
    prompt = _build_prompt(user)
    if name == "deepseek":
        assert config.deepseek is not None
        base = config.deepseek.base_url.rstrip("/")
        url = f"{base}/chat/completions"
        headers = {
            "Authorization": f"Bearer {config.deepseek.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": config.deepseek.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 1000,
            "temperature": 0.8,
        }
    else:
        base = config.minimax.base_url.rstrip("/")
        url = f"{base}/chat/completions"
        headers = {
            "Authorization": f"Bearer {config.minimax.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": config.minimax.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 1000,
            "temperature": 0.8,
        }

    last_err: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            result = response.json()
            choices = (result.get("output") or {}).get("choices") or result.get("choices") or []
            if not choices:
                raise RuntimeError(f"响应无 choices: {str(result)[:200]}")
            content = str(choices[0].get("message", {}).get("content", "")).strip()
            if name == "minimax":
                content = re.sub(r" thinking[\s\S]*? response", "", content).strip() or content

            copy_data = _extract_json(content)
            return {
                "subject": copy_data.get("subject", ""),
                "body": copy_data.get("body", ""),
                "user_id": user.user_id,
                "email": user.email,
                "discount": user.discount,
                "regenerated": True,
                "provider": name,
            }
        except Exception as e:
            last_err = e
            print(f"[copy:{name}] 第 {attempt}/{max_retries} 次失败: {e}")
            if attempt < max_retries:
                time.sleep(3)
    assert last_err is not None
    raise last_err


def _extract_json(content: str) -> Dict[str, str]:
    json_match = re.search(r'\{[\s\S]*?"subject"[\s\S]*?"body"[\s\S]*?\}', content)
    if json_match:
        json_str = json_match.group(0)
    else:
        first_brace = content.find("{")
        last_brace = content.rfind("}")
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            json_str = content[first_brace : last_brace + 1]
        else:
            raise ValueError(f"响应中找不到 JSON，内容前 200 字: {content[:200]!r}")
    # 去掉控制字符（避免 JSONDecodeError）
    json_str = re.sub(r"[\x00-\x1f]", _escape_ctrl, json_str)
    obj = json_lib.loads(json_str)
    if not isinstance(obj, dict):
        raise ValueError(f"解析结果不是 dict: {type(obj)}")
    return {
        "subject": str(obj.get("subject", "")).strip(),
        "body": str(obj.get("body", "")).strip(),
    }


def _escape_ctrl(m: re.Match) -> str:
    ch = m.group()
    if ch == "\n":
        return "\\n"
    if ch == "\r":
        return "\\r"
    if ch == "\t":
        return "\\t"
    return ""


def _fallback_copy(user: UserRecord) -> Dict[str, Any]:
    """无 AI Key 时的模板兜底（不阻塞主流程）"""
    pct = int(user.discount) if float(user.discount).is_integer() else user.discount
    subject = f"Your {pct}% OFF Is Waiting — Don't Miss Out, {user.brand}"
    body = (
        f"Hi there,\n\n"
        f"We noticed you left some items from {user.brand} in your cart. "
        f"Good news — we're giving you {pct}% OFF to welcome you back.\n\n"
        f"Use this chance today before it expires.\n\n"
        f"Tap the button below to pick up where you left off.\n\n"
        f"See you soon,\nThe {user.brand} Team"
    )
    return {
        "subject": subject,
        "body": body,
        "user_id": user.user_id,
        "email": user.email,
        "discount": user.discount,
        "regenerated": False,
        "provider": "fallback_template",
    }


# ---------------------------------------------------------------------------
# 图片 Prompt 生成（给 image_generator 调用）
# ---------------------------------------------------------------------------


def generate_image_prompt(user: UserRecord, config: Config) -> str:
    style_map: Dict[str, str] = {
        "tech": (
            "futuristic sci-fi tech aesthetic, dark charcoal gradient background with subtle "
            "neon cyan and electric blue glow accents, holographic grid lines, sleek modern "
            "smartphone case product photography, dramatic studio rim lighting, glossy "
            "reflective surface, depth of field, premium high-tech vibe, 8k product render"
        ),
        "premium_masculine": (
            "clean, minimal, dark background with gold accents, luxury product photography "
            "style, suitable for male 25-35"
        ),
        "feminine_youth": "soft gradient, warm tones, elegant, lifestyle-oriented",
        "general": "clean white background, product-focused, modern e-commerce style",
    }
    style = style_map.get(config.marketing.image_style, style_map["general"])

    try:
        discount_pct = int(user.discount)
    except (TypeError, ValueError):
        discount_pct = 10
    cta = (config.marketing.cta_button or "Shop Now").strip()
    brand = (user.brand or "CartBack").strip()
    product = (user.product_en or user.product or "premium product").strip()

    return (
        "海外电商邮件营销广告图。 "
        f"Product: {product}. "
        f"Style: {style}. "
        "Composition: premium e-commerce marketing hero banner, product centered in the upper "
        "area, marketing text in the lower area over a subtle dark gradient band for legibility. "
        "Render these English texts accurately and crisply into the image: "
        f'a large bold discount badge reading "{discount_pct}% OFF", '
        f'a rounded CTA button labeled "{cta}", '
        f'and the brand name "{brand}". '
        "Typography: clean modern sans-serif, high-contrast white text with subtle cyan glow, "
        "perfect spelling, no gibberish, no extra or duplicated characters, no Chinese characters. "
        "Lighting: dramatic studio lighting with neon rim light. "
        "High quality, photorealistic, 8k."
    )
