#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=deploy/setup-common.sh
. "$SCRIPT_DIR/setup-common.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
在采用 systemd 的 Linux 服务器上交互式安装 WeBot。
请先下载完整项目，再运行：sudo bash deploy/setup-server.sh

脚本会创建低权限用户、安装到 /opt/webot、编译、配置开机自启并可进行微信扫码。
已有 /var/lib/webot 中的凭证、人物和记忆不会被删除。
EOF
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || die "服务器安装器只支持 Linux。"
command -v systemctl >/dev/null 2>&1 || die "此安装器需要 systemd。"
if [ "$(id -u)" -ne 0 ]; then
  require_command sudo
  exec sudo bash "$0" "$@"
fi
require_node_22
require_command git

INSTALL_DIR=/opt/webot
STATE_DIR=/var/lib/webot
CONFIG_DIR=/etc/webot
ENV_FILE="$CONFIG_DIR/webot.env"
service_was_active=false

restore_service_after_error() {
  exit_status=$?
  if [ "$exit_status" -ne 0 ] && [ "$service_was_active" = true ]; then
    printf '\n安装中断，正在恢复原来的 WeBot 服务……\n' >&2
    systemctl start webot >/dev/null 2>&1 || true
  fi
  return "$exit_status"
}
trap restore_service_after_error EXIT

say "准备专用用户和目录"
if ! id webot >/dev/null 2>&1; then
  nologin_shell=/usr/sbin/nologin
  [ -x "$nologin_shell" ] || nologin_shell=/sbin/nologin
  useradd --system --create-home --home-dir "$STATE_DIR" \
    --shell "$nologin_shell" webot
fi
install -d -o webot -g webot -m 0700 "$STATE_DIR"
install -d -o root -g root -m 0755 "$CONFIG_DIR"

if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
  if [ -e "$INSTALL_DIR/package.json" ]; then
    die "$INSTALL_DIR 已存在。为防止覆盖现有代码，请在该目录中运行它自己的 deploy/setup-server.sh。"
  fi
  [ ! -e "$INSTALL_DIR" ] || die "$INSTALL_DIR 已存在但不是完整 WeBot 项目，请先人工确认该目录。"
  if [ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]; then
    die "当前项目有尚未提交的修改。请先提交或备份，再安装到服务器。"
  fi
  say "复制当前版本到 $INSTALL_DIR"
  git clone --local "$SOURCE_DIR" "$INSTALL_DIR"
  source_origin="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
  if [ -n "$source_origin" ]; then
    git -C "$INSTALL_DIR" remote set-url origin "$source_origin"
  fi
fi

say "配置服务"
read -r -p '管理后台端口 [3210]: ' admin_port
admin_port="${admin_port:-3210}"
validate_port "$admin_port" || die "后台端口必须是 1024–65535 之间的数字。"
provider="$(choose_provider)"
if [ -f "$ENV_FILE" ]; then
  cp -p "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d%H%M%S)"
  printf '检测到已有服务器配置，已先备份；只更新本次选择的项目。\n'
fi
upsert_env "$ENV_FILE" NODE_ENV production
upsert_env "$ENV_FILE" HOME "$STATE_DIR"
upsert_env "$ENV_FILE" WEBOT_STATE_DIR "$STATE_DIR"
upsert_env "$ENV_FILE" WEBOT_DEFAULT_PROVIDER "$provider"
upsert_env "$ENV_FILE" WEBOT_ADMIN_ENABLED true
upsert_env "$ENV_FILE" WEBOT_ADMIN_PORT "$admin_port"
configure_provider_key "$ENV_FILE" "$provider"
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

say "安装依赖、测试并编译"
cd "$INSTALL_DIR"
if systemctl is-active --quiet webot 2>/dev/null; then
  service_was_active=true
  systemctl stop webot
fi
npm ci
npm run check
npm test
npm run build

node_path="$(command -v node)"
cat > /etc/systemd/system/webot.service <<EOF
[Unit]
Description=WeBot Weixin iLink Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=webot
Group=webot
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$node_path $INSTALL_DIR/dist/cli.js start
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
EOF
chmod 644 /etc/systemd/system/webot.service
systemctl daemon-reload

if [ ! -f "$STATE_DIR/credential.json" ]; then
  if ask_yes_no '现在进行微信扫码授权吗？' yes; then
    runuser -u webot -- env HOME="$STATE_DIR" WEBOT_STATE_DIR="$STATE_DIR" \
      "$node_path" "$INSTALL_DIR/dist/cli.js" login
  else
    printf '尚未授权。稍后重新运行本脚本，或按部署文档执行扫码命令。\n'
  fi
else
  printf '检测到已有微信凭证，已保留，不需要重新扫码。\n'
fi

say "启动并设置开机自动运行"
systemctl enable --now webot
service_was_active=false
systemctl --no-pager --full status webot || true

cat <<EOF

安装完成。
  服务状态：systemctl status webot
  查看日志：journalctl -u webot -f
  后台地址（仅服务器本机）：http://127.0.0.1:$admin_port/admin

第一次启动时，初始化管理链接会出现在日志中。不要把该链接或完整日志公开。
EOF
