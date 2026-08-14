#!/usr/bin/env bash
# CartBack v3 — 一次性注入 DeepSeek key 到运行中的容器
# 用法： ./deploy/init-key.sh <DEEPSEEK_API_KEY> [host:port]
# 密钥只经运行时 /api/config 注入并持久化到 volume 的 .server/config.json，不落镜像、不落 compose。
set -euo pipefail

KEY="${1:-}"
TARGET="${2:-localhost:4180}"

if [ -z "$KEY" ]; then
  echo "用法: $0 <DEEPSEEK_API_KEY> [host:port]" >&2
  exit 1
fi

BASE="http://${TARGET}"
echo "→ 取本地令牌 (${BASE}/api/bootstrap)"
TOKEN=$(curl -fsS "$BASE/api/bootstrap" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch(e){console.error('bootstrap 解析失败');process.exit(1)}})")

if [ -z "$TOKEN" ]; then
  echo "无法获取本地令牌，确认服务已起来且端口正确" >&2
  exit 1
fi

echo "→ 注入 aiKey (POST /api/config)"
curl -fsS -X POST "$BASE/api/config" \
  -H "Content-Type: application/json" \
  -H "x-local-token: $TOKEN" \
  -d "$(node -e "console.log(JSON.stringify({aiKey: process.argv[1]}))" "$KEY")" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('aiConfigured =', j.status && j.status.aiConfigured)})"

echo "完成。密钥已持久化到 volume 的 .server/config.json。"
