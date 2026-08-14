#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${1:-${IMAGE_TAG:-local}}"
PUBLIC_PORT="${PUBLIC_PORT:-3000}"
BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
HEALTHCHECK_HOST="${HEALTHCHECK_HOST:-127.0.0.1}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-90}"

fail() {
  echo "[docker-deploy] $*" >&2
  exit 1
}

validate_number() {
  case "$1" in
    ''|*[!0-9]*) fail "$2 必须是整数" ;;
  esac
}

validate_number "$PUBLIC_PORT" PUBLIC_PORT
validate_number "$DEPLOY_TIMEOUT" DEPLOY_TIMEOUT
[ "$PUBLIC_PORT" -ge 1 ] && [ "$PUBLIC_PORT" -le 65535 ] || fail "PUBLIC_PORT 必须在 1-65535 之间"
[ "$DEPLOY_TIMEOUT" -ge 10 ] || fail "DEPLOY_TIMEOUT 不能小于 10 秒"
case "$IMAGE_TAG" in
  ''|*[!A-Za-z0-9_.-]*) fail "镜像标签只能包含字母、数字、点、下划线和短横线" ;;
esac
command -v docker >/dev/null 2>&1 || fail "未找到 Docker CLI"
docker compose version >/dev/null 2>&1 || fail "未找到 Docker Compose 插件"
docker info >/dev/null 2>&1 || fail "Docker daemon 未运行，请先启动 Docker Desktop 或 OrbStack"
command -v curl >/dev/null 2>&1 || fail "未找到 curl，无法执行部署健康检查"

cd "$PROJECT_ROOT"
mkdir -p server-data

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  "$PROJECT_ROOT/scripts/build_docker_images.sh" "$IMAGE_TAG"
else
  docker image inspect "cartback-backend:$IMAGE_TAG" >/dev/null 2>&1 \
    || fail "本地不存在 cartback-backend:$IMAGE_TAG"
  docker image inspect "cartback-frontend:$IMAGE_TAG" >/dev/null 2>&1 \
    || fail "本地不存在 cartback-frontend:$IMAGE_TAG"
fi

echo "[docker-deploy] 正在启动 CartBack，端口 ${BIND_ADDRESS}:${PUBLIC_PORT}"
IMAGE_TAG="$IMAGE_TAG" PUBLIC_PORT="$PUBLIC_PORT" BIND_ADDRESS="$BIND_ADDRESS" \
  docker compose up -d --no-build --remove-orphans

HEALTH_URL="http://${HEALTHCHECK_HOST}:${PUBLIC_PORT}/api/bootstrap"
DEADLINE=$(( $(date +%s) + DEPLOY_TIMEOUT ))
until curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "[docker-deploy] 部署超时，当前容器状态：" >&2
    IMAGE_TAG="$IMAGE_TAG" PUBLIC_PORT="$PUBLIC_PORT" BIND_ADDRESS="$BIND_ADDRESS" docker compose ps >&2 || true
    echo "[docker-deploy] 最近日志：" >&2
    IMAGE_TAG="$IMAGE_TAG" PUBLIC_PORT="$PUBLIC_PORT" BIND_ADDRESS="$BIND_ADDRESS" \
      docker compose logs --tail=100 >&2 || true
    fail "健康检查未通过：$HEALTH_URL"
  fi
  sleep 2
done

echo "[docker-deploy] 部署成功：$HEALTH_URL"
IMAGE_TAG="$IMAGE_TAG" PUBLIC_PORT="$PUBLIC_PORT" BIND_ADDRESS="$BIND_ADDRESS" docker compose ps
