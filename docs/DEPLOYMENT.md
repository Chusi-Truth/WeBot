# WeBot 部署指南

本文提供两种部署方式：

1. **本地部署**：支持 macOS、Linux 和 Windows，适合开发与试用；
2. **Windows 后台部署**：当前用户登录后自动运行；
3. **Linux 服务器部署**：适合需要长期在线的个人实例。

本文只介绍 WeBot 本身及其运行环境。无论选择哪种方式，运行 WeBot 的机器都
必须能够正常访问微信 iLink 和你选择的模型 API。

## 0. 新手一键安装

下载完整项目并进入 WeBot 目录后，运行：

```bash
bash deploy/setup.sh
```

Windows 10/11 使用 PowerShell：

```powershell
powershell -NoProfile -File .\deploy\setup-windows.ps1
```

安装器会显示中文菜单：

1. 安装到当前 macOS 或 Linux 电脑；
2. 安装到采用 systemd 的 Linux 服务器，并设置开机自动运行；
3. 安装可选的 Codex 图片理解与图片生成适配服务。

Windows 安装器会单独询问是否创建计划任务。选择后，WeBot 会在当前 Windows
用户登录时自动启动，不需要一直保留终端窗口。

脚本会检查 Node.js 版本、安装依赖、生成受保护的配置、编译项目，并按需引导微信
扫码和 Codex 设备授权。API Key 使用隐藏输入，已有配置会先备份或保留，
`/var/lib/webot` 中的凭证、人物和记忆不会被删除。

也可以直接选择一种方式：

```bash
# 当前电脑
bash deploy/setup.sh local

# Linux 服务器
sudo bash deploy/setup.sh server

# 可选 Codex 图片能力
bash deploy/setup.sh codex
```

Linux 服务器脚本应从一个干净、完整的 WeBot 仓库中运行。它默认把程序安装到
`/opt/webot`，把私密状态放到 `/var/lib/webot`，并创建 `webot.service`。如果目标
目录已经存在，脚本会停止而不是覆盖不明文件。

下面各节保留完整手动步骤，便于排查问题和了解安装器实际执行了什么。

## 1. 部署前准备

### 运行要求

- Node.js 22 或更高版本；
- Git；
- 一个具备微信 ClawBot / iLink 授权入口的微信账号；
- 至少一个可用的模型 Provider；没有配置时可先使用内置 Echo Provider 验证链路；
- 能够出站访问：
  - `https://ilinkai.weixin.qq.com`；
  - 所选模型 Provider 的 API 地址。

WeBot 本身不在服务器上运行模型，不需要 GPU。对于个人使用，1 核 CPU、1 GB
内存即可运行基础文字功能；如果同时处理语音、图片和较大的管理页面，建议至少
2 核 CPU、2 GB 内存和 10 GB 可用磁盘。

### 私密状态目录

WeBot 会在状态目录保存以下数据：

- 微信授权凭证；
- API Key；
- Agent 配置和角色设定；
- 聊天记录、摘要、事实和事件记忆；
- 管理密码哈希和登录令牌；
- Prompt Trace、提醒和自主生活记录。

默认状态目录是 `~/.webot`。正式部署建议通过 `WEBOT_STATE_DIR` 把它放在仓库
之外，并确保只有运行 WeBot 的系统用户可以读取。不要把状态目录、`.env` 或真实
API Key 提交到 Git。

## 2. 方案一：本地部署

以下手动命令适用于 macOS 和常见 Linux 桌面系统。Windows 用户可以直接使用
前面的 PowerShell 安装器，也可以参照本节手动执行 Git、npm 和 Node.js 命令。

### 2.1 获取代码

```bash
git clone https://github.com/Chusi-Truth/WeBot.git
cd WeBot
npm ci
```

验证环境：

```bash
node --version
npm run check
npm test
```

### 2.2 配置环境

```bash
cp .env.example .env
```

