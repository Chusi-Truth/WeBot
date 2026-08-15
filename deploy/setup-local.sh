#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=deploy/setup-common.sh
. "$SCRIPT_DIR/setup-common.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
在当前 macOS 或 Linux 电脑交互式安装 WeBot。
脚本会检查 Node.js、安装依赖、创建私密配置并编译项目；不会覆盖聊天记忆。

用法：bash deploy/setup-local.sh
EOF
  exit 0
fi

[ -f "$ROOT_DIR/package.json" ] || die "请在完整的 WeBot 项目中运行此脚本。"
require_node_22

say "配置 WeBot"
default_state_dir="$HOME/.webot"
read -r -p "私密数据保存位置 [$default_state_dir]: " state_dir
state_dir="${state_dir:-$default_state_dir}"
case "$state_dir" in
  /*) ;;
  *) die "私密数据位置必须是绝对路径。" ;;
esac
mkdir -p "$state_dir"
chmod 700 "$state_dir"

read -r -p '管理后台端口 [3210]: ' admin_port
admin_port="${admin_port:-3210}"
validate_port "$admin_port" || die "后台端口必须是 1024–65535 之间的数字。"

provider="$(choose_provider)"
env_file="$ROOT_DIR/.env"
if [ -f "$env_file" ]; then
  cp -p "$env_file" "$env_file.backup.$(date +%Y%m%d%H%M%S)"
  printf '检测到已有 .env，已先备份；只更新本次选择的项目。\n'
fi
upsert_env "$env_file" WEBOT_STATE_DIR "$state_dir"
upsert_env "$env_file" WEBOT_DEFAULT_PROVIDER "$provider"
upsert_env "$env_file" WEBOT_ADMIN_ENABLED true
upsert_env "$env_file" WEBOT_ADMIN_PORT "$admin_port"
configure_provider_key "$env_file" "$provider"

say "安装依赖并检查项目"
cd "$ROOT_DIR"
npm ci
npm run check
npm run build

say "基础安装完成"
printf '私密数据：%s\n' "$state_dir"
printf '管理后台：http://127.0.0.1:%s/admin\n' "$admin_port"

if ask_yes_no '现在进行微信扫码授权吗？' yes; then
  npm run login
fi

cat <<EOF

以后启动 WeBot：
  cd "$ROOT_DIR"
  npm run start

第一次启动会在终端显示管理后台初始化链接。电脑休眠或关机后，本地服务也会停止。
EOF

if ask_yes_no '现在启动 WeBot 吗？（保持此终端开启，Ctrl+C 停止）' yes; then
  exec npm run start
fi
