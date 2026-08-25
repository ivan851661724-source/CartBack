"""CartBack 邮件生成子系统（集成 email-automation 流程）

模块划分：
  - config.py         配置加载（YAML / 环境变量，兼容 Node 侧注入）
  - data_loader.py    用户/受众记录数据模型
  - copy_generator.py LLM 文案生成（DeepSeek 主用 + MiniMax 备用）
  - image_generator.py  万相文生图 + 下载
  - image_overlay.py    Pillow 文字 / CTA 叠加
  - email_builder.py    HTML 邮件模板渲染
  - email_sender.py     SMTP / Brevo 发送（保留供后续直接发送用）
  - utils.py            通用工具

Node.js server.js 调用入口：scripts/mailgen.py（stdin JSON → stdout JSON）
"""

__all__ = [
    "config",
    "data_loader",
    "copy_generator",
    "image_generator",
    "image_overlay",
    "email_builder",
    "email_sender",
    "utils",
]
