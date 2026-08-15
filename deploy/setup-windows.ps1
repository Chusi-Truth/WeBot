[CmdletBinding()]
param(
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvFile = Join-Path $RootDir ".env"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-Setup([string]$Message) {
  throw "安装未完成：$Message"
}

function Read-YesNo([string]$Prompt, [bool]$DefaultYes = $true) {
  $Suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $Answer = (Read-Host "$Prompt $Suffix").Trim().ToLowerInvariant()
    if ($Answer -eq "") { return $DefaultYes }
    if ($Answer -in @("y", "yes")) { return $true }
    if ($Answer -in @("n", "no")) { return $false }
    Write-Host "请输入 y 或 n。" -ForegroundColor Yellow
  }
}

function Assert-Command([string]$Name, [string]$InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Stop-Setup "缺少 $Name。$InstallHint"
  }
}

function Invoke-Npm([string[]]$Arguments) {
  $Npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if (-not $Npm) { $Npm = Get-Command "npm" -ErrorAction Stop }
  & $Npm.Source @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-Setup "npm $($Arguments -join ' ') 执行失败。"
  }
}

function ConvertTo-DotEnvValue([string]$Value) {
  if ($Value.Contains("`r") -or $Value.Contains("`n")) {
    Stop-Setup "配置值不能包含换行。"
  }
  $Escaped = $Value.Replace("\", "\\").Replace('"', '\"')
  return '"' + $Escaped + '"'
}

function Protect-CurrentUserPath([string]$Path, [bool]$Directory = $false) {
  try {
    $Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $Grant = if ($Directory) { "*$($Sid):(OI)(CI)F" } else { "*$($Sid):F" }
    & icacls.exe $Path /inheritance:r /grant:r $Grant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls returned $LASTEXITCODE" }
  }
  catch {
    Write-Warning "无法自动收紧 $Path 的权限，请确认其他 Windows 用户不能读取它。"
  }
}

function Set-DotEnvValue([string]$Path, [string]$Key, [string]$Value) {
  $Parent = Split-Path -Parent $Path
  if (-not (Test-Path $Parent)) {
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
  }
  $Lines = if (Test-Path $Path) {
    [System.IO.File]::ReadAllLines($Path)
  }
  else {
    @()
  }
  $Replacement = "$Key=$(ConvertTo-DotEnvValue $Value)"
  $Pattern = "^$([regex]::Escape($Key))="
  $Output = New-Object System.Collections.Generic.List[string]
  $Found = $false
  foreach ($Line in $Lines) {
    if ($Line -match $Pattern) {
      if (-not $Found) {
        [void]$Output.Add($Replacement)
        $Found = $true
      }
    }
    else {
      [void]$Output.Add($Line)
    }
  }
  if (-not $Found) { [void]$Output.Add($Replacement) }

  $Temporary = "$Path.$PID.tmp"
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Temporary, $Output, $Utf8NoBom)
  Move-Item -Force $Temporary $Path
  Protect-CurrentUserPath $Path
}

function Read-SecretText([string]$Prompt) {
  $Secure = Read-Host $Prompt -AsSecureString
  if ($Secure.Length -eq 0) { return "" }
  $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
  }
}

