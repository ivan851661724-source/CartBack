"""检查阿里云万象可用模型（密钥读本地 config.yaml，不入库）"""
import sys
import requests

sys.path.insert(0, '.')
from config import load_config

api_key = load_config('config.yaml').qianwen_vision.api_key
url = "https://dashscope.aliyuncs.com/api/v1/models"
headers = {"Authorization": f"Bearer {api_key}"}

try:
    r = requests.get(url, headers=headers, timeout=15)
    print(f"Status: {r.status_code}")
    data = r.json()
    models = data.get("data", {}).get("models", [])
    print(f"Total models: {len(models)}")
    for m in models:
        model_id = m.get("id", "")
        if "wanx" in model_id.lower() or "image" in model_id.lower() or "t2i" in model_id.lower():
            print(f"  IMAGE MODEL: {model_id}")
    print("\nAll Wanx models:")
    for m in models:
        if "wanx" in m.get("id", "").lower():
            print(f"  {m.get('id')}")
except Exception as e:
    print(f"Error: {e}")