最小配置示例：

```dotenv
WEBOT_STATE_DIR=/Users/你的用户名/.webot
WEBOT_DEFAULT_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的_API_Key
WEBOT_ADMIN_ENABLED=true
WEBOT_ADMIN_PORT=3210
```

也可以暂时使用：

```dotenv
WEBOT_DEFAULT_PROVIDER=echo
```

Echo Provider 不调用大模型，只用于确认微信收发链路是否正常。API Key 也可以在
管理后台中填写；后台只显示是否已配置，不会把已有密钥返回给浏览器。

### 2.3 微信扫码授权

```bash
npm run login
```

终端会显示二维码。使用手机微信扫码并确认后，凭证会写入私密状态目录。不要把
二维码、凭证文件或终端中的授权信息发给其他人。

### 2.4 启动

开发或本地使用：

```bash
npm run start
```

需要使用编译后的生产代码时：

```bash
npm run build
node dist/cli.js start
```

首次启动会打印一条初始化管理链接。打开链接，设置至少 10 个字符的管理密码。
以后直接访问：

```text
http://127.0.0.1:3210/admin
```

设置密码后，初始化 Token 链接会停用。浏览器使用 HttpOnly Cookie 保存登录状态，
页面右上角可以主动退出。

### 2.5 停止和重新启动

前台运行时按 `Ctrl+C` 即可安全停止。下次运行：

```bash
npm run start
```

macOS 合盖、系统睡眠、电脑关机或网络断开时，本地 WeBot 无法继续接收消息。如果
需要全天在线，请使用后面的 Linux 服务器方案。

### 2.6 Windows 10/11

