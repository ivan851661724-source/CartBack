# 邮件自动化工作流

海外购物网站用户数据 → 画像分析 → 文案生成（MiniMax） → 图片生成（通义万相） → HTML 邮件合成 → 卖家二次确认 → Brevo 发送

## 项目结构

```
email-automation/
├── config.yaml              # 配置文件（API Keys）
├── config.py                # 配置加载模块
├── main.py                  # 主入口
├── user_data.jsonl          # 用户数据（JSON Lines 格式）
├── pending_approvals.json   # 待确认邮件队列（自动生成）
├── src/
│   ├── data_loader.py       # 用户数据加载
│   ├── copy_generator.py    # 文案生成（MiniMax）+ 图片 Prompt
│   ├── image_generator.py   # 图片生成（通义万相）
│   ├── email_builder.py     # HTML 邮件合成
│   ├── email_sender.py      # Brevo API 发送
│   └── approval_ui.py       # 卖家确认界面（Flask）
├── templates/
│   └── email_template.html  # 邮件模板
└── requirements.txt
```

## 配置

编辑 `config.yaml`，填入以下 API Key：

| 配置项 | 获取地址 |
|--------|----------|
| `minimax.api_key` | Hermes 已配置（同主会话） |
| `qianwen_vision.api_key` | 阿里云百炼控制台 → API-KEY |
| `brevo.api_key` | brevo.com → Settings → API Keys |
| `brevo.sender_email` | 发件人邮箱地址 |

## 安装依赖

```bash
pip install -r requirements.txt
```

## 用户数据格式

`user_data.jsonl`，每行一个 JSON 对象：

```json
{"user_id":"U001","email":"user@example.com","brand":"Leo's PhoneCase","gender":"male","age_range":"25-35","city_tier":"1","device":"iPhone","product":"透明硅胶手机壳","product_cn":"透明硅胶手机壳","product_en":"Clear Silicone Phone Case","discount":8,"goal":"abandonment_recovery","send_window":"10:30-21:00","locale":"en-US","cart_url":"https://example.com/cart"}
```

## 运行命令

### 1. 模拟运行（不调用真实 API，不保存队列）

```bash
python main.py --dry-run
```

### 2. 生成邮件并加入待确认队列

```bash
python main.py --product-image /path/to/product.png
```

### 3. 启动卖家确认界面

```bash
python main.py --server --port 5123
```

然后打开 http://localhost:5123 查看待确认邮件列表。

### 4. 发送已批准的邮件

```bash
python main.py --send-approved
```

### 5. 处理指定用户

```bash
python main.py --product-image /path/to/product.png --user-id U001
```

## 工作流说明

1. **数据加载** — 读取 `user_data.jsonl`，流式处理
2. **文案生成** — 调用 MiniMax API 生成邮件主题+正文
3. **图片生成** — 调用通义万相 `wanx2.1-product-spec` 模型生成营销图（折扣为主文案 + Shop Now 按钮）
4. **邮件合成** — 拼接 HTML（响应式设计，600px 居中）
5. **卖家确认** — Flask 界面，批准后调用 Brevo 发送

## API 文档

- MiniMax: https://www.minimaxi.com/document/API%20Documentation
- 通义万相: https://help.aliyun.com/zh/dashscope/
- Brevo: https://developers.brevo.com/docs
