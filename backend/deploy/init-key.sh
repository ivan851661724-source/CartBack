#!/usr/bin/env bash
# CartBack v3 — 一次性注入 DeepSeek key 到运行中的容器
# 用法: ./deploy/init-key.sh <DEEPSEEK_API_KEY> [host:port]
# 密钥只经运行时 /api/config 注入并持久化到 volume 的 .server/config.json，不落镜像、不落 compose。
# 拆分后：默认走前端反代入口 :3000（同源 /api/config），亦可在「设置」页直接填。
# 鉴权：CARTBACK_OPEN_LOCAL=1 时从 /api/bootstrap 取 token；安全模式（默认）下
#       bootstrap 不再下发 token，改为直读宿主机挂载的 server-data/config.json。
set -euo pipefail

KEY="${1:-}"
TARGET="${2:-localhost:3000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DATA="$HERE/../../server-data"

if [ -z "$KEY" ]; then
  echo "用法: $0 <DEEPSEEK_API_KEY> [host:port]" >&2
  exit 1
fi

BASE="http://${TARGET}"

# 取本地令牌：优先直读挂载的 config.json（操作员有文件访问权），失败再试 bootstrap
TOKEN=""
if [ -f "$SERVER_DATA/config.json" ]; then
  TOKEN=$(node -e "try{const c=require('$SERVER_DATA/config.json');console.log(c.localToken||'')}catch(e){console.log('')}")
fi
if [ -z "$TOKEN" ]; then
  echo "→ 本地令牌文件不可读，尝试 ${BASE}/api/bootstrap（仅 CARTBACK_OPEN_LOCAL=1 模式可用）"
  TOKEN=$(curl -fsS "$BASE/api/bootstrap" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch(e){console.log('')}})") || TOKEN=""
fi

if [ -z "$TOKEN" ]; then
  echo "无法获取本地令牌（安全模式下需在「设置」页登录后填写，或以 CARTBACK_OPEN_LOCAL=1 启动）" >&2
  exit 1
fi

echo "→ 注入 aiKey (POST /api/config)"
curl -fsS -X POST "$BASE/api/config" \
  -H "Content-Type: application/json" \
  -H "x-local-token: $TOKEN" \
  -d "$(node -e "console.log(JSON.stringify({aiKey: process.argv[1]}))" "$KEY")" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('aiConfigured =', j.status && j.status.aiConfigured)})"

echo "完成。密钥已持久化到 volume 的 .server/config.json。"
