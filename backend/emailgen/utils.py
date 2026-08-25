"""通用工具函数"""
from __future__ import annotations

import os
import platform
import subprocess


def notify(title: str, message: str) -> None:
    """桌面通知（仅 macOS / Windows / Linux 各自尽力而为，失败不抛异常）"""
    try:
        if platform.system() == "Darwin":
            safe_title = title.replace('"', '\\"')
            safe_msg = message.replace('"', '\\"')
            script = f'display notification "{safe_msg}" with title "{safe_title}"'
            os.system(f"osascript -e '{script}' >/dev/null 2>&1")
        elif platform.system() == "Linux":
            subprocess.run(
                ["notify-send", title, message],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif platform.system() == "Windows":
            try:
                from win10toast import ToastNotifier  # type: ignore
                ToastNotifier().show_toast(title, message, duration=3, threaded=True)
            except Exception:
                pass
    except Exception:
        pass  # 通知是增强体验，失败绝对不能影响主流程
