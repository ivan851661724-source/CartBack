"""DeepSeek 文案生成模块（主用）+ MiniMax（备用）"""
import time
import re
import json as json_lib
import requests
from typing import Dict
from config import Config
from data_loader import UserRecord


def generate_copy(config: Config, user: UserRecord, max_retries: int = 2) -> Dict:
    """调用 DeepSeek 生成文案（带自动重试）"""
    # 优先使用 DeepSeek，fallback 到 MiniMax
    if config.deepseek and config.deepseek.api_key:
        return _generate_deepseek(config, user, max_retries)
    elif config.minimax.api_key:
        return _generate_minimax(config, user, max_retries)
    else:
        raise RuntimeError("没有可用的 AI 配置（deepseek 或 minimax）")


def _generate_deepseek(config: Config, user: UserRecord, max_retries: int = 2) -> Dict:
    """DeepSeek API（OpenAI 兼容）"""
    gender_map = {"M": "male", "F": "female", "O": "other"}
    gender_desc = gender_map.get(user.gender, "other")

    prompt = (
        f"You are an expert e-commerce email copywriter. Write a recovery email for an abandoned cart.\n\n"
        f"BRAND: {user.brand}\n"
        f"TARGET USER: {gender_desc}, {user.age_range} years old, Tier-{user.city_tier} city, iPhone user\n"
        f"PRODUCT: {user.product_en} ({user.product_cn})\n"
        f"DISCOUNT: {user.discount}% OFF\n"
        f"GOAL: Abandonment recovery\n"
        f"LOCALE: {user.locale}\n\n"
        f"REQUIREMENTS:\n"
        f"1. Email subject line (under 50 characters, urgent and compelling)\n"
        f'2. Email body (friendly but urgent tone, {user.discount}% off as main hook, "Shop Now" CTA)\n'
        f"3. Keep it concise and conversion-focused\n"
        f"4. Write in English\n\n"
        f"IMPORTANT: Output JSON only. No explanations, no thinking, no markdown. Just the raw JSON object.\n\n"
        f'OUTPUT FORMAT (JSON):\n{{"subject": "...", "body": "..."}}'
    )

    url = f"{config.deepseek.base_url}/chat/completions"
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

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60)
            response.raise_for_status()

            result = response.json()
            content = result["choices"][0]["message"]["content"].strip()

            # 提取 JSON
            json_match = re.search(r'\{[\s\S]*?"subject"[\s\S]*?"body"[\s\S]*?\}', content)
            if json_match:
                json_str = json_match.group(0)
            else:
                first_brace = content.find("{")
                last_brace = content.rfind("}")
                if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
                    json_str = content[first_brace : last_brace + 1]
                else:
                    raise ValueError(f"无法从响应中提取 JSON: {content[:200]}")

            # 修复 JSON 中的非法控制字符（换行等）
            json_str = re.sub(r'[\x00-\x1f]', lambda m: '\\n' if m.group() == '\n' else '\\r' if m.group() == '\r' else '\\t' if m.group() == '\t' else '', json_str)

            copy_data = json_lib.loads(json_str)

            return {
                "subject": copy_data.get("subject", ""),
                "body": copy_data.get("body", ""),
                "user_id": user.user_id,
                "email": user.email,
                "discount": user.discount,
            }

        except Exception as e:
            print(f"[重试] DeepSeek 文案生成失败（第 {attempt}/{max_retries} 次）: {e}")
            if attempt == max_retries:
                raise
            time.sleep(3)

    raise RuntimeError("文案生成失败")