先安装 [Node.js](https://nodejs.org/) 22 或更高版本以及 Git，然后在 PowerShell
中下载项目并启动安装器：

```powershell
git clone https://github.com/Chusi-Truth/WeBot.git
Set-Location WeBot
powershell -NoProfile -File .\deploy\setup-windows.ps1
```

私有仓库需要先在 Git 中登录有权访问仓库的 GitHub 账号。不要把访问令牌写进克隆
地址或脚本。

安装器会：

1. 检查 Node.js 版本；
2. 创建 `.env` 和当前用户的私密状态目录；
3. 隐藏读取可选的模型 API Key；
4. 安装依赖、检查并编译项目；
5. 按需打开微信扫码授权；
6. 询问是否创建名为 `WeBot` 的 Windows 计划任务。

选择计划任务后，WeBot 会在当前用户登录 Windows 时后台启动。运行日志和首次管理
链接保存在：

```text
%LOCALAPPDATA%\WeBot\service.log
```

查看服务状态和最近日志：

```powershell
Get-ScheduledTask -TaskName WeBot
Get-Content "$env:LOCALAPPDATA\WeBot\service.log" -Tail 50
```

停止本次后台进程或彻底移除自动启动：

```powershell
Stop-ScheduledTask -TaskName WeBot
Unregister-ScheduledTask -TaskName WeBot
```

移除计划任务不会删除微信凭证、人物设定或聊天记忆。重新运行安装器会更新同名任务，
不会创建多个副本。需要临时在前台调试时，应先停止计划任务，避免两个 WeBot 实例
同时读取同一个微信账号。

计划任务使用当前用户身份，因此电脑重启后需要先登录 Windows；注销、关机或睡眠
期间无法继续收发消息。如果需要无人登录也能长期运行，仍建议使用 Linux 服务器
方案。

Windows 基础安装器不会自动安装可选的 Codex API 适配程序。如果用户已经按照该
程序自身的 Windows 文档在同一台电脑启动它，只需在 WeBot `.env` 或管理后台配置
普通调用密钥，并保持 API Base 为 `http://127.0.0.1:8317/v1`。不要把管理密钥或
OAuth 文件交给 WeBot。

## 3. 方案二：Linux 服务器部署

本节使用 systemd 部署编译后的 Node.js 服务，适用于 Ubuntu、Debian、
OpenCloudOS、Rocky Linux 等常见发行版。示例命令需要具备 `sudo` 权限。

### 3.1 准备服务器

使用系统包管理器安装 Git 和 Node.js 22。不同发行版的 Node.js 包名称和版本可能
不同，请以 Node.js 官方文档或云厂商镜像说明为准。安装后确认：

```bash
node --version
npm --version
git --version
```

创建专用的低权限用户和目录：

```bash
sudo useradd --system --create-home \
  --home-dir /var/lib/webot \
  --shell /usr/sbin/nologin webot

sudo install -d -o root -g root -m 0755 /opt/webot
sudo install -d -o webot -g webot -m 0700 /var/lib/webot
sudo install -d -o root -g root -m 0755 /etc/webot
```

如果系统的不可登录 Shell 位于 `/sbin/nologin`，请相应修改命令。

### 3.2 获取并构建代码

```bash
sudo git clone https://github.com/Chusi-Truth/WeBot.git /opt/webot
cd /opt/webot
sudo npm ci
sudo npm run check
sudo npm test
sudo npm run build
```

私有 GitHub 仓库需要先配置有权读取仓库的部署凭证。不要把个人访问令牌直接写进
克隆 URL、Shell 历史或 systemd 文件。

构建完成后，运行时只需要 `dist/`、`public/`、生产依赖和 `package.json`。为了
便于后续升级，保留完整仓库通常更简单。

### 3.3 创建服务器环境文件

创建 `/etc/webot/webot.env`：

```dotenv
NODE_ENV=production
HOME=/var/lib/webot
WEBOT_STATE_DIR=/var/lib/webot
WEBOT_DEFAULT_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的_API_Key
WEBOT_ADMIN_ENABLED=true
WEBOT_ADMIN_PORT=3210
```

设置权限：

```bash
sudo chown root:root /etc/webot/webot.env
sudo chmod 600 /etc/webot/webot.env
```

真实 API Key 也可以在管理后台中保存。此时可先把默认 Provider 设置为 `echo`，
完成后台初始化后再配置并切换模型。

如果使用自定义 OpenAI-compatible Provider，把不含真实密钥的 Provider 配置放到
状态目录或其他私密路径，并使用 `WEBOT_PROVIDERS_FILE` 指向它。详细字段见项目
根目录的 `providers.example.json`。

### 3.4 在服务器上完成微信授权

```bash
cd /opt/webot
sudo -u webot env \
  HOME=/var/lib/webot \
  WEBOT_STATE_DIR=/var/lib/webot \
  node dist/cli.js login
```

通过 SSH 终端扫描二维码并在手机微信中确认。确认凭证权限：

```bash
sudo find /var/lib/webot -maxdepth 1 -type f -ls
```

凭证、密钥和管理认证文件应属于 `webot` 用户，且敏感文件权限应为 `0600`。

### 3.5 创建 systemd 服务

先确认 Node.js 的绝对路径：

```bash
command -v node
```

创建 `/etc/systemd/system/webot.service`。如果上一条命令不是 `/usr/bin/node`，请
修改 `ExecStart`：

```ini
[Unit]
Description=WeBot Weixin iLink Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=webot
Group=webot
WorkingDirectory=/opt/webot
EnvironmentFile=/etc/webot/webot.env
ExecStart=/usr/bin/node /opt/webot/dist/cli.js start
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/webot

[Install]
WantedBy=multi-user.target
```

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webot
sudo systemctl status webot --no-pager
```

查看实时日志：

```bash
sudo journalctl -u webot -f
```

不要把包含初始化管理链接、用户 ID 或错误上下文的完整日志公开粘贴到 Issue。

### 3.6 管理后台边界

管理后台固定监听服务器的 `127.0.0.1`，不要在安全组、防火墙或 Web 服务器中
公开 `3210` 端口。本文不提供把本机管理页面开放给其他设备的配置方案。

没有服务器本地图形浏览器时，可以先通过环境文件配置 Provider，并使用微信中的
`/help`、`/agent`、`/provider`、`/memory` 和 `/life` 等命令完成日常管理。
如果运行环境已经提供经过管理员批准的本机页面访问能力，请按照该环境自身的安全
规范使用；相关基础设施配置不属于本文范围。

### 3.7 验证运行状态

```bash
sudo systemctl is-active webot
sudo journalctl -u webot --since "10 minutes ago" --no-pager
```

然后在微信中依次验证：

1. 发送 `/help`；
2. 发送普通文字并确认收到回复；
3. 发送 `/provider list`，确认目标 Provider 显示为可用；
4. 按需测试图片、语音、天气和提醒功能。

基础文字对话正常并不代表所有可选媒体 Provider 都已配置。图片理解、图片生成和
语音转写需要对应服务可用。

## 4. 可选：接入 Codex API 适配服务

WeBot 内置 `cliproxy` Provider，可把文字 Agent 与图片能力分开：人物继续使用
DeepSeek 或其他模型聊天，图片理解和图片生成由 Codex 模型处理。

该能力依赖第三方开源项目
[`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI)，
不是 OpenAI 官方 API 服务。它会在运行机器上保存 Codex OAuth 凭证，并消耗对应
ChatGPT/Codex 账号的使用额度。部署前请自行确认账号规则、数据处理方式和使用风险。

