"""邮件自动化工作流 - 主入口"""
import os
import sys
import json
import uuid
import argparse
from datetime import datetime
from pathlib import Path

# 确保 src/ 在模块搜索路径中
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
sys.path.insert(0, os.path.dirname(__file__))

from config import load_config, Config
from data_loader import load_user_data, count_users, UserRecord
from copy_generator import generate_copy, generate_image_prompt
from image_generator import generate_product_image
from email_builder import build_email_html
from email_sender import send_single_email, EmailMessage
from utils import notify


PENDING_FILE = "pending_approvals.json"


def load_pending():
    if not os.path.exists(PENDING_FILE):
        return []
    with open(PENDING_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_pending(records):
    with open(PENDING_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def append_pending(record):
    records = load_pending()
    records.append(record)
    save_pending(records)


def mask_email(email: str) -> str:
    parts = email.split("@")
    if len(parts) != 2:
        return email
    local = parts[0]
    domain = parts[1]
    masked_local = local[:2] + "***" if len(local) > 2 else local
    return f"{masked_local}@{domain}"


def process_single_user(
    user: UserRecord,
    config: Config,
    product_image_path: str,
    dry_run: bool = False,
    skip_image: bool = False,
) -> dict:
    """处理单个用户，生成邮件并加入待确认队列"""
    print(f"\n{'='*50}")
    print(f"处理用户: {user.user_id} | {mask_email(user.email)}")
    print(f"{'='*50}")

    # 1. 生成文案
    print("[1/4] 生成文案...")
    try:
        copy = generate_copy(config, user)
        print(f"    主题: {copy['subject']}")
    except Exception as e:
        print(f"[错误] 文案生成失败: {e}")
        return {"status": "error", "user_id": user.user_id, "step": "copy", "error": str(e)}

    # 2. 生成图片
    print("[2/4] 生成图片...")
    image_path = generate_product_image(config, user, product_image_path, skip=skip_image)
    image_url = image_path  # 现在返回的是本地路径
    use_cid = bool(image_path)  # 本地路径存在则用 CID 内嵌
    if not image_path:
        print(f"[警告] 图片生成失败，使用占位图")
        image_url = "https://via.placeholder.com/600x750/ff6b35/ffffff?text=LEO'S+PHONECASE"
        use_cid = False

    # 3. 合成 HTML
    print("[3/4] 合成 HTML 邮件...")
    try:
        html = build_email_html(
            subject=copy["subject"],
            body=copy["body"],
            image_url=image_url,
            cart_url=user.cart_url,
            brand_name=user.brand,
            discount=user.discount,
            use_cid=use_cid,
        )
    except Exception as e:
        print(f"[错误] HTML 合成失败: {e}")
        return {"status": "error", "user_id": user.user_id, "step": "html", "error": str(e)}

    if dry_run:
        print("[DRY RUN] 跳过保存，直接返回")
        return {
            "status": "dry_run_ok",
            "user_id": user.user_id,
            "subject": copy["subject"],
            "image_url": image_url,
            "html_preview": html[:500],
        }

    # 4. 加入待确认队列
    print("[4/4] 加入待确认队列...")
    record = {
        "id": str(uuid.uuid4()),
        "user_id": user.user_id,
        "email": user.email,
        "brand": user.brand,
        "discount": user.discount,
        "subject": copy["subject"],
        "body": copy["body"],
        "image_url": image_url,
        "image_path": image_path,  # 本地图片路径，发送时用作 CID 内嵌
        "cart_url": user.cart_url,
        "locale": user.locale,
        "timestamp": datetime.now().isoformat(),
    }
    append_pending(record)
    print(f"[完成] 已加入待确认队列")

    return {"status": "ok", "user_id": user.user_id, "record_id": record["id"]}


def process_all(
    config_path: str = "config.yaml",
    product_image_path: str = None,
    dry_run: bool = False,
    user_id: str = None,
    send_approved: bool = False,
    skip_image: bool = False,
):
    """处理所有用户或指定用户"""
    # 加载配置
    try:
        config = load_config(config_path)
    except Exception as e:
        print(f"[错误] 配置加载失败: {e}")
        return

    # 检查产品图路径
    if not product_image_path:
        product_image_path = "product_images/default.png"
        print(f"[提示] 未指定产品图，使用默认路径: {product_image_path}")
    else:
        if not os.path.exists(product_image_path):
            print(f"[错误] 产品图文件不存在: {product_image_path}")
            return

    # 加载用户数据
    input_file = config.input_file
    if not os.path.exists(input_file):
        print(f"[错误] 用户数据文件不存在: {input_file}")
        return

    total_users = count_users(input_file)
    print(f"用户数据: {input_file}，共 {total_users} 条记录")

    # 处理每个用户
    results = []
    for user in load_user_data(input_file):
        if user_id and user.user_id != user_id:
            continue

        result = process_single_user(user, config, product_image_path, dry_run, skip_image)
        results.append(result)

    # 汇总
    print(f"\n{'='*50}")
    print(f"处理完成，共 {len(results)} 条")
    ok = sum(1 for r in results if r["status"] == "ok")
    dry = sum(1 for r in results if r["status"] == "dry_run_ok")
    err = sum(1 for r in results if r["status"] == "error")
    print(f"  成功: {ok}")
    print(f"  模拟运行: {dry}")
    print(f"  失败: {err}")

    if err > 0:
        print("\n失败详情:")
        for r in results:
            if r["status"] == "error":
                print(f"  {r['user_id']} | {r['step']} | {r['error']}")

    # macOS 通知
    if err == 0 and ok > 0:
        notify("✅ 邮件生成完成", f"成功生成 {ok} 封邮件，已加入待确认队列")
    elif err > 0:
        notify("⚠️ 邮件生成完成", f"完成 {ok} 封，失败 {err} 封，请检查日志")
    elif dry > 0:
        notify("🔵 Dry Run 完成", f"模拟运行 {dry} 条，无实际邮件生成")

    # 发送已批准的邮件
    if send_approved:
        print("\n发送已批准的邮件...")
        send_approved_emails(config)


def send_approved_emails(config: Config):
    """发送所有已批准且未发送的邮件"""
    pending = load_pending()
    if not pending:
        print("没有待发送的邮件")
        return

    print(f"待发送邮件: {len(pending)} 封")

    for record in pending:
        try:
            image_path = record.get("image_path", "")
            use_cid = bool(image_path and os.path.exists(image_path))
            html = build_email_html(
                subject=record["subject"],
                body=record["body"],
                image_url=record["image_url"],
                cart_url=record["cart_url"],
                brand_name=record["brand"],
                discount=record["discount"],
                use_cid=use_cid,
            )
            message = EmailMessage(
                to_email=record["email"],
                to_name="",
                subject=record["subject"],
                html_content=html,
                image_path=image_path if use_cid else "",
            )
            result = send_single_email(config, message)
            print(f"  ✅ {mask_email(record['email'])} → {result.get('message_id')}")
            notify("📧 邮件已发送", f"→ {mask_email(record['email'])}")
        except Exception as e:
            print(f"  ❌ {mask_email(record['email'])} → {e}")
            notify("❌ 邮件发送失败", f"→ {mask_email(record['email'])}: {e}")


def main():
    parser = argparse.ArgumentParser(description="邮件自动化工作流")
    parser.add_argument("--config", default="config.yaml", help="配置文件路径")
    parser.add_argument("--product-image", default=None, help="产品图路径")
    parser.add_argument("--dry-run", action="store_true", help="只生成，不保存到队列")
    parser.add_argument("--user-id", default=None, help="只处理指定用户 ID")
    parser.add_argument("--send-approved", action="store_true", help="发送已批准的邮件")
    parser.add_argument("--skip-image", action="store_true", help="跳过图片生成（仅测文案）")
    parser.add_argument("--server", action="store_true", help="启动卖家确认界面")
    parser.add_argument("--port", type=int, default=5123, help="确认界面端口")

    args = parser.parse_args()

    if args.server:
        print(f"启动卖家确认界面: http://localhost:{args.port}")
        from src.approval_ui import run_server
        run_server(port=args.port)
    else:
        process_all(
            config_path=args.config,
            product_image_path=args.product_image,
            dry_run=args.dry_run,
            user_id=args.user_id,
            send_approved=args.send_approved,
            skip_image=args.skip_image,
        )


if __name__ == "__main__":
    main()
