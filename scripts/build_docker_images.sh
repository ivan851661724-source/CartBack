#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${1:-${IMAGE_TAG:-local}}"
EXPORT_IMAGES="${EXPORT_IMAGES:-0}"

fail() {
  echo "[docker-build] $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "未找到 Docker CLI"
docker compose version >/dev/null 2>&1 || fail "未找到 Docker Compose 插件"
docker info >/dev/null 2>&1 || fail "Docker daemon 未运行，请先启动 Docker Desktop 或 OrbStack"

case "$IMAGE_TAG" in
  ''|*[!A-Za-z0-9_.-]*) fail "镜像标签只能包含字母、数字、点、下划线和短横线" ;;
esac

set --
[ "${NO_CACHE:-0}" = "1" ] && set -- "$@" --no-cache
[ "${PULL_BASE_IMAGES:-0}" = "1" ] && set -- "$@" --pull

cd "$PROJECT_ROOT"
IMAGE_TAG="$IMAGE_TAG" docker compose config --quiet

echo "[docker-build] 正在构建 cartback-backend:$IMAGE_TAG 和 cartback-frontend:$IMAGE_TAG"
IMAGE_TAG="$IMAGE_TAG" docker compose build "$@"

docker image inspect "cartback-backend:$IMAGE_TAG" >/dev/null
docker image inspect "cartback-frontend:$IMAGE_TAG" >/dev/null

echo "[docker-build] 构建完成："
docker image ls --filter "reference=cartback-*:$IMAGE_TAG" \
  --format '  {{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}'

if [ "$EXPORT_IMAGES" = "1" ]; then
  EXPORT_DIR="${EXPORT_DIR:-$PROJECT_ROOT/dist/docker}"
  mkdir -p "$EXPORT_DIR"
  TAR_PATH="$EXPORT_DIR/cartback-images-$IMAGE_TAG.tar"
  echo "[docker-build] 正在导出 $TAR_PATH"
  docker save --output "$TAR_PATH" \
    "cartback-backend:$IMAGE_TAG" "cartback-frontend:$IMAGE_TAG"
  echo "[docker-build] 镜像包已导出：$TAR_PATH"
fi
