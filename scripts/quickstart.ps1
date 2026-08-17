# CartBack 一键部署（Windows）
# 用法：右键「以管理员身份运行」scripts/quickstart.bat（普通双击也可以，
#       脚本会自动弹 UAC 提权窗口，点「是」即可）。
#
# 流程：管理员提权 → 自动安装 Docker Desktop（winget）→ 启用 WSL2（可能要求
#       重启一次电脑，重启后再跑本脚本会从断点继续）→ 启动 Docker 引擎 →
#       构建并启动前后端容器 → 健康检查 → 自动打开浏览器。
#
# 兼容：Windows 10 1809+ / Windows 11，PowerShell 5.1 及以上。
param(
  [string]$PublicPort = '',
  [string]$ImageTag = ''
)

$ErrorActionPreference = 'Continue'   # 原生命令（winget/docker）靠 $LASTEXITCODE 手动判定，避免 stderr 重定向误抛

if (-not $PublicPort) { if ($env:PUBLIC_PORT) { $PublicPort = $env:PUBLIC_PORT } else { $PublicPort = '3000' } }
if (-not $ImageTag)   { if ($env:IMAGE_TAG)   { $ImageTag = $env:IMAGE_TAG }   else { $ImageTag = 'local' } }

$Root = Split-Path -Parent $PSScriptRoot   # 仓库根目录（scripts/ 的上一级）

function Say($msg) { Write-Host "[一键部署] $msg" -ForegroundColor Cyan }
function Fail($msg) {
  Write-Host "[一键部署] 出问题了：$msg" -ForegroundColor Red
  Write-Host '          └ 修复后【重新运行本脚本】即可从断点继续，已完成的步骤会自动跳过。' -ForegroundColor Yellow
  Read-Host '按回车键关闭本窗口'
  exit 1
}

# ───────────────────── ① 管理员权限自提权 ─────────────────────
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[一键部署] 需要管理员权限，正在请求——请在弹出的用户账户控制（UAC）窗口点「是」' -ForegroundColor Cyan
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath),
    '-PublicPort', $PublicPort, '-ImageTag', $ImageTag
  )
  exit 0
}

Write-Host '===================================================='
Write-Host '  CartBack 一键部署（Windows）'
Write-Host '  我会自动：检查环境 → 装好缺少的 Docker → 启动服务'
Write-Host '  首次运行含安装与镜像构建，全程约 10-30 分钟'
Write-Host '===================================================='
Write-Host ''

# ───────────────────── ② winget（Windows 自带安装器） ─────────────────────
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail '未找到 winget（Windows 自带的软件安装器）。请先把 Windows 更新到较新版本（设置 → Windows 更新），再重跑本脚本。'
}
Say 'winget 就绪'

# ───────────────────── ③ Docker Desktop ─────────────────────
$ddPath = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (-not (Test-Path $ddPath)) {
  Say '未检测到 Docker Desktop，正在安装（约 5-15 分钟，期间请不要关机、不要关闭窗口）…'
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) {
    Fail "Docker Desktop 安装失败（退出码 $LASTEXITCODE）。多为网络问题：请检查网络（公司网络可能拦截），稍后重跑本脚本自动重试。"
  }
  Say 'Docker Desktop 安装完成'
} else {
  Say "已检测到 Docker Desktop：$ddPath"
}

# ───────────────────── ④ WSL2（Docker 的运行底座） ─────────────────────
Say '检查 WSL2…'
cmd /c "wsl --status >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
  Say '正在启用 WSL2（Windows 系统功能）…'
  cmd /c "wsl --install --no-distribution >nul 2>nul"
  if ($LASTEXITCODE -ne 0) {
    # 旧版本 Windows 不支持 --no-distribution，退回标准安装（会多装一个 Linux 子系统，无害）
    cmd /c "wsl --install"
  }
  Write-Host ''
  Write-Host '================================================================' -ForegroundColor Yellow
  Write-Host '  ⚠ 启用 WSL2 之后通常需要【重启电脑】才能生效。' -ForegroundColor Yellow
  Write-Host '  重启完成后，再次双击 quickstart.bat —— 会自动从断点继续。' -ForegroundColor Yellow
  Write-Host '================================================================' -ForegroundColor Yellow
  Read-Host '按回车键关闭本窗口'
  exit 0
}
Say 'WSL2 就绪'

