#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=deploy/setup-common.sh
. "$SCRIPT_DIR/setup-common.sh"

VERSION=7.2.131

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
安装可选的 CLIProxyAPI，让 WeBot 使用 Codex 做图片理解和图片生成。
支持 Homebrew macOS，以及采用 systemd 的 x86_64/arm64 Linux。

用法：bash deploy/setup-codex-adapter.sh

该程序是第三方开源项目，不是 OpenAI 官方 API 服务。它只监听 127.0.0.1，
不会开放公共端口。授权会使用对应 ChatGPT/Codex 账号的额度。
EOF
  exit 0
fi

random_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  else
    die "缺少生成安全随机密钥所需的 openssl。"
  fi
}

save_companion_key() {
  key_file="$1"
  key_value="$2"
  key_dir="$(dirname -- "$key_file")"
  mkdir -p "$key_dir"
  chmod 700 "$key_dir"
  umask 077
  printf '%s\n' "$key_value" >"$key_file"
  chmod 600 "$key_file"
}

configure_webot_media() {
  target_env="$1"
  ordinary_key="$2"
  upsert_env "$target_env" CLIPROXY_API_KEY "$ordinary_key"
  upsert_env "$target_env" WEBOT_VISION_PROVIDER cliproxy
  upsert_env "$target_env" WEBOT_VISION_MODEL gpt-5.6-sol
  upsert_env "$target_env" WEBOT_IMAGE_GENERATION_PROVIDER cliproxy
  upsert_env "$target_env" WEBOT_IMAGE_GENERATION_MODEL gpt-image-2
}

install_macos() {
  require_command brew
  say "安装 CLIProxyAPI"
  already_installed=true
  if ! brew list cliproxyapi >/dev/null 2>&1; then
    already_installed=false
    brew install cliproxyapi
  fi
  brew_prefix="$(brew --prefix)"
  config_file="$brew_prefix/etc/cliproxyapi.conf"
  companion_key_file="$HOME/.cli-proxy-api/webot-api-key"
  ordinary_key=""
  if [ -f "$companion_key_file" ]; then
    ordinary_key="$(sed -n '1p' "$companion_key_file")"
    [ -n "$ordinary_key" ] || die "已保存的普通 API Key 为空，请删除 $companion_key_file 后重试。"
    printf '检测到已经连接过 WeBot，将继续使用现有普通 API Key。\n'
  elif [ "$already_installed" = true ] && [ -f "$config_file" ]; then
    printf '检测到已有 CLIProxyAPI 配置，为防止覆盖将原样保留。\n'
    read -r -s -p '请输入其中供 WeBot 使用的普通 API Key: ' ordinary_key
    printf '\n'
    [ -n "$ordinary_key" ] || die "需要普通 API Key 才能连接 WeBot。"
    save_companion_key "$companion_key_file" "$ordinary_key"
  else
    ordinary_key="$(random_key)"
    if [ -f "$config_file" ]; then
      cp -p "$config_file" "$config_file.before-webot"
    fi
    umask 077
    cat >"$config_file" <<EOF
host: "127.0.0.1"
port: 8317
auth-dir: "$HOME/.cli-proxy-api"
api-keys:
  - "$ordinary_key"
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
disable-image-generation: false
ws-auth: true
debug: false
request-log: false
EOF
    chmod 600 "$config_file"
    save_companion_key "$companion_key_file" "$ordinary_key"
  fi

  if ask_yes_no '现在打开 Codex 设备授权流程吗？' yes; then
    cliproxyapi -config "$config_file" -codex-device-login -no-browser
  fi
  brew services restart cliproxyapi

  if [ -f "$ROOT_DIR/package.json" ]; then
    configure_webot_media "$ROOT_DIR/.env" "$ordinary_key"
    printf '已把图片能力写入 WeBot 的私密 .env。请重新启动 WeBot。\n'
  fi
  unset ordinary_key
}

