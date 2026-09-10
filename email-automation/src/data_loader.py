"""用户数据加载与解析"""
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional


@dataclass
class UserRecord:
    user_id: str
    email: str
    brand: str
    gender: str
    age_range: str
    city_tier: str
    device: str
    product: str
    product_cn: str
    product_en: str
    discount: float
    goal: str
    send_window: str
    locale: str
    cart_url: str
    raw: dict  # 原始数据，保留所有字段


def load_user_data(file_path: str) -> Iterator[UserRecord]:
    """逐行加载 JSONL 格式用户数据，流式处理不需要把整个文件加载到内存"""
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
                    brand=data.get("brand", ""),
                    gender=data.get("gender", ""),
                    age_range=data.get("age_range", ""),
                    city_tier=data.get("city_tier", ""),
                    device=data.get("device", ""),
                    product=data.get("product", ""),
                    product_cn=data.get("product_cn", ""),
                    product_en=data.get("product_en", ""),
                    discount=float(data.get("discount", 0)),
                    goal=data.get("goal", ""),
                    send_window=data.get("send_window", "10:30-21:00"),
                    locale=data.get("locale", "en-US"),
                    cart_url=data.get("cart_url", ""),
                    raw=data,
                )
            except json.JSONDecodeError as e:
                print(f"[警告] 第 {line_num} 行 JSON 解析失败: {e}")


def count_users(file_path: str) -> int:
    """统计用户数量（不加载全部数据）"""
    count = 0
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                count += 1
    return count


if __name__ == "__main__":
    # 测试
    users = list(load_user_data("user_data.jsonl"))
    for u in users:
        print(f"{u.user_id} | {u.email} | {u.gender} | {u.age_range} | {u.discount}% off")
