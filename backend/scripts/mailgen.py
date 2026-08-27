#!/usr/bin/env python3
"""CartBack 邮件生成服务 v2（基于本地 emailgen 包，不再依赖 ~/email-automation 外部目录）

供 Node.js backend/scripts/mailgen.py 调用：
  echo '<stdin JSON>' | python3 scripts/mailgen.py

stdin JSON 字段（兼容旧版，新增均可选）：
    subject, body, discount, brand, audience, cart_url, cta,
    locale, product_en, product_cn, coupon, posters,          # IGDE 方案卡
    ai_config: { provider, apiKey, baseUrl, model,            # 可选：复用 Node 侧 AI Key
                 visionKey?, visionBaseUrl?, visionModel? },
    force_regen_copy: bool,                                    # 即使已有 subject/body，也重新用 LLM 生成
    skip_image: bool,                                          # 仅测文案 / HTML，跳过图片

stdout JSON 字段：
    success       bool
    html          str         # 邮件 HTML（use_cid：预览用 /api/image/:path 直接读）
    image_path    str         # 本地绝对路径，CID 内嵌或 HTTP 预览均用它
    subject       str         # 最终主题（可能被 LLM 改写）
    body          str         # 最终正文（可能被 LLM 改写）
    copy_provider str         # igde_pass_through | deepseek | minimax | fallback_template
    image_method  str         # wanx | pollinations | skip | empty
    error         str?        # 失败时的原因
    warnings      str[]?      # 非致命告警（如 Pillow 缺失导致跳过叠加）

debug 模式：运行 `python3 scripts/mailgen.py --selftest` 做一次端到端免密钥演练，便于 CI / 本地自检。
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

# —— 把 emailgen 放进 import path（脚本入口通用，无需安装包）——
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from emailgen.config import load_config          # noqa: E402
from emailgen.copy_generator import generate_copy  # noqa: E402
from emailgen.image_generator import generate_product_image  # noqa: E402
from emailgen.email_builder import build_email_html  # noqa: E402
from emailgen.data_loader import UserRecord  # noqa: E402

OUTPUT_DIR = (BACKEND_ROOT / "output" / "images").as_posix()


# ---------------------------------------------------------------------------
# 5 套差异化虚拟用户画像（覆盖 12 维度 + 对应手机壳类型）
# 用于 --selftest5：测试 LLM 文案对各画像维度的精确度
# 维度: brand / gender / age_range / device / product / discount / goal / locale(市场区域)
#       / preferred_language(用户习惯语言,权威覆盖 locale 语言)
#       / price_sensitivity(价格敏感度: value/standard/premium)
#       / customer_segment(客户分层: new/returning/vip) / cart_url
# 欧美市场 + 多元文化背景；city_tier 已移除（欧美无语义）
# price_sensitivity / customer_segment 为标签池预留维度（from_plan_card 不采集 → 初次用户设置不显示；
#   JSONL/批量/测试可填，此处填入差异化值以验证话术精确度）
# ---------------------------------------------------------------------------

_SELFTEST5_PROFILES = [
    {
        "name": "P1 美国Z世代时尚女大学生 — 闪钻冰透壳",
        "user_id": "st5_1", "email": "",
        "brand": "Lumière", "gender": "F", "age_range": "18-24",
        "device": "iPhone 15",
        "product_en": "Glitter Rhinestone Clear Case",
        "product_cn": "闪钻冰透手机壳",
        "product": "Glitter Rhinestone Clear Case",
        "discount": 15.0, "goal": "abandonment_recovery",
        "locale": "en-US", "preferred_language": "English",
        "price_sensitivity": "value", "customer_segment": "new",
        "cart_url": "https://cartback.demo/u1",
    },
    {
        "name": "P2 美国中年硬核科技男(西语裔) — 军工磁吸防摔壳",
        "user_id": "st5_2", "email": "",
        "brand": "AegisGuard", "gender": "M", "age_range": "35-44",
        "device": "iPhone 15 Pro Max",
        "product_en": "Rugged Armor MagSafe Case",
        "product_cn": "军工磁吸防摔壳",
        "product": "Rugged Armor MagSafe Case",
        "discount": 12.0, "goal": "abandonment_recovery",
        "locale": "en-US", "preferred_language": "Spanish",
        "price_sensitivity": "premium", "customer_segment": "returning",
        "cart_url": "https://cartback.demo/u2",
    },
    {
        "name": "P3 德国商务男士 — 真皮卡包翻盖壳",
        "user_id": "st5_3", "email": "",
        "brand": "NordHülle", "gender": "M", "age_range": "25-34",
        "device": "iPhone 14",
        "product_en": "Premium Leather Wallet Case",
        "product_cn": "真皮卡包翻盖壳",
        "product": "Premium Leather Wallet Case",
        "discount": 10.0, "goal": "abandonment_recovery",
        "locale": "de-DE", "preferred_language": "German",
        "price_sensitivity": "premium", "customer_segment": "vip",
        "cart_url": "https://cartback.demo/u3",
    },
    {
        "name": "P4 加拿大中年实用女(魁北克法语) — 简约透明软壳",
        "user_id": "st5_4", "email": "",
        "brand": "MapleShell", "gender": "F", "age_range": "45-54",
        "device": "iPhone 13",
        "product_en": "Simple Transparent Soft Case",
        "product_cn": "简约透明软壳",
        "product": "Simple Transparent Soft Case",
        "discount": 20.0, "goal": "abandonment_recovery",
        "locale": "en-CA", "preferred_language": "French",
        "price_sensitivity": "value", "customer_segment": "returning",
        "cart_url": "https://cartback.demo/u4",
    },
    {
        "name": "P5 澳洲年轻户外男(意裔) — 防水户外防护壳",
        "user_id": "st5_5", "email": "",
        "brand": "OutbackGear AU", "gender": "M", "age_range": "18-24",
        "device": "iPhone 15 Pro",
        "product_en": "Waterproof Rugged Outdoor Case",
        "product_cn": "防水户外防护壳",
        "product": "Waterproof Rugged Outdoor Case",
        "discount": 8.0, "goal": "abandonment_recovery",
        "locale": "en-AU", "preferred_language": "Italian",
        "price_sensitivity": "standard", "customer_segment": "new",
        "cart_url": "https://cartback.demo/u5",
    },
]


def _emit(result: dict) -> None:
    """权威输出：只在 stdout 打一行 JSON，Node 端解析最后一个 JSON 对象"""
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run(payload: dict) -> dict:
    warnings: list[str] = []

    # 1. 加载配置（YAML + 环境变量 + Node 注入的 ai_config）
    ai_config = payload.get("ai_config") if isinstance(payload.get("ai_config"), dict) else None
    cfg = load_config(ai_config=ai_config)

    # 2. 从 plan card 构造 UserRecord
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else None
    try:
        user = UserRecord.from_plan_card(payload, draft=draft)
    except Exception as e:
        return {"success": False, "error": f"构造 UserRecord 失败: {e}", "warnings": warnings}

    # 3. 文案（优先复用 IGDE 产出的 subject + body，省 Token；force_regen_copy 则重写）
    force_regen = bool(payload.get("force_regen_copy"))
    existing = None
    if payload.get("subject") or payload.get("body"):
        existing = {"subject": payload.get("subject", ""), "body": payload.get("body", "")}
    try:
        copy = generate_copy(
            cfg, user,
            force_regenerate=force_regen,
            existing=existing,
        )
    except Exception as e:
        warnings.append(f"文案生成异常，兜底使用原 subject/body：{e}")
        copy = {
            "subject": str(payload.get("subject") or f"{user.brand} — 你的专属福利"),
            "body": str(payload.get("body") or "点击按钮，回到购物车完成下单。"),
            "provider": "error_fallback",
            "regenerated": False,
        }

    subject = copy.get("subject") or str(payload.get("subject") or "")
    body = copy.get("body") or str(payload.get("body") or "")
    copy_provider = copy.get("provider", "unknown")

    # 4. 图片生成（跳过 → 万相 → Pollinations 兜底，三级降级）
    skip_image = bool(payload.get("skip_image"))
    image_method = "skip"
    image_path = ""
    if not skip_image:
        try:
            image_path = generate_product_image(
                cfg, user,
                product_image_path=payload.get("product_image_path"),
                skip=False,
                output_dir=OUTPUT_DIR,
            )
            if image_path:
                # 判断是走了万相还是 Pollinations：没有 _final 后缀 + overlay_text=False → 万相
                qv_ready = bool(cfg.qianwen_vision.api_key and cfg.qianwen_vision.base_url)
                image_method = "wanx" if qv_ready else "pollinations"
                if "_final" in Path(image_path).name and not qv_ready:
                    image_method = "pollinations+overlay"
                elif "_final" in Path(image_path).name:
                    image_method = "wanx+overlay"
            else:
                image_method = "empty"
                warnings.append("图片生成全部降级失败，返回空图（邮件里将只显示品牌头+文案+CTA）")
        except Exception as e:
            image_method = "error"
            warnings.append(f"图片生成异常（非致命）: {e}")
            traceback.print_exc(file=sys.stderr)

    # 5. 合成 HTML（Node 端 /api/image/:path 预览场景不需要 CID，真实发送在 Resend 里也用外部 URL；
    #    这里保留 use_cid=false，让 image_path 直接走后端图片端点即可；同时返回 image_path 给 Node 存 draft）
    use_cid = False
    try:
        html = build_email_html(
            subject=subject,
            body=body,
            image_url=image_path,
            cart_url=user.cart_url,
            brand_name=user.brand,
            discount=user.discount,
            cta_text=cfg.marketing.cta_button or "Shop Now",
            use_cid=use_cid,
        )
    except Exception as e:
        return {
            "success": False,
            "error": f"HTML 合成失败: {e}",
            "warnings": warnings,
            "subject": subject,
            "body": body,
            "copy_provider": copy_provider,
            "image_method": image_method,
            "image_path": image_path,
        }

    return {
        "success": True,
        "html": html,
        "image_path": image_path,
        "subject": subject,
        "body": body,
        "copy_provider": copy_provider,
        "image_method": image_method,
        "warnings": warnings or None,
        "config_source": cfg.source,
    }


def selftest() -> int:
    """无密钥自检：构造一个假 plan card，走完整管线，验证 emailgen 包导入 + 降级路径 OK。"""
    print("[selftest] 开始邮件生成自检（无 AI Key，走 fallback 模板 + Pollinations 图片兜底）…", file=sys.stderr)
    payload = {
        "subject": "",
        "body": "",
        "discount": 12,
        "brand": "CartBack Selftest",
        "audience": "加购未付的老客",
        "cart_url": "https://cartback.demo/selftest",
        "locale": "en-US",
        "skip_image": True,  # 免网图依赖
    }
    r = run(payload)
    if not r.get("success"):
        print(f"[selftest] ❌ 失败: {r}", file=sys.stderr)
        _emit(r)
        return 2
    print(
        f"[selftest] ✅ 成功。copy_provider={r.get('copy_provider')} "
        f"image_method={r.get('image_method')} html_len={len(r.get('html',''))} "
        f"image_path={r.get('image_path') or '(empty)'}",
        file=sys.stderr,
    )
    _emit(r)
    return 0


def selftest5(with_image: bool = False) -> int:
    """5 套差异化画像的邮件内容精确度测试。

    - 绕过 from_plan_card，直接构造 UserRecord，让 gender/age_range/device/goal/preferred_language/price_sensitivity/customer_segment 全部生效
    - force_regenerate=True → 绕过 IGDE pass-through，真正调用 LLM
    - 默认 skip_image，聚焦文案精确度；--with-image 可启用
    - AI 配置从环境变量 CARTBACK_AI_CONFIG（JSON 字符串）读取，避免密钥落盘 / 入 git
      （走 ai_config 注入路径，绕过 _apply_env 的 None-deepseek latent bug）
    """
    ai_config = None
    raw_cfg = os.environ.get("CARTBACK_AI_CONFIG")
    if raw_cfg:
        try:
            ai_config = json.loads(raw_cfg)
        except Exception as e:
            print(f"[selftest5] CARTBACK_AI_CONFIG JSON 解析失败: {e}", file=sys.stderr)

    cfg = load_config(ai_config=ai_config)
    has_ai = bool((cfg.deepseek and cfg.deepseek.api_key) or cfg.minimax.api_key)
    if not has_ai:
        print("[selftest5] ⚠️ 未配置 AI 密钥，将走 _fallback_copy 模板（gender/age/device/goal/"
              "preferred_language/price_sensitivity/customer_segment 不影响输出）。"
              "请用环境变量 CARTBACK_AI_CONFIG 注入。", file=sys.stderr)
    else:
        prov = "deepseek" if (cfg.deepseek and cfg.deepseek.api_key) else "minimax"
        mdl = cfg.deepseek.model if prov == "deepseek" else cfg.minimax.model
        print(f"[selftest5] AI 已配置 (provider={prov}, model={mdl})，开始 5 套画像测试…", file=sys.stderr)

    results = []
    for i, p in enumerate(_SELFTEST5_PROFILES, 1):
        name = p["name"]
        user = UserRecord(**{k: v for k, v in p.items() if k != "name"})
        print(f"[selftest5] ({i}/5) {name} — lang={user.preferred_language or user.locale} "
              f"price={user.price_sensitivity or '-'} seg={user.customer_segment or '-'} disc={user.discount:g}%", file=sys.stderr)

        # 文案：force_regenerate=True → 真正调 LLM（绕过 IGDE pass-through）
        try:
            copy = generate_copy(cfg, user, force_regenerate=True)
            subject = copy.get("subject", "")
            body = copy.get("body", "")
            provider = copy.get("provider", "unknown")
        except Exception as e:
            subject, body, provider = "", "", f"error: {e}"
            print(f"[selftest5]   文案生成失败: {e}", file=sys.stderr)

        # 图片（默认跳过，聚焦文案精确度）
        image_method, image_path = "skip", ""
        if with_image:
            try:
                image_path = generate_product_image(cfg, user, skip=False, output_dir=OUTPUT_DIR)
                qv = bool(cfg.qianwen_vision.api_key and cfg.qianwen_vision.base_url)
                image_method = ("wanx" if qv else "pollinations") if image_path else "empty"
            except Exception as e:
                image_method = f"error: {e}"

        # HTML
        try:
            html = build_email_html(
                subject=subject, body=body, image_url=image_path,
                cart_url=user.cart_url, brand_name=user.brand,
                discount=user.discount,
                cta_text=cfg.marketing.cta_button or "Shop Now",
                use_cid=False,
            )
        except Exception as e:
            html = f"<!-- HTML build failed: {e} -->"

        results.append({
            "name": name,
            "tags": {
                "gender": user.gender, "age_range": user.age_range,
                "device": user.device,
                "brand": user.brand, "product_en": user.product_en,
                "product_cn": user.product_cn, "discount": user.discount,
                "goal": user.goal, "locale": user.locale,
                "preferred_language": user.preferred_language,
                "price_sensitivity": user.price_sensitivity,
                "customer_segment": user.customer_segment,
            },
            "subject": subject,
            "body": body,
            "copy_provider": provider,
            "image_method": image_method,
            "html_len": len(html),
            "html": html,
        })

    _emit({"success": True, "ai_on": has_ai, "image_on": with_image, "profiles": results})
    return 0


def main() -> None:
    # 允许命令行参数：--selftest / --selftest5 [--with-image]
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest5":
        with_image = "--with-image" in sys.argv[2:]
        sys.exit(selftest5(with_image=with_image))

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        _emit({"success": False, "error": f"stdin JSON 解析失败: {e}"})
        return

    try:
        result = run(payload)
    except Exception as e:  # 最高级兜底：无论如何，给 Node 端一个 JSON 结果，避免脚本静默挂起
        tb = traceback.format_exc()
        print(f"[mailgen] 未捕获异常:\n{tb}", file=sys.stderr)
        result = {"success": False, "error": f"未预期错误: {e}"}

    _emit(result)


if __name__ == "__main__":
    main()