推荐让 CLIProxyAPI 与 WeBot 运行在同一台机器，并且都只监听本机地址：

```text
WeBot → http://127.0.0.1:8317/v1 → CLIProxyAPI → Codex
```

不要把 CLIProxyAPI 的 API 端口、管理页面或 OAuth 凭证目录直接暴露到公网。

### 4.1 macOS 本地安装

使用 Homebrew 安装：

```bash
brew install cliproxyapi
```

查看安装位置与可用命令：

```bash
brew --prefix cliproxyapi
cliproxyapi -help
```

Homebrew 在 Apple Silicon Mac 上通常使用配置文件：

```text
/opt/homebrew/etc/cliproxyapi.conf
```

Intel Mac 通常位于：

```text
/usr/local/etc/cliproxyapi.conf
```

不要用下面的片段覆盖安装程序生成的完整配置，只修改对应字段：

```yaml
host: "127.0.0.1"
port: 8317

api-keys:
  - "替换为独立生成的高强度随机值"

remote-management:
  allow-remote: false

disable-image-generation: false
ws-auth: true
```

使用设备授权完成 Codex 登录：

```bash
cliproxyapi \
  -config "$(brew --prefix)/etc/cliproxyapi.conf" \
  -codex-device-login \
  -no-browser
```

按照终端显示的官方设备授权地址和一次性代码，在自己的浏览器中确认登录。不要把
一次性代码或生成的 OAuth 文件交给其他人。

启动服务：

```bash
brew services start cliproxyapi
brew services list | grep cliproxyapi
```

然后在 WeBot 的 `.env` 中配置同一个普通 API Key：

```dotenv
CLIPROXY_API_KEY=上面配置的普通_API_Key
WEBOT_VISION_PROVIDER=cliproxy
WEBOT_VISION_MODEL=gpt-5.6-sol
WEBOT_IMAGE_GENERATION_PROVIDER=cliproxy
WEBOT_IMAGE_GENERATION_MODEL=gpt-image-2
```

重启 WeBot 后，通过管理后台或发送图片进行验证。

### 4.2 Linux 服务器安装

