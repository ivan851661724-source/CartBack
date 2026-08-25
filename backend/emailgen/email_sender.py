"""邮件发送模块 — SMTP / Brevo

说明：CartBack v3 的真实发送在 Node 端通过 Resend / fetch 直接做（有发送频率限频、
批量收件人隔离、重试、归因日志等一整套围栏）。本模块保留给本地脚本批量生成 + 直接
触达的场景（如 offline eval、本地 SMTP 测试、一键发邮件脚本）。
"""
from __future__ import annotations

import os
import smtplib
import ssl
from dataclasses import dataclass
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import List, Optional

import requests

from .config import Config


@dataclass
class EmailMessage:
    to_email: str
    to_name: str
    subject: str
    html_content: str
    image_path: str = ""  # CID 内嵌用的本地路径


def _build_smtp_message(config: Config, message: EmailMessage) -> MIMEMultipart:
    msg = MIMEMultipart("related")
    msg["Subject"] = message.subject
    sender_name = ""
    sender_email = ""
    if config.email:
        sender_name = config.email.sender_name or ""
        sender_email = config.email.sender_email or ""
    if not sender_email and config.brevo.sender_email:
        sender_name = config.brevo.sender_name or ""
        sender_email = config.brevo.sender_email
    msg["From"] = f"{sender_name} <{sender_email}>" if sender_name else sender_email
    msg["To"] = message.to_email

    alt = MIMEMultipart("alternative")
    cart_url = config.email.cart_url if config.email else (config.brevo.api_key and "https://cartback.demo" or "")
    text_part = MIMEText(
        f"{message.subject}\n\nView this email in your browser:\n{cart_url or 'https://cartback.demo'}",
        "plain",
        "utf-8",
    )
    html_part = MIMEText(message.html_content, "html", "utf-8")
    alt.attach(text_part)
    alt.attach(html_part)
    msg.attach(alt)

    if message.image_path and os.path.exists(message.image_path):
        with open(message.image_path, "rb") as f:
            img = MIMEImage(f.read())
            img.add_header("Content-ID", "<hero-image>")
            img.add_header("Content-Disposition", "inline", filename="hero.png")
            img.add_header("X-Attachment-Id", "hero-image")
            msg.attach(img)

    return msg


def send_smtp_email(config: Config, message: EmailMessage) -> dict:
    if config.email is None:
        return {"success": False, "error": "SMTP 未配置", "method": "smtp"}
    msg = _build_smtp_message(config, message)
    try:
        host = config.email.smtp_host
        port = int(config.email.smtp_port or 465)
        if config.email.use_ssl:
            with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=30) as s:
                if config.email.smtp_user:
                    s.login(config.email.smtp_user, config.email.smtp_password)
                s.sendmail(config.email.sender_email, [message.to_email], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=30) as s:
                if config.email.use_tls:
                    s.starttls(context=ssl.create_default_context())
                if config.email.smtp_user:
                    s.login(config.email.smtp_user, config.email.smtp_password)
                s.sendmail(config.email.sender_email, [message.to_email], msg.as_string())
        return {"success": True, "to": message.to_email, "method": "smtp"}
    except smtplib.SMTPException as e:
        return {"success": False, "to": message.to_email, "error": str(e), "method": "smtp"}


def _send_brevo_email(config: Config, message: EmailMessage) -> dict:
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


def send_single_email(config: Config, message: EmailMessage) -> dict:
    if config.brevo.api_key:
        try:
            return _send_brevo_email(config, message)
        except Exception as e:
            return {"success": False, "error": str(e), "method": "brevo"}
    if config.email and config.email.smtp_host:
        return send_smtp_email(config, message)
    return {"success": False, "error": "未配置任何发送渠道（Brevo / SMTP）"}


def send_batch_emails(config: Config, messages: List[EmailMessage]) -> List[dict]:
    results: List[dict] = []
    for m in messages:
        r = send_single_email(config, m)
        status = "✅" if r.get("success") else "❌"
        print(f"[{status}] {m.to_email} → {r.get('error') or r.get('message_id') or 'OK'}", flush=True)
        results.append(r)
    return results
