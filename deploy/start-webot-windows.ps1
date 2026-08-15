$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $env:LOCALAPPDATA "WeBot"
$LogFile = Join-Path $LogDir "service.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
try {
  $Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $LogDir /inheritance:r /grant:r "*$($Sid):(OI)(CI)F" | Out-Null
}
catch {
  # The current Windows account can still run WeBot if ACL hardening is unavailable.
}

if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 10MB) {
  Move-Item -Force $LogFile "$LogFile.previous"
}

Set-Location $RootDir
& node (Join-Path $RootDir "dist\cli.js") start *>> $LogFile
exit $LASTEXITCODE