def _generate_minimax(config: Config, user: UserRecord, max_retries: int = 2) -> Dict:
    """MiniMax API（备用）"""
    gender_map = {"M": "male", "F": "female", "O": "other"}
    gender_desc = gender_map.get(user.gender, "other")

    prompt = (
        f"You are an expert e-commerce email copywriter. Write a recovery email for an abandoned cart.\n\n"
        f"BRAND: {user.brand}\n"
        f"TARGET USER: {gender_desc}, {user.age_range} years old, Tier-{user.city_tier} city, iPhone user\n"
        f"PRODUCT: {user.product_en} ({user.product_cn})\n"
        f"DISCOUNT: {user.discount}% OFF\n"
        f"GOAL: Abandonment recovery\n"
        f"LOCALE: {user.locale}\n\n"
        f"REQUIREMENTS:\n"
        f"1. Email subject line (under 50 characters, urgent and compelling)\n"
        f'2. Email body (friendly but urgent tone, {user.discount}% off as main hook, "Shop Now" CTA)\n'
        f"3. Keep it concise and conversion-focused\n"
        f"4. Write in English\n\n"
        f"IMPORTANT: Output JSON only. No explanations, no thinking, no markdown. Just the raw JSON object.\n\n"
        f'OUTPUT FORMAT (JSON):\n{{"subject": "...", "body": "..."}}'
    )

    url = f"{config.minimax.base_url}/chat/completions"
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

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60)
            response.raise_for_status()

            result = response.json()
            content = result["choices"][0]["message"]["content"].strip()

            # 去掉 MiniMax 的思考标签
            content = re.sub(r" thinking[\s\S]*? response", "", content).strip()
            if not content:
                content = result["choices"][0]["message"]["content"].strip()

            # 提取 JSON
            json_match = re.search(r'\{[\s\S]*?"subject"[\s\S]*?"body"[\s\S]*?\}', content)
            if json_match:
                json_str = json_match.group(0)
            else:
                first_brace = content.find("{")
                last_brace = content.rfind("}")
                if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
                    json_str = content[first_brace : last_brace + 1]
                else:
                    raise ValueError(f"无法从响应中提取 JSON: {content[:200]}")

            copy_data = json_lib.loads(json_str)

            return {
                "subject": copy_data.get("subject", ""),
                "body": copy_data.get("body", ""),
                "user_id": user.user_id,
                "email": user.email,
                "discount": user.discount,
            }

        except Exception as e:
            print(f"[重试] MiniMax 文案生成失败（第 {attempt}/{max_retries} 次）: {e}")
            if attempt == max_retries:
                raise
            time.sleep(3)

    raise RuntimeError("文案生成失败")


def generate_image_prompt(user: UserRecord, config: Config) -> str:
    """生成图片生成 Prompt

    文字与 CTA 按钮直接由图像模型画进图里（不再后期 Pillow 叠加），故要求模型
    把折扣、CTA、品牌名渲染得清晰可读。技术风格由 image_style 控制。
    """
    style_map = {
        "tech": (
            "futuristic sci-fi tech aesthetic, dark charcoal gradient background with subtle "
            "neon cyan and electric blue glow accents, holographic grid lines, sleek modern "
            "smartphone case product photography, dramatic studio rim lighting, glossy "
            "reflective surface, depth of field, premium high-tech vibe, 8k product render"
        ),
        "premium_masculine": "clean, minimal, dark background with gold accents, luxury product photography style, suitable for male 25-35",
        "feminine_youth": "soft gradient, warm tones, elegant, lifestyle-oriented",
        "general": "clean white background, product-focused, modern e-commerce style",
    }
    style = style_map.get(config.marketing.image_style, style_map["general"])

    discount_pct = int(user.discount)
    cta = (config.marketing.cta_button or "Shop Now").strip()
    brand = (user.brand or "CartBack").strip()

    prompt = (
        f"海外电商邮件营销广告图。 "
        f"Product: {user.product_en}. "
        f"Style: {style}. "
        f"Composition: premium e-commerce marketing hero banner, product centered in the upper "
        f"area, marketing text in the lower area over a subtle dark gradient band for legibility. "
        f"Render these English texts accurately and crisply into the image: "
        f"a large bold discount badge reading \"{discount_pct}% OFF\", "
        f"a rounded CTA button labeled \"{cta}\", "
        f"and the brand name \"{brand}\". "
        f"Typography: clean modern sans-serif, high-contrast white text with subtle cyan glow, "
        f"perfect spelling, no gibberish, no extra or duplicated characters, no Chinese characters. "
        f"Lighting: dramatic studio lighting with neon rim light. "
        f"High quality, photorealistic, 8k."
    )
    return prompt