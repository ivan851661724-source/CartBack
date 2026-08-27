"""用户/受众记录数据模型

说明：原始 email-automation 的 data_loader 依赖 JSONL 文件 + 很多 CRM 字段（gender/age_range/device...）。
集成进 CartBack 后，邮件草稿由 IGDE Agent 方案卡产出（subject/body/discount/audience/brand 等），
受众画像信息可能不全，这里把所有字段都做成可空默认值，并新增 `from_plan_card()` 工厂函数，
让 Node 传入的 plan card 可以不经 JSONL 直接送入后续文案/图片管线。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, Optional


@dataclass
class UserRecord:
    """单收件人记录（一条受众画像 + 营销参数）"""
    user_id: str = "anon"
    email: str = ""
    brand: str = "CartBack"
    gender: str = "O"            # M / F / O
    age_range: str = "25-34"
    device: str = "iPhone"
    product: str = ""
    product_cn: str = ""
    product_en: str = ""
    discount: float = 8.0
    goal: str = "abandonment_recovery"
    send_window: str = "10:30-21:00"
    locale: str = "en-US"
    preferred_language: str = ""   # 用户习惯语言（如 "German"/"French"/"Spanish"）；空=按 locale 推断，非空=权威覆盖 locale 语言猜测
    price_sensitivity: str = ""    # 价格敏感度: value / standard / premium（标签池预留；from_plan_card 暂不采集 → 初次用户设置不显示）
    customer_segment: str = ""     # 客户分层: new / returning / vip（标签池预留；from_plan_card 暂不采集 → 初次用户设置不显示）
    cart_url: str = "https://cartback.demo"
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_plan_card(cls, card: Dict[str, Any], draft: Optional[Dict[str, Any]] = None) -> "UserRecord":
        """从 Node 传入的方案卡 + draft 构造用户记录

        card 字段约定（兼容 CartBack IGDE 输出）:
          subject, body, discount, audience, brand, locale, coupon, posters, cta
        """
        discount_raw = card.get("discount") or (draft or {}).get("discount") or 8
        try:
            discount = float(discount_raw)
        except (TypeError, ValueError):
            discount = 8.0
        audience = str(card.get("audience") or "").strip()
        locale = str(card.get("locale") or (draft or {}).get("locale") or "en").strip()
        if len(locale) == 2:
            locale = f"{locale}-{locale.upper()}"
        preferred_language = str(card.get("preferred_language") or (draft or {}).get("preferred_language") or "").strip()
        # 从 audience 描述里猜一个产品词给 image prompt 用（兜底）
        product_en = str(card.get("product") or card.get("product_en") or "Premium Phone Case").strip()
        product_cn = str(card.get("product_cn") or "").strip()
        brand = str(card.get("brand") or (draft or {}).get("brand") or "CartBack").strip() or "CartBack"
        cart_url = str(card.get("cart_url") or (draft or {}).get("cart_url") or "https://cartback.demo").strip()
        uid = str((draft or {}).get("id") or card.get("id") or f"dr_{abs(hash(audience + brand)) % 1_000_000:06d}")
        return cls(
            user_id=uid,
            email="",  # 草稿阶段还不知道具体收件人，真实发送时按 audience 展开
            brand=brand,
            product_en=product_en,
            product_cn=product_cn,
            product=product_en,
            discount=discount,
            locale=locale,
            preferred_language=preferred_language,
            cart_url=cart_url,
            raw={**dict(card), "draft": draft or {}},
        )


def load_user_data(file_path: str) -> Iterator[UserRecord]:
    """逐行加载 JSONL（保留原版能力，便于批量生成场景）"""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"用户数据文件不存在: {file_path}")

    with open(path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                yield UserRecord(
                    user_id=data.get("user_id", f"unknown_{line_num}"),
                    email=data.get("email", ""),
                    brand=data.get("brand", "CartBack"),
                    gender=data.get("gender", "O"),
                    age_range=data.get("age_range", "25-34"),
                    device=data.get("device", "iPhone"),
                    product=data.get("product", ""),
                    product_cn=data.get("product_cn", ""),
                    product_en=data.get("product_en", data.get("product", "")),
                    discount=float(data.get("discount", 0)),
                    goal=data.get("goal", "abandonment_recovery"),
                    send_window=data.get("send_window", "10:30-21:00"),
                    locale=data.get("locale", "en-US"),
                    preferred_language=data.get("preferred_language", ""),
                    price_sensitivity=data.get("price_sensitivity", ""),
                    customer_segment=data.get("customer_segment", ""),
                    cart_url=data.get("cart_url", "https://cartback.demo"),
                    raw=data,
                )
            except json.JSONDecodeError as e:
                print(f"[警告] 第 {line_num} 行 JSON 解析失败: {e}")


def count_users(file_path: str) -> int:
    count = 0
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                count += 1
    return count
