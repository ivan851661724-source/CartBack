"""调试 MiniMax API 响应"""
import sys, requests, re, json as json_lib
sys.path.insert(0, 'src')
sys.path.insert(0, '.')

from copy_generator import build_copy_prompt
from data_loader import load_user_data
from config import load_config

config = load_config('config.yaml')
users = list(load_user_data('user_data.jsonl'))
user = users[0]

url = f'{config.minimax.base_url}/chat/completions'
headers = {
    'Authorization': f'Bearer {config.minimax.api_key}',
    'Content-Type': 'application/json',
}
prompt = build_copy_prompt(user)
payload = {
    'model': config.minimax.model,
    'messages': [{'role': 'user', 'content': prompt}],
    'max_tokens': 1000,
}

print('Calling MiniMax API...', flush=True)
r = requests.post(url, headers=headers, json=payload, timeout=45)
print(f'Status: {r.status_code}', flush=True)
raw = r.json()
content = raw['choices'][0]['message']['content']
print(f'Content length: {len(content)}', flush=True)
print(f'Last 500 chars:\n{repr(content[-500:])}', flush=True)

# Test cleaning approaches
clean_literal = content.replace("<think>", "").replace("</think>", "").strip()
print(f'\nAfter literal replace: {repr(clean_literal[:200])}', flush=True)

try:
    data = json_lib.loads(clean_literal)
    print(f'JSON OK: {data["subject"]}', flush=True)
except Exception as e:
    print(f'JSON failed: {e}', flush=True)
    # Try regex approach
    clean_regex = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()
    print(f'After regex: {repr(clean_regex[:200])}', flush=True)
    try:
        data = json_lib.loads(clean_regex)
        print(f'Regex JSON OK: {data["subject"]}', flush=True)
    except Exception as e2:
        print(f'Regex JSON failed: {e2}', flush=True)