以下示例固定使用 `v7.2.131` 的 Linux x86_64 无插件版本。版本更新很快，升级前
应查看项目的 [Releases](https://github.com/router-for-me/CLIProxyAPI/releases)，
并重新核对官方校验文件。

下载并校验：

```bash
cd /tmp
curl -fL \
  https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.131/CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz \
  -o CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz

echo "a7e1127d10e908f37fa7bb5f5f4a9aebb26e5baca17c7bd92987df3a0bda9043  CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz" \
  | sha256sum -c -
```

ARM64 服务器不能使用上述文件，应从同一 Release 下载对应的
`linux_aarch64_no-plugin` 构建并使用其官方 SHA-256。

创建专用用户和目录：

```bash
sudo useradd --system \
  --home-dir /var/lib/cliproxyapi \
  --create-home \
  --shell /usr/sbin/nologin cliproxyapi

sudo install -d -o root -g root -m 0755 /opt/cliproxyapi
sudo install -d -o root -g cliproxyapi -m 0750 /etc/cliproxyapi
sudo install -d -o cliproxyapi -g cliproxyapi -m 0700 \
  /var/lib/cliproxyapi/auth
```

解压并安装固定版本：

```bash
sudo tar -xzf /tmp/CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz \
  -C /opt/cliproxyapi
sudo chown root:root /opt/cliproxyapi/cli-proxy-api
sudo chmod 755 /opt/cliproxyapi/cli-proxy-api
```

生成一个只供 WeBot 调用的随机 API Key：

```bash
openssl rand -hex 32
```

把输出安全保存，创建 `/etc/cliproxyapi/config.yaml`：

```yaml
host: "127.0.0.1"
port: 8317
auth-dir: "/var/lib/cliproxyapi/auth"

api-keys:
  - "替换为刚才生成的随机值"

remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true

disable-image-generation: false
ws-auth: true
debug: false
request-log: false
```

保护配置文件：

```bash
sudo chown root:cliproxyapi /etc/cliproxyapi/config.yaml
sudo chmod 640 /etc/cliproxyapi/config.yaml
```

### 4.3 在服务器上完成 Codex 授权

```bash
sudo -u cliproxyapi \
  /opt/cliproxyapi/cli-proxy-api \
  -config /etc/cliproxyapi/config.yaml \
  -codex-device-login \
  -no-browser
```

程序会打印官方设备授权页面和一次性代码。使用自己的浏览器完成确认，等待终端提示
授权成功。建议每台服务器单独授权，不要从个人电脑复制长期 OAuth 凭证。

授权完成后收紧文件权限：

```bash
sudo chmod 700 /var/lib/cliproxyapi/auth
sudo find /var/lib/cliproxyapi/auth -maxdepth 1 -type f \
  -exec chmod 600 {} +
```

不要复制或公开凭证文件名、内容、访问令牌、刷新令牌、账号邮箱或完整错误日志。

### 4.4 创建 CLIProxyAPI systemd 服务

创建 `/etc/systemd/system/cliproxyapi.service`：

```ini
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
```

启动并检查：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cliproxyapi
sudo systemctl status cliproxyapi --no-pager
```

确认它只监听服务器本机：

```bash
ss -lnt | grep 8317
```

输出应当显示 `127.0.0.1:8317`，不应显示 `0.0.0.0:8317` 或 `[::]:8317`。

### 4.5 连接 WeBot

把 CLIProxyAPI 配置中的普通 API Key 写入 `/etc/webot/webot.env`：

```dotenv
CLIPROXY_API_KEY=CLIProxyAPI_普通_API_Key
WEBOT_VISION_PROVIDER=cliproxy
WEBOT_VISION_MODEL=gpt-5.6-sol
WEBOT_IMAGE_GENERATION_PROVIDER=cliproxy
WEBOT_IMAGE_GENERATION_MODEL=gpt-image-2
```

不要把 CLIProxyAPI 的管理密钥或 OAuth 凭证交给 WeBot。WeBot 只需要 `api-keys`
中配置的普通调用密钥。

重启两个服务：

```bash
sudo systemctl restart cliproxyapi
sudo systemctl restart webot
sudo systemctl is-active cliproxyapi webot
```

验证模型列表时，先在当前 Shell 中安全输入普通 API Key：

```bash
read -s CLIPROXY_API_KEY
export CLIPROXY_API_KEY

curl http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer ${CLIPROXY_API_KEY}"

unset CLIPROXY_API_KEY
```

最后在微信中发送一张普通图片测试视觉理解，再明确要求生成一张普通图片测试图片
输出。模型实际可用性和名称以 `/v1/models` 的返回结果为准。

如果 CLIProxyAPI 无法访问 Codex 上游，应停止部署并先解决服务器自身的正常网络
连通问题；本文不提供其他网络服务的配置方案。

## 5. 更新版本

更新前先备份状态目录，并确认仓库中没有未提交的服务器本地修改：

```bash
cd /opt/webot
sudo systemctl stop webot
sudo tar -C /var/lib -czf /root/webot-state-backup.tar.gz webot
sudo git status --short
sudo git pull --ff-only
sudo npm ci
sudo npm run check
sudo npm test
sudo npm run build
sudo systemctl start webot
sudo systemctl status webot --no-pager
```

备份文件包含微信凭证、API Key、人物设定和完整聊天记录，应像密码一样保护，
不要上传到公开网盘或 GitHub。

如果服务器仓库存在未提交修改，不要直接执行 `git reset --hard`。先确认修改来源，
把需要保留的内容提交、备份或迁移后再更新。

## 6. 备份与迁移

真正需要备份的是状态目录，而不是 `node_modules`：

```bash
sudo systemctl stop webot
sudo tar -C /var/lib -czf /root/webot-state-backup.tar.gz webot
sudo systemctl start webot
```

迁移到新服务器时：

1. 在新服务器安装并构建同一版本 WeBot；
2. 停止新旧两边的 WeBot；
3. 通过安全的主机间传输方式复制状态备份；
4. 恢复到 `/var/lib/webot`；
5. 设置目录所有者为 `webot:webot`、目录权限 `0700`、敏感文件 `0600`；
6. 启动服务并检查日志。

同一个微信授权不应同时由两台 WeBot 实例消费消息。迁移完成并验证后，再决定如何
处理旧实例。

## 7. 常见问题

### 后台显示“已锁定”

- 首次部署：从服务启动日志获取一次性初始化链接；
- 已设置密码：直接访问 `/admin`，输入管理密码；
- 如果部署在服务器上，管理页面只允许从服务器本机访问；远程页面访问不在本文
  的部署范围内。

### 忘记管理密码

在服务器上停止服务，把密码哈希文件改名保留，然后重新启动：

```bash
sudo systemctl stop webot
sudo mv /var/lib/webot/admin-password.json \
  /var/lib/webot/admin-password.json.backup
sudo systemctl start webot
sudo journalctl -u webot -n 30 --no-pager
```

重新使用日志中的初始化链接设置密码。原微信凭证、Agent 和聊天记忆不会受影响。

### 微信消息没有回复

依次检查：

```bash
sudo systemctl status webot --no-pager
sudo journalctl -u webot --since "10 minutes ago" --no-pager
```

常见原因包括模型密钥未配置、Provider 网络不可达、微信授权过期、模型返回空结果
或工具调用失败。分享日志前请删除用户消息、令牌、API Key、邮箱和服务器地址。

### 修改 `.env` 或环境文件后没有生效

本地 `.env` 和服务器的 systemd `EnvironmentFile` 都只在进程启动时读取。修改后
需要重新启动：

```bash
sudo systemctl restart webot
```

通过管理后台保存的 API Key 会立即生效，不需要重启。

### 服务器需要开放哪些入站端口

WeBot 的消息链路由服务主动连接微信 iLink，不需要为机器人额外开放 Webhook
端口。管理后台也应保持在 `127.0.0.1:3210`，不对公网开放。服务器的入站端口和
防火墙策略由服务器管理员根据自身运维规范决定。
