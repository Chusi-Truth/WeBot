#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

show_help() {
  cat <<'EOF'
WeBot 图形化部署入口（终端菜单）

Windows 请在 PowerShell 中运行：
  powershell -NoProfile -File .\deploy\setup-windows.ps1

用法：
  bash deploy/setup.sh
  bash deploy/setup.sh local
  bash deploy/setup.sh server
  bash deploy/setup.sh codex

选项：
  local   在当前 macOS 或 Linux 电脑安装 WeBot
  server  在 Linux 服务器安装为开机自动运行的服务
  codex   安装可选的 Codex 图片理解与图片生成适配服务
EOF
}

choice="${1:-}"
if [ "$choice" = "--help" ] || [ "$choice" = "-h" ]; then
  show_help
  exit 0
fi

if [ -z "$choice" ]; then
  printf '\nWeBot 简易部署\n\n'
  printf '  1) 安装到当前电脑\n'
  printf '  2) 安装到 Linux 服务器并保持后台运行\n'
  printf '  3) 安装可选的 Codex 图片能力\n'
  printf '  4) 退出\n\n'
  read -r -p '请输入序号 [1]: ' menu_choice
  case "${menu_choice:-1}" in
    1) choice="local" ;;
    2) choice="server" ;;
    3) choice="codex" ;;
    4) exit 0 ;;
    *) printf '无法识别这个选项。\n' >&2; exit 2 ;;
  esac
fi

case "$choice" in
  local) exec bash "$SCRIPT_DIR/setup-local.sh" ;;
  server) exec bash "$SCRIPT_DIR/setup-server.sh" ;;
  codex) exec bash "$SCRIPT_DIR/setup-codex-adapter.sh" ;;
  *) show_help >&2; exit 2 ;;
esac