install_linux() {
  command -v systemctl >/dev/null 2>&1 || die "Linux 安装器需要 systemd。"
  if [ "$(id -u)" -ne 0 ]; then
    require_command sudo
    exec sudo bash "$0" "$@"
  fi
  require_command curl
  require_command tar
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64)
      archive="CLIProxyAPI_${VERSION}_linux_amd64_no-plugin.tar.gz"
      expected_sha="a7e1127d10e908f37fa7bb5f5f4a9aebb26e5baca17c7bd92987df3a0bda9043"
      ;;
    aarch64|arm64)
      archive="CLIProxyAPI_${VERSION}_linux_aarch64_no-plugin.tar.gz"
      expected_sha="c82bd3dfb62da2ff567930d928c8aaf33f384917bdfc197f28ddbf7ff50509f3"
      ;;
    *) die "暂不支持服务器架构 $machine。" ;;
  esac

  if ! id cliproxyapi >/dev/null 2>&1; then
    nologin_shell=/usr/sbin/nologin
    [ -x "$nologin_shell" ] || nologin_shell=/sbin/nologin
    useradd --system --create-home --home-dir /var/lib/cliproxyapi \
      --shell "$nologin_shell" cliproxyapi
  fi
  install -d -o root -g root -m 0755 /opt/cliproxyapi
  install -d -o root -g cliproxyapi -m 0750 /etc/cliproxyapi
  install -d -o cliproxyapi -g cliproxyapi -m 0700 /var/lib/cliproxyapi/auth

  if [ ! -x /opt/cliproxyapi/cli-proxy-api ]; then
    say "下载并校验 CLIProxyAPI $VERSION"
    download_file="/tmp/$archive"
    curl -fL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$VERSION/$archive" \
      -o "$download_file"
    actual_sha="$(sha256sum "$download_file" | awk '{print $1}')"
    [ "$actual_sha" = "$expected_sha" ] || die "下载文件校验失败，已停止安装。"
    tar -xzf "$download_file" -C /opt/cliproxyapi
    chown root:root /opt/cliproxyapi/cli-proxy-api
    chmod 755 /opt/cliproxyapi/cli-proxy-api
    rm -f "$download_file"
  fi

  config_file=/etc/cliproxyapi/config.yaml
  companion_key_file=/var/lib/cliproxyapi/webot-api-key
  ordinary_key=""
  if [ -f "$companion_key_file" ]; then
    ordinary_key="$(sed -n '1p' "$companion_key_file")"
    [ -n "$ordinary_key" ] || die "已保存的普通 API Key 为空，请删除 $companion_key_file 后重试。"
    printf '检测到已经连接过 WeBot，将继续使用现有普通 API Key。\n'
  elif [ -f "$config_file" ]; then
    printf '检测到已有 CLIProxyAPI 配置，为防止覆盖将原样保留。\n'
    read -r -s -p '请输入其中供 WeBot 使用的普通 API Key: ' ordinary_key
    printf '\n'
    [ -n "$ordinary_key" ] || die "需要普通 API Key 才能连接 WeBot。"
    save_companion_key "$companion_key_file" "$ordinary_key"
    chown cliproxyapi:cliproxyapi "$companion_key_file"
  else
    ordinary_key="$(random_key)"
    umask 077
    cat >"$config_file" <<EOF
host: "127.0.0.1"
port: 8317
auth-dir: "/var/lib/cliproxyapi/auth"
api-keys:
  - "$ordinary_key"
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
disable-image-generation: false
ws-auth: true
debug: false
request-log: false
EOF
    chown root:cliproxyapi "$config_file"
    chmod 640 "$config_file"
    save_companion_key "$companion_key_file" "$ordinary_key"
    chown cliproxyapi:cliproxyapi "$companion_key_file"
  fi

  cat >/etc/systemd/system/cliproxyapi.service <<'EOF'
[Unit]
Description=CLIProxyAPI Codex API Adapter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cliproxyapi
Group=cliproxyapi
WorkingDirectory=/var/lib/cliproxyapi
ExecStart=/opt/cliproxyapi/cli-proxy-api -config /etc/cliproxyapi/config.yaml
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/cliproxyapi

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 /etc/systemd/system/cliproxyapi.service
  systemctl daemon-reload

  if ! find /var/lib/cliproxyapi/auth -maxdepth 1 -type f -name '*.json' | grep -q .; then
    if ask_yes_no '现在打开 Codex 设备授权流程吗？' yes; then
      runuser -u cliproxyapi -- /opt/cliproxyapi/cli-proxy-api \
        -config "$config_file" -codex-device-login -no-browser
      chmod 700 /var/lib/cliproxyapi/auth
      find /var/lib/cliproxyapi/auth -maxdepth 1 -type f -exec chmod 600 {} +
    fi
  else
    printf '检测到已有 Codex 授权，已保留。\n'
  fi

  systemctl enable --now cliproxyapi
  if [ -f /etc/webot/webot.env ]; then
    configure_webot_media /etc/webot/webot.env "$ordinary_key"
    chown root:root /etc/webot/webot.env
    chmod 600 /etc/webot/webot.env
    systemctl restart webot 2>/dev/null || true
    printf '已连接 WeBot，并重新启动服务。\n'
  else
    printf '尚未发现 /etc/webot/webot.env。安装 WeBot 后请再次运行本脚本完成连接。\n'
  fi
  unset ordinary_key
  systemctl --no-pager --full status cliproxyapi || true
  ss -lnt | grep '127.0.0.1:8317' >/dev/null \
    || printf '提示：尚未检测到 127.0.0.1:8317，请查看服务日志。\n'
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux "$@" ;;
  *) die "目前只支持 macOS 和 Linux。" ;;
esac

say "Codex 图片能力安装流程完成"
printf 'CLIProxyAPI 仅监听当前机器的 127.0.0.1:8317。\n'
