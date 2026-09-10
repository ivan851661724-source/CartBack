"""配置加载模块"""
import yaml
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


@dataclass
class MiniMaxConfig:
    api_key: str
    model: str
    base_url: str


@dataclass
class DeepSeekConfig:
    api_key: str
    model: str
    base_url: str


@dataclass
class QianwenVisionConfig:
    api_key: str
    model: str
    image_size: str
    base_url: str = ""


@dataclass
class BrevoConfig:
    api_key: str
    sender_email: str
    sender_name: str


@dataclass
class EmailSMTPConfig:
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    sender_email: str
    sender_name: str
    use_ssl: bool = True
    use_tls: bool = False
    cart_url: str = ""


@dataclass
class MarketingConfig:
    discount_priority: bool
    urgency_cta: bool
    send_window_start: str
    send_window_end: str
    image_main_text: str
    cta_button: str
    image_style: str
    overlay_text: bool = False


@dataclass
class Config:
    minimax: MiniMaxConfig
    deepseek: Optional[DeepSeekConfig]
    qianwen_vision: QianwenVisionConfig
    brevo: BrevoConfig
    email: Optional[EmailSMTPConfig]
    marketing: MarketingConfig
    input_file: str


def load_config(config_path: str = "config.yaml") -> Config:
    """加载 YAML 配置文件"""
    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    m = raw["minimax"]
    q = raw["qianwen_vision"]
    ds = raw.get("deepseek", {})
    b = raw.get("brevo", {})
    email_cfg = raw.get("email", {})
    mk = raw["marketing"]
    data_cfg = raw["data"]

    # email 配置可选
    email = None
    if email_cfg and email_cfg.get("smtp_host"):
        email = EmailSMTPConfig(
            smtp_host=email_cfg["smtp_host"],
            smtp_port=email_cfg.get("smtp_port", 465),
            smtp_user=email_cfg.get("smtp_user", ""),
            smtp_password=email_cfg.get("smtp_password", ""),
            sender_email=email_cfg.get("sender_email", ""),
            sender_name=email_cfg.get("sender_name", ""),
            use_ssl=email_cfg.get("use_ssl", True),
            use_tls=email_cfg.get("use_tls", False),
            cart_url=email_cfg.get("cart_url", ""),
        )

    return Config(
        minimax=MiniMaxConfig(
            api_key=m["api_key"],
            model=m["model"],
            base_url=m["base_url"],
        ),
        deepseek=DeepSeekConfig(
            api_key=ds["api_key"],
            model=ds.get("model", "deepseek-chat"),
            base_url=ds.get("base_url", "https://api.deepseek.com"),
        ) if ds.get("api_key") else None,
        qianwen_vision=QianwenVisionConfig(
            api_key=q["api_key"],
            model=q["model"],
            image_size=q["image_size"],
            base_url=q.get("base_url", ""),
        ),
        brevo=BrevoConfig(
            api_key=b.get("api_key", ""),
            sender_email=b.get("sender_email", ""),
            sender_name=b.get("sender_name", ""),
        ),
        email=email,
        marketing=MarketingConfig(
            discount_priority=mk["abandonment_recovery"]["discount_priority"],
            urgency_cta=mk["abandonment_recovery"]["urgency_cta"],
            send_window_start=mk["abandonment_recovery"]["send_window"]["start"],
            send_window_end=mk["abandonment_recovery"]["send_window"]["end"],
            image_main_text=mk["abandonment_recovery"]["image_requirements"]["main_text"],
            cta_button=mk["abandonment_recovery"]["image_requirements"]["cta_button"],
            image_style=mk["abandonment_recovery"]["image_requirements"]["style"],
            overlay_text=mk["abandonment_recovery"]["image_requirements"].get("overlay_text", False),
        ),
        input_file=data_cfg["input_file"],
    )
