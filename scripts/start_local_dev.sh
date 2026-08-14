#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_PORT="${BACKEND_PORT:-4173}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PID=""
FRONTEND_PID=""
CLEANED_UP=0

fail() {
  echo "[dev] $*" >&2
  exit 1
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) fail "$2 必须是 1-65535 的整数" ;;
  esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    fail "$2 必须是 1-65535 的整数"
  fi
}

ensure_port_free() {
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "[dev] 端口 $1 已被占用：" >&2
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >&2 || true
    fail "请停止占用进程，或通过 $2=<端口> 换一个端口"
  fi
}

terminate_tree() {
  local pid="$1"
  local signal="${2:-TERM}"
  local child
  [ -n "$pid" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      terminate_tree "$child" "$signal"
    done
  fi
  kill -"$signal" "$pid" 2>/dev/null || true
}

cleanup() {
  [ "$CLEANED_UP" -eq 0 ] || return 0
  CLEANED_UP=1
  echo
  echo "[dev] 正在停止前后端…"
  terminate_tree "$FRONTEND_PID" TERM
  terminate_tree "$BACKEND_PID" TERM
  wait "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  echo "[dev] 已停止"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请安装 Node.js >= 22.5"
command -v npm >/dev/null 2>&1 || fail "未找到 npm"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || fail "当前 Node.js 为 $(node --version)，需要 >= 22.5"

validate_port "$BACKEND_PORT" BACKEND_PORT
validate_port "$FRONTEND_PORT" FRONTEND_PORT
[ "$BACKEND_PORT" != "$FRONTEND_PORT" ] || fail "前后端端口不能相同"
ensure_port_free "$BACKEND_PORT" BACKEND_PORT
ensure_port_free "$FRONTEND_PORT" FRONTEND_PORT

if [ ! -x "$FRONTEND_DIR/node_modules/.bin/next" ]; then
  echo "[dev] 前端依赖不存在，正在执行 npm ci…"
  (cd "$FRONTEND_DIR" && npm ci)
fi

echo "[dev] 后端：http://127.0.0.1:${BACKEND_PORT}（Node watch 热更新）"
echo "[dev] 前端：http://127.0.0.1:${FRONTEND_PORT}（Next Fast Refresh）"
echo "[dev] 按 Ctrl+C 同时停止"
echo

(
  cd "$BACKEND_DIR"
  if [[ " ${NODE_OPTIONS:-} " == *" --experimental-sqlite "* ]]; then
    exec env PORT="$BACKEND_PORT" node --watch --watch-preserve-output server.js
  else
    exec env PORT="$BACKEND_PORT" NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--experimental-sqlite" \
      node --watch --watch-preserve-output server.js
  fi
) &
BACKEND_PID=$!

(
  cd "$FRONTEND_DIR"
  exec env BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
    "$FRONTEND_DIR/node_modules/.bin/next" dev -H 127.0.0.1 -p "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

STATUS=0
while :; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID" || STATUS=$?
    echo "[dev] 后端已退出，正在停止前端" >&2
    break
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    wait "$FRONTEND_PID" || STATUS=$?
    echo "[dev] 前端已退出，正在停止后端" >&2
    break
  fi
  sleep 1
done

exit "$STATUS"