function Register-WeBotTask {
  Assert-Command "Register-ScheduledTask" "当前 Windows 版本不支持计划任务命令，请改用前台启动。"
  $TaskName = "WeBot"
  $Starter = Join-Path $RootDir "deploy\start-webot-windows.ps1"
  $PowerShellCommand = if ($PSVersionTable.PSEdition -eq "Core") {
    Get-Command "pwsh.exe" -ErrorAction Stop
  }
  else {
    Get-Command "powershell.exe" -ErrorAction Stop
  }
  $PowerShellExe = $PowerShellCommand.Source
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $Action = New-ScheduledTaskAction `
    -Execute $PowerShellExe `
    -Argument "-NoProfile -WindowStyle Hidden -File `"$Starter`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity
  $Principal = New-ScheduledTaskPrincipal `
    -UserId $Identity `
    -LogonType Interactive `
    -RunLevel Limited
  $Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

  $Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($Existing) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Description "WeBot Weixin iLink Agent" `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

if ($Help) {
  @"
在 Windows 10/11 上交互式安装 WeBot。

用法：
  powershell -NoProfile -File .\deploy\setup-windows.ps1

脚本会检查 Node.js、安装依赖、创建私密配置、编译项目并引导微信扫码。
可以选择注册当前用户登录后自动运行的 Windows 计划任务。
"@ | Write-Host
  exit 0
}

if (-not (Test-Path (Join-Path $RootDir "package.json"))) {
  Stop-Setup "请在完整的 WeBot 项目中运行此脚本。"
}
Assert-Command "node" "请先从 https://nodejs.org 安装 Node.js 22 或更高版本。"
Assert-Command "npm" "Node.js 安装不完整，请重新安装 Node.js 22 或更高版本。"

$NodeVersion = (& node --version).Trim()
if ($NodeVersion -notmatch '^v(?<major>\d+)\.') {
  Stop-Setup "无法识别 Node.js 版本：$NodeVersion"
}
if ([int]$Matches["major"] -lt 22) {
  Stop-Setup "需要 Node.js 22 或更高版本，当前是 $NodeVersion。"
}

Write-Step "配置 WeBot"
$DefaultStateDir = Join-Path $env:USERPROFILE ".webot"
$StateInput = (Read-Host "私密数据保存位置 [$DefaultStateDir]").Trim()
$StateDir = if ($StateInput) {
  [Environment]::ExpandEnvironmentVariables($StateInput)
}
else {
  $DefaultStateDir
}
if (-not [System.IO.Path]::IsPathRooted($StateDir)) {
  Stop-Setup "私密数据位置必须是绝对路径。"
}
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
Protect-CurrentUserPath $StateDir $true

$PortText = (Read-Host "管理后台端口 [3210]").Trim()
if (-not $PortText) { $PortText = "3210" }
$AdminPort = 0
if (-not [int]::TryParse($PortText, [ref]$AdminPort) -or $AdminPort -lt 1024 -or $AdminPort -gt 65535) {
  Stop-Setup "后台端口必须是 1024–65535 之间的数字。"
}

Write-Host ""
Write-Host "选择聊天模型："
Write-Host "  1) Echo（不需要密钥，只测试微信连接）"
Write-Host "  2) DeepSeek"
Write-Host "  3) OpenAI API"
$ProviderChoice = (Read-Host "请输入序号 [1]").Trim()
if (-not $ProviderChoice) { $ProviderChoice = "1" }
switch ($ProviderChoice) {
  "1" { $Provider = "echo"; $KeyName = "" }
  "2" { $Provider = "deepseek"; $KeyName = "DEEPSEEK_API_KEY" }
  "3" { $Provider = "openai"; $KeyName = "OPENAI_API_KEY" }
  default { Stop-Setup "无法识别模型选项。" }
}

if (Test-Path $EnvFile) {
  $Backup = "$EnvFile.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item $EnvFile $Backup
  Protect-CurrentUserPath $Backup
  Write-Host "检测到已有 .env，已先备份；只更新本次选择的项目。"
}
Set-DotEnvValue $EnvFile "WEBOT_STATE_DIR" $StateDir
Set-DotEnvValue $EnvFile "WEBOT_DEFAULT_PROVIDER" $Provider
Set-DotEnvValue $EnvFile "WEBOT_ADMIN_ENABLED" "true"
Set-DotEnvValue $EnvFile "WEBOT_ADMIN_PORT" ($AdminPort.ToString())

if ($KeyName) {
  Write-Host "API Key 只会写入当前用户可读的配置文件，不会显示在屏幕上。"
  $ApiKey = Read-SecretText "请输入 $KeyName（现在不填可直接回车）"
  if ($ApiKey) {
    Set-DotEnvValue $EnvFile $KeyName $ApiKey
  }
  else {
    Write-Host "已跳过。安装后可在管理后台填写 API Key。"
  }
  $ApiKey = $null
}

Write-Step "安装依赖并检查项目"
Push-Location $RootDir
try {
  Invoke-Npm @("ci")
  Invoke-Npm @("run", "check")
  Invoke-Npm @("run", "build")

  if (Read-YesNo "现在进行微信扫码授权吗？" $true) {
    Invoke-Npm @("run", "login")
  }
}
finally {
  Pop-Location
}

Write-Step "基础安装完成"
Write-Host "私密数据：$StateDir"
Write-Host "管理后台：http://127.0.0.1:$AdminPort/admin"

if (Read-YesNo "是否在当前 Windows 用户登录后自动运行 WeBot？" $true) {
  Register-WeBotTask
  $LogFile = Join-Path $env:LOCALAPPDATA "WeBot\service.log"
  Write-Host ""
  Write-Host "WeBot 已在后台启动。"
  Write-Host "首次管理链接和运行日志：$LogFile"
  Write-Host "停止后台任务：Stop-ScheduledTask -TaskName WeBot"
  Write-Host "移除自动启动：Unregister-ScheduledTask -TaskName WeBot"
}
else {
  Write-Host ""
  Write-Host "以后在项目目录运行：npm run start"
  if (Read-YesNo "现在前台启动 WeBot 吗？（Ctrl+C 停止）" $true) {
    Set-Location $RootDir
    Invoke-Npm @("run", "start")
  }
}

Write-Host ""
Write-Host "提示：Windows 睡眠、关机或当前用户注销后，WeBot 无法继续收发消息。"
