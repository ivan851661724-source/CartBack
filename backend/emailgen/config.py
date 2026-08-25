"""配置加载模块 — 支持 YAML 文件 + 环境变量 + Node 注入（stdin JSON 的 ai_config 字段）

设计说明：把 email-automation 原先的硬编码 config.yaml 解耦为多层来源，
方便从 Node.js 后端直接复用同一套 AI 配置（避免商家重复填两次密钥）。
优先级：stdin 注入 > 环境变量 > emailgen_config.yaml > 内置默认值。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - pyyaml 缺失时退化为纯 dict 配置
    yaml = None  # type: ignore


# ---------------------------------------------------------------------------
# 数据类
# ---------------------------------------------------------------------------


@dataclass
class MiniMaxConfig:
    api_key: str = ""
    model: str = "MiniMax-M2.7"
    base_url: str = "https://api.minimax.chat/v1"


@dataclass
class DeepSeekConfig:
    api_key: str = ""
    model: str = "deepseek-chat"
    base_url: str = "https://api.deepseek.com"


@dataclass
class QianwenVisionConfig:
    api_key: str = ""
    model: str = "wan2.7-image-pro"
    image_size: str = "768*1152"
    base_url: str = ""


@dataclass
class BrevoConfig:
    api_key: str = ""
    sender_email: str = "hello@example.com"
    sender_name: str = "CartBack"


@dataclass
class EmailSMTPConfig:
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    sender_email: str = ""
    sender_name: str = "CartBack"
    use_ssl: bool = True
    use_tls: bool = False
    cart_url: str = ""


@dataclass
class MarketingConfig:
    discount_priority: bool = True
    urgency_cta: bool = True
    send_window_start: str = "10:30"
    send_window_end: str = "21:00"
    image_main_text: str = "discount_percentage"
    cta_button: str = "Shop Now"
    image_style: str = "tech"
    overlay_text: bool = False


@dataclass
class Config:
    minimax: MiniMaxConfig = field(default_factory=MiniMaxConfig)
    deepseek: Optional[DeepSeekConfig] = None
    qianwen_vision: QianwenVisionConfig = field(default_factory=QianwenVisionConfig)
    brevo: BrevoConfig = field(default_factory=BrevoConfig)
    email: Optional[EmailSMTPConfig] = None
    marketing: MarketingConfig = field(default_factory=MarketingConfig)
    input_file: str = "user_data.jsonl"
    output_dir: str = "output/images"
    # Node 传入时没有 YAML，用这个字段标记来源方便调试
    source: str = "defaults"


# ---------------------------------------------------------------------------
# 加载逻辑
# ---------------------------------------------------------------------------


_DEFAULT_CONFIG_FILENAMES = ("emailgen_config.yaml", "emailgen_config.yml")


def _find_yaml_path(explicit_path: Optional[str] = None) -> Optional[Path]:
    if explicit_path:
        p = Path(explicit_path)
        return p if p.exists() else None
    here = Path(__file__).resolve().parent
    candidates = [here / name for name in _DEFAULT_CONFIG_FILENAMES]
    # 也允许放在 backend 根目录
    candidates += [here.parent / name for name in _DEFAULT_CONFIG_FILENAMES]
    for p in candidates:
        if p.exists():
            return p
    return None


def _read_yaml(path: Path) -> Dict[str, Any]:
    if yaml is None:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _apply_env(cfg: Config) -> None:
    """环境变量覆盖（CI / 容器部署友好）"""
    def set_str(target, field_name, env_key):
        v = os.environ.get(env_key)
        if v is not None:
            setattr(target, field_name, v)

    set_str(cfg.deepseek, "api_key", "CARTBACK_DEEPSEEK_KEY")
    set_str(cfg.deepseek, "base_url", "CARTBACK_DEEPSEEK_URL")
    set_str(cfg.deepseek, "model", "CARTBACK_DEEPSEEK_MODEL")
    set_str(cfg.minimax, "api_key", "CARTBACK_MINIMAX_KEY")
    set_str(cfg.minimax, "base_url", "CARTBACK_MINIMAX_URL")
    set_str(cfg.qianwen_vision, "api_key", "CARTBACK_WANX_KEY")
    set_str(cfg.qianwen_vision, "base_url", "CARTBACK_WANX_URL")
    set_str(cfg.qianwen_vision, "model", "CARTBACK_WANX_MODEL")
    set_str(cfg.marketing, "cta_button", "CARTBACK_CTA")
    set_str(cfg.marketing, "image_style", "CARTBACK_IMAGE_STYLE")


def _apply_node_injection(cfg: Config, ai_config: Optional[Dict[str, Any]]) -> None:
    """Node server.js 从 stdin 传入的 ai_config（复用同一套 AI Key，免重复录入）"""
    if not ai_config:
        return
    provider = (ai_config.get("provider") or ai_config.get("aiProvider") or "deepseek").lower()
    key = str(ai_config.get("apiKey") or ai_config.get("key") or "").strip()
    base = str(ai_config.get("baseUrl") or ai_config.get("aiBaseUrl") or "").strip()
    model = str(ai_config.get("model") or ai_config.get("aiModel") or "").strip()

    if provider == "deepseek" and key:
        if cfg.deepseek is None:
            cfg.deepseek = DeepSeekConfig()
        cfg.deepseek.api_key = key
        if base:
            cfg.deepseek.base_url = base
        if model:
            cfg.deepseek.model = model
    elif provider == "minimax" and key:
        cfg.minimax.api_key = key
        if base:
            cfg.minimax.base_url = base
        if model:
            cfg.minimax.model = model

    # 视觉 / 图片模型（独立字段）
    vk = str(ai_config.get("visionKey") or ai_config.get("wanxKey") or "").strip()
    vu = str(ai_config.get("visionBaseUrl") or ai_config.get("wanxBaseUrl") or "").strip()
    vm = str(ai_config.get("visionModel") or ai_config.get("wanxModel") or "").strip()
    if vk:
        cfg.qianwen_vision.api_key = vk
    if vu:
        cfg.qianwen_vision.base_url = vu
    if vm:
        cfg.qianwen_vision.model = vm


def load_config(
    config_path: Optional[str] = None,
    ai_config: Optional[Dict[str, Any]] = None,
) -> Config:
    """加载配置（多来源聚合）"""
    cfg = Config()

    yaml_path = _find_yaml_path(config_path)
    if yaml_path:
        raw = _read_yaml(yaml_path)
        cfg.source = f"yaml:{yaml_path.name}"
        m = raw.get("minimax") or {}
        ds = raw.get("deepseek") or {}
        q = raw.get("qianwen_vision") or {}
        b = raw.get("brevo") or {}
        e = raw.get("email") or {}
        mk = raw.get("marketing") or {}
        d = raw.get("data") or {}

        if isinstance(m, dict):
            for k in ("api_key", "model", "base_url"):
                if m.get(k):
                    setattr(cfg.minimax, k, m[k])
        if isinstance(ds, dict) and ds.get("api_key"):
            cfg.deepseek = DeepSeekConfig(
                api_key=ds.get("api_key", ""),
                model=ds.get("model", "deepseek-chat"),
                base_url=ds.get("base_url", "https://api.deepseek.com"),
            )
        if isinstance(q, dict):
            for k in ("api_key", "model", "image_size", "base_url"):
                if q.get(k):
                    setattr(cfg.qianwen_vision, k, q[k])
        if isinstance(b, dict):
            for k in ("api_key", "sender_email", "sender_name"):
                if b.get(k):
                    setattr(cfg.brevo, k, b[k])
        if isinstance(e, dict) and e.get("smtp_host"):
            cfg.email = EmailSMTPConfig(
                smtp_host=e.get("smtp_host", ""),
                smtp_port=int(e.get("smtp_port", 465)),
                smtp_user=e.get("smtp_user", ""),
                smtp_password=e.get("smtp_password", ""),
                sender_email=e.get("sender_email", ""),
                sender_name=e.get("sender_name", ""),
                use_ssl=bool(e.get("use_ssl", True)),
                use_tls=bool(e.get("use_tls", False)),
                cart_url=e.get("cart_url", ""),
            )
        if isinstance(mk, dict):
            ar = mk.get("abandonment_recovery") or mk
            if isinstance(ar, dict):
                for k, fk in (
                    ("discount_priority", "discount_priority"),
                    ("urgency_cta", "urgency_cta"),
                    ("overlay_text", "overlay_text"),
                ):
                    if ar.get(k) is not None:
                        setattr(cfg.marketing, fk, bool(ar[k]))
                sw = ar.get("send_window") or {}
                if isinstance(sw, dict):
                    if sw.get("start"):
                        cfg.marketing.send_window_start = sw["start"]
                    if sw.get("end"):
                        cfg.marketing.send_window_end = sw["end"]
                ir = ar.get("image_requirements") or {}
                if isinstance(ir, dict):
                    if ir.get("main_text"):
                        cfg.marketing.image_main_text = ir["main_text"]
                    if ir.get("cta_button"):
                        cfg.marketing.cta_button = ir["cta_button"]
                    if ir.get("style"):
                        cfg.marketing.image_style = ir["style"]
        if isinstance(d, dict) and d.get("input_file"):
            cfg.input_file = d["input_file"]
    else:
        # 没有 yaml：若环境变量里有 deepseek key，初始化 deepseek
        ds_key = os.environ.get("CARTBACK_DEEPSEEK_KEY")
        if ds_key:
            cfg.deepseek = DeepSeekConfig(api_key=ds_key)
        cfg.source = "env+defaults"

    _apply_env(cfg)
    _apply_node_injection(cfg, ai_config)
    return cfg
