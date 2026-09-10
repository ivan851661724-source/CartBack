"""图片生成模块 - 阿里万相（Token Plan 兼容模式 /chat/completions 多模态）

通过 config.yaml 中的 qianwen_vision 配置调用万相文生图。
Token Plan 兼容模式不开放 /images/generations，万相图模型走 /chat/completions：
以多模态 content（[{type:text,...}]）下发 prompt，响应里 message.content 是
[{type:image, image:<url>}]，取该 URL 下载即可。
旧版用 DashScope 原生异步任务接口（submit → 轮询），已废弃。
"""
import re
import time
import requests
from pathlib import Path
from config import Config
from data_loader import UserRecord
from copy_generator import generate_image_prompt
from image_overlay import overlay_marketing_text


def _extract_image_url(data: dict) -> str:
    """从兼容模式响应里取图片 URL。

    兼容模式返回 DashScope 原生 envelope：output.choices[0].message.content 是 list，
    其中 type=image 的项带 image=<url>。也兼容 OpenAI 形态 choices[0].message.content。
    """
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
        # 可能是 markdown ![](<url>) 或裸 URL
        m = re.search(r"\((https?://[^)]+)\)", content) or re.search(r"(https?://\S+)", content)
        return m.group(1) if m else ""

    return ""


def _request_image(prompt: str, config: Config) -> str:
    """调用万相文生图（Token Plan 兼容模式 /chat/completions），返回图片 URL。"""
    q = config.qianwen_vision
    base = (q.base_url or "").rstrip("/")
    if not base:
        raise RuntimeError("qianwen_vision.base_url 未配置")
    url = f"{base}/chat/completions"

    headers = {
        "Authorization": f"Bearer {q.api_key}",
        "Content-Type": "application/json",
    }
    # 万相图模型要求 content 为多模态 list（[{type:text,text:prompt}]）
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
        raise RuntimeError(f"万相响应无图片 URL: {data}")
    return image_url


def generate_product_image(
    config: Config,
    user: UserRecord,
    product_image_path: str = None,
    skip: bool = False,
    max_retries: int = 3,
    retry_delay: int = 15,
) -> str:
    """调用通义万相生成营销图片，下载到本地，叠加文字，返回最终文件路径"""
    if skip:
        print("[图片] skip=True，使用占位图")
        return ""

    prompt = generate_image_prompt(user, config)

    for attempt in range(1, max_retries + 1):
        try:
            print(f"[图片生成] 第 {attempt}/{max_retries} 次尝试，用户 {user.user_id}...")

            image_url = _request_image(prompt, config)
            print(f"[图片生成] 万相已生成，图片 URL: {image_url}")

            # 如果 _request_image 已落盘（b64 模式）直接拿来用，否则下载
            if image_url.startswith("/") or image_url.startswith("\\") or "://" not in image_url:
                local_path = image_url
            else:
                local_path = download_image(image_url, user.user_id)

            if local_path:
                print(f"[图片生成] ✅ 已就绪: {local_path}")

                # 文字默认由模型直接画进图；仅当 overlay_text=true 时再后期叠加
                if getattr(config.marketing, "overlay_text", False):
                    final_path = overlay_marketing_text(
                        image_path=local_path,
                        discount=user.discount,
                        brand_name=user.brand,
                        cta_text=config.marketing.cta_button,
                    )
                    return final_path
                return local_path

            raise RuntimeError("图片下载失败（空内容）")

        except Exception as e:
            print(f"[图片生成] 第 {attempt}/{max_retries} 失败: {e}")
            if attempt < max_retries:
                print(f"[图片生成] {retry_delay} 秒后重试...")
                time.sleep(retry_delay)

    print(f"[失败] 图片生成已达最大重试次数，用户 {user.user_id}")
    return ""


def download_image(image_url: str, user_id: str, timeout: int = 90) -> str:
    """下载图片到本地 output/images/ 目录，返回本地文件路径"""
    output_dir = Path("output/images")
    output_dir.mkdir(parents=True, exist_ok=True)

    # 用 user_id 和时间戳确保文件名唯一
    filename = f"{user_id}_{int(time.time())}.png"
    local_path = output_dir / filename

    print(f"[下载] 正在从万相下载图片（最长等待 {timeout}s）...")
    resp = requests.get(image_url, timeout=timeout, stream=True)
    resp.raise_for_status()

    content_type = resp.headers.get("content-type", "")
    if "image" not in content_type:
        # 可能返回的是文本/错误页面
        body_preview = resp.text[:200] if resp.text else "(empty)"
        print(f"[下载] ⚠️ 响应不是图片 (Content-Type: {content_type}): {body_preview}")
        return ""

    with open(local_path, "wb") as f:
        total = 0
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            total += len(chunk)

    if total == 0:
        print(f"[下载] ⚠️ 下载的图片为空")
        local_path.unlink(missing_ok=True)
        return ""

    print(f"[下载] ✅ 完成 ({total} bytes)")
    return str(local_path.absolute())
