"""卖家二次确认界面（Flask）"""
import json
import os
import uuid
from pathlib import Path
from datetime import datetime
from flask import Flask, jsonify, request, render_template_string, redirect, url_for

app = Flask(__name__)

PENDING_FILE = "pending_approvals.json"


def load_pending():
    """加载待确认队列"""
    if not os.path.exists(PENDING_FILE):
        return []
    with open(PENDING_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_pending(records):
    """保存待确认队列"""
    with open(PENDING_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def mask_email(email: str) -> str:
    """脱敏邮箱，只显示前两位和域名"""
    parts = email.split("@")
    if len(parts) != 2:
        return email
    local = parts[0]
    domain = parts[1]
    masked_local = local[:2] + "***" if len(local) > 2 else local
    return f"{masked_local}@{domain}"


# HTML 模板（内联，简单实现）
APPROVAL_PAGE = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>邮件确认队列</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; padding: 20px; }
    h1 { margin-bottom: 20px; color: #1a1a1a; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .card-email { font-weight: 600; font-size: 16px; color: #333; }
    .card-meta { font-size: 13px; color: #888; }
    .card-subject { font-size: 15px; color: #1a1a1a; margin-bottom: 8px; font-weight: 500; }
    .card-image { max-width: 200px; border-radius: 4px; margin: 8px 0; }
    .card-actions { display: flex; gap: 10px; margin-top: 12px; }
    .btn { padding: 8px 20px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; }
    .btn-approve { background: #52c41a; color: white; }
    .btn-approve:hover { background: #389e0d; }
    .btn-reject { background: #ff4d4f; color: white; }
    .btn-reject:hover { background: #cf1322; }
    .btn-edit { background: #1890ff; color: white; }
    .btn-edit:hover { background: #096dd9; }
    .empty { text-align: center; color: #999; padding: 60px; font-size: 16px; }
    .count { font-size: 14px; color: #666; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>📬 邮件确认队列</h1>
  <div class="count">共 {{ records|length }} 条待确认</div>

  {% if records %}
    {% for r in records %}
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-email">{{ r.email_masked }}</div>
          <div class="card-meta">{{ r.brand }} · {{ r.discount }}% OFF · {{ r.timestamp }}</div>
        </div>
        <div class="card-meta">ID: {{ r.id[:8] }}...</div>
      </div>

      <div class="card-subject">{{ r.subject }}</div>

      <div style="font-size: 14px; color: #555; margin: 8px 0 12px; line-height: 1.5;">
        {{ r.body[:150] }}{% if r.body|length > 150 %}...{% endif %}
      </div>

      <img src="{{ r.image_url }}" alt="营销图" class="card-image" onerror="this.style.display='none'" />

      <div class="card-actions">
        <button class="btn btn-approve" onclick="approve('{{ r.id }}')">✅ 批准发送</button>
        <button class="btn btn-reject" onclick="reject('{{ r.id }}')">❌ 拒绝</button>
        <button class="btn btn-edit" onclick="edit('{{ r.id }}')">✏️ 编辑</button>
      </div>
    </div>
    {% endfor %}
  {% else %}
    <div class="empty">暂无待确认邮件 🎉</div>
  {% endif %}

  <script>
    async function approve(id) {
      if (!confirm('确认批准发送此邮件？')) return;
      let res = await fetch(`/approve/${id}`);
      let data = await res.json();
      if (data.status === 'ok') {
        location.reload();
      } else {
        alert('操作失败: ' + data.error);
      }
    }

    async function reject(id) {
      if (!confirm('确认拒绝此邮件？')) return;
      let res = await fetch(`/reject/${id}`);
      let data = await res.json();
      if (data.status === 'ok') {
        location.reload();
      } else {
        alert('操作失败: ' + data.error);
      }
    }

    function edit(id) {
      window.location.href = `/edit/${id}`;
    }
  </script>
</body>
</html>
"""


@app.route("/")
def index():
    records = load_pending()
    for r in records:
        r["email_masked"] = mask_email(r["email"])
    return render_template_string(APPROVAL_PAGE, records=records)


@app.route("/approve/<record_id>")
def approve(record_id):
    """批准发送邮件"""
    from src.email_sender import send_single_email, EmailMessage
    from config import load as load_config
    from src.email_builder import build_email_html

    records = load_pending()
    record = None
    for r in records:
        if r["id"] == record_id:
            record = r
            break

    if not record:
        return jsonify({"status": "error", "error": "记录不存在"})

    try:
        config = load_config("config.yaml")
        html = build_email_html(
            subject=record["subject"],
            body=record["body"],
            image_url=record["image_url"],
            cart_url=record["cart_url"],
            brand_name=record["brand"],
            discount=record["discount"],
        )
        message = EmailMessage(
            to_email=record["email"],
            to_name=record.get("to_name", ""),
            subject=record["subject"],
            html_content=html,
        )
        result = send_single_email(config, message)

        # 从待确认队列移除
        records = [r for r in records if r["id"] != record_id]
        save_pending(records)

        return jsonify({"status": "ok", "message_id": result.get("message_id")})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)})


@app.route("/reject/<record_id>")
def reject(record_id):
    """拒绝邮件"""
    records = load_pending()
    records = [r for r in records if r["id"] != record_id]
    save_pending(records)
    return jsonify({"status": "ok"})


@app.route("/edit/<record_id>")
def edit_page(record_id):
    """编辑邮件内容"""
    records = load_pending()
    record = None
    for r in records:
        if r["id"] == record_id:
            record = r
            break

    if not record:
        return "记录不存在", 404

    return f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>编辑邮件</title>
      <style>
        body {{ font-family: sans-serif; padding: 20px; max-width: 700px; margin: 0 auto; }}
        h1 {{ margin-bottom: 20px; }}
        label {{ display: block; font-weight: bold; margin: 12px 0 4px; }}
        input, textarea {{ width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }}
        textarea {{ height: 100px; }}
        .btn {{ margin-top: 16px; padding: 10px 24px; border: none; border-radius: 6px; cursor: pointer; font-size: 15px; }}
        .btn-save {{ background: #52c41a; color: white; }}
        .btn-cancel {{ background: #999; color: white; text-decoration: none; display: inline-block; }}
      </style>
    </head>
    <body>
      <h1>✏️ 编辑邮件</h1>
      <form action="/update/{record_id}" method="POST">
        <label>收件人</label>
        <input type="text" value="{record['email']}" readonly />

        <label>主题</label>
        <input name="subject" value="{record['subject']}" />

        <label>正文</label>
        <textarea name="body">{record['body']}</textarea>

        <label>图片 URL</label>
        <input name="image_url" value="{record['image_url']}" />

        <label>购物链接</label>
        <input name="cart_url" value="{record['cart_url']}" />

        <div style="margin-top: 16px;">
          <button type="submit" class="btn btn-save">💾 保存</button>
          <a href="/" class="btn btn-cancel">取消</a>
        </div>
      </form>
    </body>
    </html>
    """


@app.route("/update/<record_id>", methods=["POST"])
def update(record_id):
    """更新邮件内容"""
    records = load_pending()
    for r in records:
        if r["id"] == record_id:
            r["subject"] = request.form.get("subject", r["subject"])
            r["body"] = request.form.get("body", r["body"])
            r["image_url"] = request.form.get("image_url", r["image_url"])
            r["cart_url"] = request.form.get("cart_url", r["cart_url"])
            r["updated"] = datetime.now().isoformat()
            break

    save_pending(records)
    return redirect("/")


def run_server(port: int = 5123):
    """启动确认界面服务"""
    app.run(host="0.0.0.0", port=port, debug=False)
