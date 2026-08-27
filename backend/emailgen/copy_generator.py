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
    # 语言选择：优先用户声明的习惯语言 preferred_language（权威，支持欧美多元文化背景，
    # 如 US 西语裔、加拿大魁北克法语、澳洲意裔），否则按 locale 推断兜底
    if user.preferred_language:
        write_in = user.preferred_language
    else:
        locale_short = (user.locale or "en").lower()[:2]
        write_in = (
            "English" if locale_short in ("en", "in", "de", "fr", "es", "it", "pt")
            else "Simplified Chinese" if locale_short == "zh"
            else "English"
        )
    # 标签池预留维度（price_sensitivity / customer_segment）：非空才注入并给话术引导，空则不影响输出
    # （from_plan_card 不采集这两维 → 初次用户设置不显示；JSONL/批量/测试可填）
    user_extras = []
    if user.price_sensitivity:
        user_extras.append(f"price sensitivity: {user.price_sensitivity}")
    if user.customer_segment:
        user_extras.append(f"customer segment: {user.customer_segment}")
    extras_str = (", " + ", ".join(user_extras)) if user_extras else ""
    tone_hint = ""
    if user_extras:
        tone_hint = (
            "5. Adapt tone to the shopper tags: "
            "value-sensitive → lead with savings/deal urgency; premium → lead with quality/exclusivity; "
            "new customer → welcoming; returning → \"glad to have you back\"; VIP → exclusive VIP offer.\n"
        )
    return (
        "You are an expert e-commerce email copywriter. Write a recovery email for an abandoned cart.\n\n"
        f"BRAND: {user.brand}\n"
        f"TARGET USER: {gender_desc}, age {user.age_range}, {user.device} user{extras_str}\n"
        f"PRODUCT: {user.product_en or user.product or 'premium product'}"
        + (f" ({user.product_cn})" if user.product_cn else "")
        + f"\n"
        f"DISCOUNT: {user.discount:g}% OFF\n"
        f"GOAL: {user.goal or 'abandonment_recovery'}\n"
        f"LOCALE: {user.locale} (market region — for currency/cultural tone, NOT for language)\n"
        f"WRITE IN: {write_in} (recipient's preferred language — write the ENTIRE email in this language)\n\n"
        "REQUIREMENTS:\n"
        "1. Email subject line (under 50 characters, urgent and compelling)\n"
        f'2. Email body (friendly but urgent tone, {user.discount:g}% off as main hook, include a clear CTA phrase like "Shop Now", localized to the write-in language)\n'
        "3. Keep it concise and conversion-focused (3-6 short paragraphs max)\n"
        f"4. Write the entire email (subject + body + CTA) in {write_in}\n"
        + tone_hint
        + "\nIMPORTANT: Output JSON only. No explanations, no thinking, no markdown. Just the raw JSON object.\n\n"
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
    # 先直接解析（兼容结构化空白合法的 JSON，如 qwen/glm 系列的 pretty-print 多行输出）
    try:
        obj = json_lib.loads(json_str)
    except json_lib.JSONDecodeError:
        # 退回到控制字符转义（处理字符串值内含裸换行的非法 JSON）
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


# 年龄+性别 → 核心视觉风格（主驱动）
# 关键：每条都明确「手持手机壳近景 + 场景作为柔和虚化 bokeh 背景」，
# 避免生成宽景环境照导致手机壳变小、主体离手机壳远。
_STYLE_BY_AGE_GENDER: Dict[tuple, str] = {
    ("18-24", "F"): (
        "Instagram-style aesthetic, soft solid pastel gradient (blush pink / lavender / peach), "
        "diverse young female hand holding the phone case close to camera, "
        "trendy cafe / dorm scene softly blurred as background bokeh, bright natural lighting, vibrant"
    ),
    ("18-24", "M"): (
        "Instagram-style vivid gradient (teal / sunset orange), "
        "adventurous young male hand holding the phone case close to camera, "
        "outdoor landscape (beach / trail) softly blurred as background bokeh, sunlit, social-media trend"
    ),
    ("25-34", "M"): (
        "clean minimal luxury, dark charcoal with warm gold accents, "
        "suited male hand holding the phone case close to camera, "
        "modern office desk softly blurred as background bokeh, European elegance"
    ),
    ("25-34", "F"): (
        "modern chic, soft neutral gradient, elegant female hand holding the phone case close to camera, "
        "boutique / studio scene softly blurred as background bokeh, soft studio lighting, sophisticated"
    ),
    ("35-44", "M"): (
        "rugged industrial aesthetic, dark gunmetal / matte black, "
        "masculine hand holding the phone case close to camera, "
        "workshop / gear scene softly blurred as background bokeh, dramatic lighting"
    ),
    ("35-44", "F"): (
        "modern professional, clean neutral tones, confident female hand holding the phone case close to camera, "
        "office scene softly blurred as background bokeh, soft studio lighting"
    ),
    ("45-54", "F"): (
        "natural lifestyle, warm earthy tones, mature female hand holding the phone case close to camera, "
        "cozy home / kitchen scene softly blurred as background bokeh, soft daylight, inviting"
    ),
    ("45-54", "M"): (
        "classic premium, warm wood and leather tones, distinguished mature male hand holding the phone case close to camera, "
        "study / library scene softly blurred as background bokeh, refined"
    ),
}

# 语言/文化 → 模特特征（仅当核心风格含 model 时叠加）
_LANG_MODEL: Dict[str, str] = {
    "spanish": "Hispanic / Latino model, warm vibrant Latin cultural aesthetic",
    "german": "European model, clean Bauhaus-inspired minimalism, precise",
    "french": "French-style elegance, romantic soft tones, chic",
    "italian": "Mediterranean warmth, passionate, Italian design flair",
    "english": "diverse multicultural model, modern Western market",
}


def _build_image_style(user: UserRecord) -> str:
    """根据用户标签（age/gender/price/segment/language）动态构建图片风格描述"""
    parts: list = []

    age = user.age_range or "25-34"
    gender = (user.gender or "O").upper()
    core = _STYLE_BY_AGE_GENDER.get((age, gender))
    if core is None:
        if gender == "F":
            core = "clean modern, soft gradient, elegant female lifestyle, bright natural lighting"
        elif gender == "M":
            core = "clean modern, dark gradient, masculine product photography, dramatic lighting"
        else:
            core = "clean modern e-commerce style, neutral gradient, product-focused"
    parts.append(core)

    # 价格敏感度 → 质感
    ps = (user.price_sensitivity or "").lower()
    if ps == "value":
        parts.append("bright cheerful approachable, colorful, deal-friendly savings vibe")
    elif ps == "premium":
        parts.append("luxury high-end, dark elegant, gold / platinum accents, exclusive")
    elif ps == "standard":
        parts.append("balanced practical, clean and honest, real-world usage")

    # 客户分层 → 氛围
    seg = (user.customer_segment or "").lower()
    if seg == "new":
        parts.append("fresh welcoming, bright inviting")
    elif seg == "returning":
        parts.append("warm familiar, appreciation and loyalty feel")
    elif seg == "vip":
        parts.append("ultra-exclusive VIP, black and gold, opulent prestige")

    # 语言/文化 → 模特特征（当核心风格含人物 hand/model 时叠加，匹配模特族裔）
    lang = (user.preferred_language or "").lower()
    model_hint = _LANG_MODEL.get(lang)
    if model_hint and ("hand" in core or "model" in core):
        parts.append(model_hint)

    return "; ".join(parts)


def generate_image_prompt(user: UserRecord, config: Config) -> str:
    style = _build_image_style(user)

    # config.marketing.image_style 非空且非默认 "tech" 时作为手动覆盖
    override = (config.marketing.image_style or "").strip()
    if override and override.lower() != "tech":
        style = override

    try:
        discount_pct = int(user.discount)
    except (TypeError, ValueError):
        discount_pct = 10
    cta = (config.marketing.cta_button or "Shop Now").strip()
    brand = (user.brand or "CartBack").strip()
    product = (user.product_en or user.product or "premium product").strip()
    device = (user.device or "").strip()

    # 主体描述：明确是手机壳，并对上画像里的手机型号（device）
    if device:
        subject = (
            f"a {product} (a phone case) fitted on a {device} smartphone. "
            "The phone case itself is the single, dominant, sharply-focused hero subject "
            "of the image — centered, large in frame, fully visible with its texture, "
            "material and design details clearly readable."
        )
    else:
        subject = (
            f"a {product} (a phone case). The phone case itself is the single, dominant, "
            "sharply-focused hero subject of the image — centered, large in frame, fully "
            "visible with its texture, material and design details clearly readable."
        )

    # 年龄判定：age_range 下限 >= 50 视为「>50 岁客群」，此时才允许 A/B 类文字背景增强
    age = (user.age_range or "25-34").strip()
    age_lo = 25
    try:
        # "18-24" -> 18；"55+" -> 55；"45-54" -> 45
        m = re.match(r"\s*(\d+)", age)
        if m:
            age_lo = int(m.group(1))
    except Exception:
        pass
    senior_users = age_lo >= 55  # 限制 A / B 只作用于 55+ 客群（按用户最新要求）

    # 深色/浅色风格差异（主要影响白字 vs 深字 + 打光方式）
    dark_bg = any(w in style.lower() for w in ("dark", "gunmetal", "charcoal", "matte black", "black and gold"))
    light_hint = "dramatic studio lighting with rim light" if dark_bg else "bright natural lighting"

    # B 项（文字下衬底条）：严格限制只在 >50 岁客群开启，与深/浅色背景风格解耦
    if senior_users:
        # >50岁：保留文字下的浅色/渐变衬底以保证中老年辨识度
        if dark_bg:
            text_hint = (
                "high-contrast white text over a soft pale gradient band or translucent light strip "
                "behind each line for mature-reader legibility; keep strips thin and subtle"
            )
        else:
            text_hint = (
                "high-contrast text (dark on a soft light band, or white on a soft gradient band) "
                "to ensure legibility for mature readers; keep bands thin and low-opacity"
            )
    else:
        # <=50岁：任何情况下不得出现文字固定背景条/块，只允许用投影提升字和图的对比
        if dark_bg:
            text_hint = (
                "high-contrast white text placed directly on the dark blurred background with a "
                "subtle drop shadow only if needed; NO solid box, NO gradient band, NO banner strip, NO light strip behind any lettering"
            )
        else:
            text_hint = (
                "high-contrast text placed directly on the blurred background with a subtle drop "
                "shadow only if needed; NO solid box, NO gradient band, NO banner strip behind any lettering"
            )

    # A：只有 >50 岁客群才保留「底部渐变横条」以提高文字辨识度；其他客群一律禁止
    if senior_users:
        text_area = "Marketing text in the lower area over a subtle, low-opacity gradient band for senior-readability legibility — keep the band thin and non-intrusive so the phone case remains the hero. "
    else:
        text_area = "Marketing text sits cleanly in the lower area directly on the blurred background — NO banners, NO solid boxes, NO gradient bands, NO cards, NO strips behind any text; text floats freely with drop shadow only. "

    return (
        "海外电商邮件营销广告图。 "
        f"Subject: {subject} "
        f"Style: {style}. "
        "Composition: premium e-commerce marketing hero banner. CRITICAL FRAMING: "
        "extreme close-up shot, the phone case is held in a hand and fills 60-70% of the frame, "
        "centered in the upper area, sharply in focus. Shallow depth of field (f/1.8), "
        "background heavily blurred into soft bokeh so the scene/model stays secondary and "
        "never competes with the phone case. The phone case is the unmistakable hero. "
        f"{text_area}"
        "Render these English texts accurately and crisply into the image: "
        f'a large bold discount badge reading "{discount_pct}% OFF", '
        f'a rounded CTA button labeled "{cta}", '
        f'and the brand name "{brand}". '
        f"Typography: clean modern sans-serif, {text_hint}, "
        "perfect spelling, no gibberish, no extra or duplicated characters, no Chinese characters. "
        f"Lighting: {light_hint}. "
        "High quality, photorealistic, 8k."
    )
