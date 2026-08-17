#!/usr/bin/env bash
# CartBack 一键部署（Linux / macOS）
# 面向第一次使用的用户：检测环境 → 缺 Docker 就自动安装 → 拉起 Docker →
# 构建并启动前后端 → 健康检查 → 自动打开浏览器。
#
# 特性：
#   · 全程中文提示，每一步都说清楚在做什么、要等多久
#   · 幂等可重跑：装一半中断 / 重启电脑后，再跑一次会从断点继续
#   · 不动已有环境：已装 OrbStack / Docker Desktop / colima / 官方 engine 一律复用
#
# 用法：
#   ./scripts/quickstart.sh                     # 默认端口 3000
#   PUBLIC_PORT=3001 ./scripts/quickstart.sh    # 换端口
#   NO_BROWSER=1 ./scripts/quickstart.sh        # 不自动开浏览器
#
# Windows 用户请双击 scripts/quickstart.bat
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_PORT="${PUBLIC_PORT:-3000}"
IMAGE_TAG="${IMAGE_TAG:-local}"
DAEMON_WAIT="${DAEMON_WAIT:-180}"   # 等 Docker 引擎就绪的最长秒数

say()  { echo "[一键部署] $*"; }
hint() { echo "          └ $*"; }
fail() {
  echo "[一键部署] 出问题了：$*" >&2
  echo "          └ 修复后【重新运行本脚本】即可从断点继续，已完成的步骤会自动跳过。" >&2
  exit 1
}

banner() {
  echo "===================================================="
  echo "  CartBack 一键部署"
  echo "  我会自动：检查环境 → 装好缺少的 Docker → 启动服务"
  echo "  首次运行含镜像构建，全程约 5-20 分钟，请耐心等待"
  echo "===================================================="
  echo
}

# ─────────────────────────── 系统检测 ───────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*)
    fail "检测到你在 Windows 的 Git Bash 里。请改用【双击 scripts/quickstart.bat】（右键以管理员身份运行）。" ;;
  *)
    fail "暂不支持当前系统（${OS}）。Windows 请双击 scripts/quickstart.bat，其他系统请参考 README 手动部署。" ;;
esac
# 注意：变量一律用 ${...} 花括号——bash 3.2 会把紧跟的全角字符字节并进变量名
say "系统检测通过：${OS}（$(uname -m)）"

# ─────────────────────── 通用小工具 ───────────────────────
# Linux 下需要 root 权限时自动加 sudo（首次提示输密码）
SUDO_PROMPTED=0
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; return; fi
  if [ "$SUDO_PROMPTED" -eq 0 ]; then
    say "接下来的安装需要系统权限，可能会要求输入电脑密码（输入时屏幕不显示，输完直接回车）"
    SUDO_PROMPTED=1
  fi
  sudo "$@"
}

# 取 URL 内容到标准输出（优先 curl，其次 wget，都没有就先补装 curl）
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; return; fi
  if command -v wget >/dev/null 2>&1; then wget -qO- "$1"; return; fi
  if command -v apt-get >/dev/null 2>&1; then
    say "系统缺少 curl，先自动补装…"
    as_root apt-get update -qq >/dev/null 2>&1 || as_root apt-get update
    as_root apt-get install -y -qq curl >/dev/null 2>&1 || as_root apt-get install -y curl
    curl -fsSL "$1"; return
  fi
  if command -v dnf >/dev/null 2>&1; then
    say "系统缺少 curl，先自动补装…"
    as_root dnf install -y -q curl
    curl -fsSL "$1"; return
  fi
  fail "系统里没有 curl / wget，也无法自动安装。请先手动安装 curl 后重跑本脚本。"
}

# 端口是否被监听（nc 优先，兜底 bash 内建 /dev/tcp）
port_busy() {
  if command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 "$1" >/dev/null 2>&1; return; fi
  (echo -n >/dev/tcp/127.0.0.1/"$1") >/dev/null 2>&1
}

open_browser() {
  local url="http://localhost:${PUBLIC_PORT}"
  if [ "${NO_BROWSER:-0}" = "1" ]; then say "访问地址：$url"; return; fi
  say "正在打开浏览器：$url"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || say "浏览器没打开？手动访问：$url"
  else say "浏览器没打开？手动访问：$url"; fi
}

print_next_steps() {
  echo
  echo "===================================================="
  echo "  ✅ 部署完成！"
  echo "  访问地址：http://localhost:${PUBLIC_PORT}（浏览器即将/已经自动打开）"
  echo
  echo "  第一次使用："
  echo "    1. 打开页面后先点「注册」，创建账号并登录"
  echo "    2. 要启用 AI 对话：在网页「设置」页填 DeepSeek 密钥，"
  echo "       或执行 ./backend/deploy/init-key.sh sk-你的密钥"
  echo
  echo "  常用命令（在项目根目录）："
  echo "    看日志   docker compose logs -f"
  echo "    停止     docker compose down"
  echo "    再启动   docker compose up -d"
  echo "===================================================="
}

