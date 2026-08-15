#!/usr/bin/env bash

# Shared helpers. This file is sourced by the interactive installers.

say() {
  printf '\n==> %s\n' "$1"
}

die() {
  printf '\n安装未完成：%s\n' "$1" >&2
  exit 1
}

ask_yes_no() {
  prompt="$1"
  default_answer="${2:-yes}"
  if [ "$default_answer" = "yes" ]; then
    suffix='[Y/n]'
  else
    suffix='[y/N]'
  fi
  read -r -p "$prompt $suffix " answer
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    n|N|no|NO|No) return 1 ;;
    '') [ "$default_answer" = "yes" ] ;;
    *) printf '请输入 y 或 n。\n' >&2; ask_yes_no "$prompt" "$default_answer" ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少 $1，请先安装后重新运行。"
}

require_node_22() {
  require_command node
  require_command npm
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [ "$node_major" -ge 22 ] || die "需要 Node.js 22 或更高版本，当前是 $(node --version)。"
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

reject_multiline() {
  value_name="$1"
  value="$2"
  case "$value" in
    *$'\n'*|*$'\r'*) die "$value_name 不能包含换行。" ;;
  esac
}

dotenv_quote() {
  value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

upsert_env() {
  env_file="$1"
  env_key="$2"
  env_value="$3"
  reject_multiline "$env_key" "$env_value"
  env_dir="$(dirname -- "$env_file")"
  if [ ! -d "$env_dir" ]; then
    mkdir -p "$env_dir"
    chmod 700 "$env_dir"
  fi
  temp_file="$(mktemp "$env_dir/.webot-env.XXXXXX")"
  chmod 600 "$temp_file"
  quoted_value="$(dotenv_quote "$env_value")"
  found=false
  if [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$env_key="*)
          if [ "$found" = false ]; then
            printf '%s=%s\n' "$env_key" "$quoted_value" >>"$temp_file"
            found=true
          fi
          ;;
        *) printf '%s\n' "$line" >>"$temp_file" ;;
      esac
    done <"$env_file"
  fi
  if [ "$found" = false ]; then
    printf '%s=%s\n' "$env_key" "$quoted_value" >>"$temp_file"
  fi
  mv -f "$temp_file" "$env_file"
  chmod 600 "$env_file"
}

choose_provider() {
  printf '\n选择聊天模型：\n' >&2
  printf '  1) Echo（不需要密钥，只测试微信连接）\n' >&2
  printf '  2) DeepSeek\n' >&2
  printf '  3) OpenAI API\n' >&2
  read -r -p '请输入序号 [1]: ' provider_choice
  case "${provider_choice:-1}" in
    1) printf 'echo' ;;
    2) printf 'deepseek' ;;
    3) printf 'openai' ;;
    *) die "无法识别模型选项。" ;;
  esac
}

provider_key_name() {
  case "$1" in
    deepseek) printf 'DEEPSEEK_API_KEY' ;;
    openai) printf 'OPENAI_API_KEY' ;;
    *) printf '' ;;
  esac
}

configure_provider_key() {
  env_file="$1"
  provider="$2"
  key_name="$(provider_key_name "$provider")"
  [ -n "$key_name" ] || return 0
  printf 'API Key 只会写入本机受保护的配置文件，不会显示在屏幕上。\n'
  read -r -s -p "请输入 $key_name（现在不填可直接回车）: " api_key
  printf '\n'
  if [ -n "$api_key" ]; then
    reject_multiline "$key_name" "$api_key"
    upsert_env "$env_file" "$key_name" "$api_key"
  else
    printf '已跳过。安装后可在管理后台填写 API Key。\n'
  fi
  unset api_key
}
