"""邮件发送模块 - 支持 SMTP 和 Brevo API"""
import smtplib
import ssl
import os
import requests
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from typing import List, Optional
from dataclasses import dataclass
from pathlib import Path
from config import Config


@dataclass
class EmailMessage:
    to_email: str
    to_name: str
    subject: str
    html_content: str
    image_path: str = ""  # 本地图片路径，用于 CID 内嵌


def _build_smtp_message(config: Config, message: EmailMessage) -> MIMEMultipart:
    """构建 SMTP 邮件消息（支持 CID 内嵌图片）"""
    msg = MIMEMultipart("related")
    msg["Subject"] = message.subject
    msg["From"] = f"{config.email.sender_name} <{config.email.sender_email}>"
    msg["To"] = message.to_email

    # 纯文本版本
    alt = MIMEMultipart("alternative")
    text_part = MIMEText(
        f"{message.subject}\n\n"
        f"View this email in your browser:\n{config.email.cart_url or 'https://example.com'}",
        "plain",
        "utf-8",
    )
    html_part = MIMEText(message.html_content, "html", "utf-8")
    alt.attach(text_part)
    alt.attach(html_part)
    msg.attach(alt)

    # CID 内嵌图片（解决邮件客户端加载外部图片失败的问题）
    if message.image_path and os.path.exists(message.image_path):
        with open(message.image_path, "rb") as f:
            img = MIMEImage(f.read())
            img.add_header("Content-ID", "<hero-image>")
            img.add_header("Content-Disposition", "inline", filename="hero.jpg")
            img.add_header("X-Attachment-Id", "hero-image")
            msg.attach(img)

    return msg


def send_smtp_email(config: Config, message: EmailMessage) -> dict:
    """通过 SMTP 发送单封邮件"""
    msg = _build_smtp_message(config, message)

    try:
        with smtplib.SMTP_SSL(
            config.email.smtp_host,
            config.email.smtp_port,
            context=ssl.create_default_context(),
            timeout=30,
        ) as server:
            server.login(config.email.smtp_user, config.email.smtp_password)
            server.sendmail(
                config.email.sender_email,
                [message.to_email],
                msg.as_string(),
            )
        return {"success": True, "to": message.to_email, "method": "smtp"}
    except smtplib.SMTPException as e:
        return {"success": False, "to": message.to_email, "error": str(e), "method": "smtp"}


def send_single_email(config: Config, message: EmailMessage) -> dict:
    """发送单封邮件（自动选择 SMTP 或 Brevo）"""
    # 如果配置了 Brevo API Key，优先用 Brevo
    if config.brevo.api_key:
        return _send_brevo_email(config, message)
    else:
        return send_smtp_email(config, message)


def send_batch_emails(config: Config, messages: List[EmailMessage]) -> List[dict]:
    """批量发送邮件"""
    results = []
    for msg in messages:
        result = send_single_email(config, msg)
        results.append(result)
        status = "✅" if result.get("success") else "❌"
        print(f"[{status}] {msg.to_email} → {result.get('error', result.get('message_id', 'OK'))}")
    return results


# --- Brevo API ---


def _send_brevo_email(config: Config, message: EmailMessage) -> dict:
    """通过 Brevo API 发送邮件"""
    url = "https://api.brevo.com/v3/smtp/email"
    headers = {
        "Authorization": f"Bearer {config.brevo.api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "to": [{"email": message.to_email, "name": message.to_name}],
        "subject": message.subject,
        "htmlContent": message.html_content,
        "sender": {
            "email": config.brevo.sender_email,
            "name": config.brevo.sender_name,
        },
    }

    response = requests.post(url, headers=headers, json=payload, timeout=30)
    response.raise_for_status()

    result = response.json()
    return {
        "success": True,
        "message_id": result.get("messageId", ""),
        "to": message.to_email,
        "method": "brevo",
    }