# ───────────────────── ⑤ 启动 Docker 引擎 ─────────────────────
# 刚装完 PATH 可能没刷新，手动把 docker 所在目录塞进本次会话
$dockerBin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
if ((Test-Path $dockerBin) -and ($env:Path.IndexOf($dockerBin) -lt 0)) { $env:Path = "$dockerBin;" + $env:Path }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail '找不到 docker 命令（刚装完 PATH 未生效）。请重启电脑后重新运行本脚本（会从断点继续）。'
}

Say '正在启动 Docker 引擎（首次启动需 1-5 分钟）…'
if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) { Start-Process $ddPath }
Say '提示：如果弹出 Docker 窗口要求同意条款（Accept），点一下即可（仅首次）；要求登录可以直接跳过。'

$deadline = (Get-Date).AddMinutes(5)
while ($true) {
  cmd /c "docker info >nul 2>nul"
  if ($LASTEXITCODE -eq 0) { break }
  if ((Get-Date) -gt $deadline) {
    Fail 'Docker 引擎 5 分钟内没有启动成功。最常见原因是 BIOS 里「虚拟化」没打开：重启电脑、开机时按 F2 或 Del 进 BIOS，把 Virtualization（或 VT-x / SVM Mode）设为 Enabled，保存后再进系统重跑本脚本。'
  }
  Write-Host -NoNewline '.'
  Start-Sleep -Seconds 5
}
Write-Host ''
Say 'Docker 引擎已就绪'

# ───────────────────── ⑥ 端口检查 ─────────────────────
$conn = Get-NetTCPConnection -LocalPort ([int]$PublicPort) -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $ports = (docker ps --format '{{.Ports}}') -join ' '
  if ($ports -match (':' + $PublicPort + '->')) {
    Say "CartBack 已经在运行（端口 $PublicPort），无需重复部署"
    Start-Process "http://localhost:$PublicPort"
    Read-Host '按回车键关闭本窗口'
    exit 0
  }
  Fail "端口 $PublicPort 被其他程序占用。两个办法：① 关掉那个程序 ② 换端口：先在 cmd 执行 set PUBLIC_PORT=3001，再运行 quickstart.bat"
}

# ───────────────────── ⑦ 构建 + 启动 ─────────────────────
Set-Location $Root
$env:IMAGE_TAG = $ImageTag
$env:PUBLIC_PORT = $PublicPort
if (-not $env:BIND_ADDRESS) { $env:BIND_ADDRESS = '0.0.0.0' }
Say '开始构建并启动（首次构建约 5-15 分钟，请不要关闭窗口）…'
docker compose up -d --build --remove-orphans
if ($LASTEXITCODE -ne 0) {
  Say '容器启动失败，最近日志如下：'
  docker compose logs --tail 50
  Fail '启动失败。常见原因：网络拉不动基础镜像 → 打开 Docker Desktop 设置 → Docker Engine，加国内 registry-mirrors 镜像加速后重跑本脚本。'
}

# ───────────────────── ⑧ 健康检查 ─────────────────────
Say '等待服务就绪…'
$deadline = (Get-Date).AddSeconds(120)
$healthy = $false
while (-not $healthy) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$PublicPort/api/bootstrap" -TimeoutSec 3
    if ($resp.StatusCode -eq 200) { $healthy = $true }
  } catch { }
  if (-not $healthy -and ((Get-Date) -gt $deadline)) {
    docker compose ps
    docker compose logs --tail 100
    Fail '健康检查超时（2 分钟）。上面是容器状态与日志。修复后重跑本脚本即可。'
  }
  if (-not $healthy) {
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 2
  }
}
Write-Host ''

# ───────────────────── ⑨ 完成 ─────────────────────
Say '✅ 部署完成！正在打开浏览器…'
Start-Process "http://localhost:$PublicPort"
Write-Host ''
Write-Host '  访问地址：http://localhost:' -NoNewline
Write-Host $PublicPort -ForegroundColor Green
Write-Host '  第一次使用：打开页面后先点「注册」，创建账号并登录'
Write-Host '  要启用 AI 对话：在网页「设置」页填 DeepSeek 密钥'
Write-Host ''
Write-Host '  常用命令（cmd / PowerShell，在项目根目录）：'
Write-Host '    看日志   docker compose logs -f'
Write-Host '    停止     docker compose down'
Write-Host '    再启动   docker compose up -d'
Write-Host ''
Read-Host '按回车键关闭本窗口'
