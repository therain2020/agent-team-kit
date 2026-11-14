param(
  [string]$Repo = "D:\GitHub\agent-team-kit",
  [switch]$InstallTask
)

$ErrorActionPreference = "Stop"

$HomeDir = Join-Path $env:USERPROFILE ".agent-team-kit"
$BinDir = Join-Path $HomeDir "bin"
$AuditDir = Join-Path $HomeDir "audit"
$StateDir = Join-Path $HomeDir "state"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
New-Item -ItemType Directory -Force -Path $AuditDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$source = Join-Path $PSScriptRoot "kitd.ps1"
$target = Join-Path $BinDir "kitd.ps1"
Copy-Item -Path $source -Destination $target -Force

$hash = (Get-FileHash -Path $target -Algorithm SHA256).Hash
$manifest = [ordered]@{
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  source = $source
  target = $target
  sha256 = $hash
  repo = $Repo
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $BinDir "kitd.manifest.json") -Encoding UTF8

$readme = @(
  "Agent Team Kit recovery kernel",
  "",
  "Installed copy (outside the repository): $target",
  "Audit sink: $AuditDir",
  "Kill switch: $(Join-Path $HomeDir 'KILL')",
  "",
  "Usage:",
  "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$target`" status -Repo `"$Repo`"",
  "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$target`" snapshot -Repo `"$Repo`"",
  "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$target`" watch -Repo `"$Repo`"",
  "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$target`" rollback -Repo `"$Repo`" -DryRun",
  "",
  "The watchdog is intentionally outside the repository so a bad self-change",
  "cannot remove the ability to recover. Re-run this installer to update it."
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $BinDir "README.txt") -Value $readme -Encoding UTF8

Write-Output "installed kitd to $target"
Write-Output "sha256 $hash"

if ($InstallTask) {
  powershell -NoProfile -ExecutionPolicy Bypass -File $target install-task -Repo $Repo
}