# ─────────────────────── Docker 安装 ───────────────────────
install_docker_linux() {
  say "正在安装 Docker（官方脚本，约 1-3 分钟）…"
  fetch https://get.docker.com | as_root sh
  hint "装完后自动顺手开启开机自启"
  as_root systemctl enable docker >/dev/null 2>&1 || true
}

ensure_brew_darwin() {
  if command -v brew >/dev/null 2>&1; then return; fi
  say "未检测到 Homebrew（macOS 上装软件的基础工具），正在自动安装（约 5-10 分钟）…"
  hint "期间可能要求输入电脑密码（输入时屏幕不显示，输完直接回车）"
  NONINTERACTIVE=1 /bin/bash -c "$(fetch https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 新装的 brew 不会自动进 PATH，按官方提示补上（Apple Silicon / Intel 两个位置都试）
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  command -v brew >/dev/null 2>&1 || fail "Homebrew 安装后仍不可用。请打开新终端执行 brew --version 确认可用后，重跑本脚本。"
}

install_docker_darwin() {
  ensure_brew_darwin
  say "正在安装 Docker 运行环境（colima + docker + compose，纯命令行、无需图形界面，约 3-8 分钟）…"
  brew install colima docker docker-compose
}

# brew 版 docker-compose 是独立命令，要让 `docker compose` 子命令可用需挂成 CLI 插件
ensure_compose_plugin() {
  if docker compose version >/dev/null 2>&1; then return 0; fi
  local target=""
  [ -x /opt/homebrew/opt/docker-compose/bin/docker-compose ] && target=/opt/homebrew/opt/docker-compose/bin/docker-compose
  [ -x /usr/local/opt/docker-compose/bin/docker-compose ] && target=/usr/local/opt/docker-compose/bin/docker-compose
  [ -x /usr/local/bin/docker-compose ] && target=/usr/local/bin/docker-compose
  if [ -n "$target" ]; then
    mkdir -p "$HOME/.docker/cli-plugins"
    ln -sf "$target" "$HOME/.docker/cli-plugins/docker-compose"
  fi
  docker compose version >/dev/null 2>&1
}

# ─────────────────────── Docker 引擎拉起 ───────────────────────
start_daemon_darwin() {
  if [ -d /Applications/OrbStack.app ] || command -v orb >/dev/null 2>&1; then
    say "检测到 OrbStack，正在启动…"
    orb start 2>/dev/null || open -ga OrbStack
    return 0
  fi
  if [ -d /Applications/Docker.app ]; then
    say "检测到 Docker Desktop，正在启动（首次可能需 1-2 分钟）…"
    open -ga Docker
    return 0
  fi
  if command -v colima >/dev/null 2>&1; then
    if colima list 2>/dev/null | awk 'NR>1' | grep -q .; then
      say "检测到 colima 虚拟机，正在启动…"
      colima start
    else
      say "正在创建 colima 虚拟机（4 核 / 6GB 内存 / 40GB 磁盘上限，仅首次，约 2-5 分钟）…"
      colima start --cpu 4 --memory 6 --disk 40
    fi
    return 0
  fi
  return 1
}

start_daemon_linux() {
  if [ -d /run/systemd/system ]; then
    as_root systemctl enable --now docker >/dev/null 2>&1 || as_root systemctl start docker
  else
    as_root service docker start >/dev/null 2>&1 || true
  fi
}

# 等引擎就绪：0=当前用户直接可用；2=引擎已就绪但当前用户缺权限(Linux)；1=超时
wait_for_daemon() {
  local waited=0
  printf '[一键部署] 等待 Docker 引擎就绪（最多 %s 秒，首次启动虚拟机可能要 1-2 分钟）' "$DAEMON_WAIT"
  while :; do
    if docker info >/dev/null 2>&1; then echo; return 0; fi
    if [ "$OS" = "Linux" ] && [ "$(id -u)" -ne 0 ] && sudo -n docker info >/dev/null 2>&1; then echo; return 2; fi
    if [ "$waited" -ge "$DAEMON_WAIT" ]; then echo; return 1; fi
    printf '.'; sleep 3; waited=$((waited + 3))
  done
}

# ─────────────────────────── 主流程 ───────────────────────────
banner

