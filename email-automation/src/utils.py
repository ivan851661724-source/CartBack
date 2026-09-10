"""通用工具函数"""
import os


def notify(title: str, message: str):
    """macOS 系统通知"""
    script = f'display notification "{message}" with title "{title}"'
    os.system(f"osascript -e '{script}'")
