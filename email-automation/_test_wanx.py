"""临时测试：用真实 key 跑一次万相生成"""
import sys
sys.path.insert(0, 'src')
sys.path.insert(0, '.')

from config import load_config

config = load_config('config.yaml')
# 密钥不入库：直接用 config.yaml 里的真实 key（原脚本曾在此硬编码覆盖，已脱敏）
print("模型:", config.qianwen_vision.model, "| 尺寸:", config.qianwen_vision.image_size)

from data_loader import load_user_data
from image_generator import generate_product_image

user = list(load_user_data('user_data.jsonl'))[0]
print("测试用户:", user.user_id, user.product_en)

out = generate_product_image(config, user)
print("最终结果路径:", out)