# ① docker 命令
if ! command -v docker >/dev/null 2>&1; then
  if [ "$OS" = "Linux" ]; then
    say "未检测到 Docker，开始自动安装"
    install_docker_linux
  else
    say "未检测到 Docker，开始自动安装"
    install_docker_darwin
  fi
else
  say "已检测到 Docker 命令：$(docker --version 2>/dev/null || echo 未知版本)"
fi

# ② compose 插件（`docker compose` 子命令）
if ! docker compose version >/dev/null 2>&1; then
  say "Docker 缺少 compose 组件，正在修复…"
  if [ "$OS" = "Linux" ]; then
    install_docker_linux           # 官方脚本幂等：缺组件会补齐，旧版本会原地升级
  else
    ensure_compose_plugin || {
      ensure_brew_darwin
      brew install docker docker-compose || brew upgrade docker docker-compose
      ensure_compose_plugin
    } || fail "compose 组件修复失败。可手动执行：brew install docker docker-compose 后重跑本脚本。"
  fi
  docker compose version >/dev/null 2>&1 || fail "compose 组件仍不可用。请把上面 docker compose version 的报错发给我们排查。"
fi
say "compose 组件就绪：$(docker compose version 2>/dev/null | head -1)"

# ③ Docker 引擎（daemon）
if ! docker info >/dev/null 2>&1; then
  say "Docker 引擎未运行，正在拉起…"
  if [ "$OS" = "Darwin" ]; then
    start_daemon_darwin || {
      say "没找到已安装的 Docker 应用，转为安装 colima 方案"
      install_docker_darwin
      say "正在创建 colima 虚拟机（4 核 / 6GB 内存 / 40GB 磁盘上限，仅首次，约 2-5 分钟）…"
      colima start --cpu 4 --memory 6 --disk 40
    }
  else
    start_daemon_linux
  fi
fi
DAEMON_RC=0
wait_for_daemon || DAEMON_RC=$?
if [ "$DAEMON_RC" -eq 1 ]; then
  if [ "$OS" = "Darwin" ]; then
    fail "Docker 引擎一直没启动起来。请手动打开一次 OrbStack / Docker Desktop 应用（看到图标亮起）后，重跑本脚本。"
  else
    fail "Docker 引擎一直没启动起来。可执行 sudo systemctl status docker 看具体报错，修复后重跑本脚本。"
  fi
fi
if [ "$DAEMON_RC" -eq 2 ]; then
  say "Docker 已装好，正在给当前账号开通免密使用权（下次登录起生效）…"
  as_root groupadd docker 2>/dev/null || true
  as_root usermod -aG docker "${USER:-$(id -un)}" 2>/dev/null || true
  # 本会话用户组还没生效：垫一个临时 docker 垫片走 sudo，让本次部署先跑通
  SHIM_DIR="$(mktemp -d)"
  printf '#!/bin/sh\nexec sudo docker "$@"\n' > "$SHIM_DIR/docker"
  chmod +x "$SHIM_DIR/docker"
  export PATH="$SHIM_DIR:$PATH"
  hint "本次部署内的 docker 命令会借道管理员权限；【重新登录电脑】后就不需要了"
fi
say "Docker 引擎已就绪"

# ④ 磁盘空间（构建镜像约需 3-5GB）
AVAIL_KB="$(df -Pk "$PROJECT_ROOT" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)"
case "$AVAIL_KB" in ''|*[!0-9]*) AVAIL_KB=0 ;; esac
if [ "$AVAIL_KB" -gt 0 ] && [ "$AVAIL_KB" -lt $((5 * 1024 * 1024)) ]; then
  say "⚠ 磁盘剩余空间不足 5GB（约 $((AVAIL_KB / 1024 / 1024))GB），构建可能失败，建议先清理"
  sleep 3
fi

# ⑤ 端口检查：被占时先看是不是我们自己已在跑
if port_busy "$PUBLIC_PORT"; then
  if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${PUBLIC_PORT}->"; then
    say "CartBack 已经在运行（端口 ${PUBLIC_PORT}），无需重复部署"
    open_browser
    print_next_steps
    exit 0
  fi
  command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PUBLIC_PORT" -sTCP:LISTEN || true
  fail "端口 ${PUBLIC_PORT} 被别的程序占用（占用者见上）。两个办法：① 关掉那个程序 ② 换端口运行：PUBLIC_PORT=3001 ./scripts/quickstart.sh"
fi

# ⑥ 构建 + 启动 + 健康检查（复用现有部署脚本）
say "环境全部就绪，开始构建并启动（首次构建约 5-15 分钟，期间不要关闭窗口）…"
export PUBLIC_PORT IMAGE_TAG
"$PROJECT_ROOT/scripts/deploy_docker.sh" "$IMAGE_TAG"

# ⑦ 完成
open_browser
print_next_steps
