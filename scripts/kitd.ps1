param(
  [Parameter(Position = 0)]
  [ValidateSet("status", "check", "up", "down", "snapshot", "rollback", "lkg", "list", "watch", "install-task")]
  [string]$Command = "status",
  [string]$Repo = "D:\GitHub\agent-team-kit",
  [string]$LkgTag = "lkg-0.9.0-preview",
  [string]$LkgArtifactId = "",
  [int]$LkgArtifactVersion = 1,
  [string]$LkgVerifiedBy = "",
  [string]$LkgWorkspace = "default",
  [string]$LkgTarget = "workspace-artifacts",
  [string]$Change = "",
  [switch]$Execute,
  [switch]$DryRun,
  [int]$FailuresBeforeRollback = 3,
  [int]$IntervalSeconds = 30,
  [switch]$Web
)

$ErrorActionPreference = "Stop"

$HomeDir = Join-Path $env:USERPROFILE ".agent-team-kit"
$AuditDir = Join-Path $HomeDir "audit"
$StateDir = Join-Path $HomeDir "state"
$AuditFile = Join-Path $AuditDir "kitd.jsonl"
$KillFile = Join-Path $HomeDir "KILL"
$FailFile = Join-Path $StateDir "failures.txt"
$KitState = Join-Path $Repo ".tmp\supervisor\state.json"

New-Item -ItemType Directory -Force -Path $AuditDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Write-Audit {
  param([string]$Action, [string]$Status, [string]$Detail)
  $entry = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    action = $Action
    status = $Status
    detail = $Detail
    repo = $Repo
    lkgTag = $LkgTag
  }
  $entry | ConvertTo-Json -Compress | Add-Content -Path $AuditFile -Encoding UTF8
}

function Get-Health {
  $result = [ordered]@{
    ok = $false
    supervisor = $false
    gateway = $false
    web = $true
    detail = ""
  }

  if (Test-Path $KitState) {
    try {
      $state = Get-Content -Path $KitState -Raw | ConvertFrom-Json
      $pidValue = [int]$state.supervisorPid
      $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($process) {
        $result.supervisor = $true
      } else {
        $result.detail = "supervisor pid $pidValue not running"
      }
    } catch {
      $result.detail = "invalid supervisor state"
    }
  } else {
    $result.detail = "supervisor state missing"
  }

  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:8787/health"
    if ($response.StatusCode -eq 200) {
      $result.gateway = $true
    }
  } catch {
    $result.detail = "$($result.detail) gateway unreachable".Trim()
  }

  if ($Web) {
    try {
      $webResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://localhost:3000/api/health"
      if ($webResponse.StatusCode -eq 200) {
        $result.web = $true
      } else {
        $result.web = $false
      }
    } catch {
      $result.web = $false
      $result.detail = "$($result.detail) web unreachable".Trim()
    }
  }

  $result.ok = $result.supervisor -and $result.gateway -and $result.web
  return [pscustomobject]$result
}

function Invoke-Repo {
  param([string[]]$Arguments)
  Push-Location $Repo
  try {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "git failed: $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Start-Kit {
  Push-Location $Repo
  try {
    $arguments = @("run", "kit", "up", "--no-infra")
    if ($Web) {
      $arguments += "--web"
    }
    & bun @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "kit up failed"
    }
  } finally {
    Pop-Location
  }
}

function Stop-Kit {
  Push-Location $Repo
  try {
    & bun run kit down --keep-infra
  } finally {
    Pop-Location
  }
}

function Get-Failures {
  if (Test-Path $FailFile) {
    try {
      return [int](Get-Content -Path $FailFile -Raw)
    } catch {
      return 0
    }
  }
  return 0
}

function Set-Failures {
  param([int]$Count)
  Set-Content -Path $FailFile -Value $Count -Encoding ASCII
}

function Invoke-Snapshot {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $bundle = Join-Path $StateDir "lkg-$stamp.bundle"
  $commit = ((& git -C $Repo rev-parse HEAD) -join "`n").Trim()
  if ($DryRun) {
    Write-Output "dry-run: tag $LkgTag -> $commit; bundle $bundle"
    Write-Audit "snapshot" "dry-run" "tag=$LkgTag commit=$commit bundle=$bundle"
    return
  }
  Invoke-Repo -Arguments @("-C", $Repo, "tag", "-f", $LkgTag, "HEAD")
  & git -C $Repo bundle create $bundle --all
  if ($LASTEXITCODE -ne 0) {
    throw "git bundle failed"
  }
  $lkgFile = Join-Path $StateDir "lkg.txt"
  @("tag=$LkgTag", "commit=$commit", "bundle=$bundle", "at=$((Get-Date).ToUniversalTime().ToString('o'))") |
    Set-Content -Path $lkgFile -Encoding UTF8
  Write-Audit "snapshot" "ok" "tag=$LkgTag commit=$commit bundle=$bundle"
  Write-Output "snapshot $LkgTag -> $commit"
}

function Invoke-Rollback {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $current = ((& git -C $Repo rev-parse HEAD) -join "`n").Trim()
  $status = ((& git -C $Repo status --porcelain) -join "`n").Trim()
  if ($DryRun) {
    $dirty = "clean"
    if ($status -ne "") {
      $dirty = "dirty"
    }
    Write-Output "dry-run: working tree $dirty; preserve branch recovery/$stamp at $current; reset --hard $LkgTag; bun install; restart kit"
    Write-Audit "rollback" "dry-run" "from=$current to=$LkgTag tree=$dirty"
    return
  }
  if ($status -ne "") {
    Write-Audit "rollback" "refused" "working tree is not clean"
    throw "refusing rollback: working tree is not clean"
  }

  Invoke-Repo -Arguments @("-C", $Repo, "branch", "recovery/$stamp", "HEAD")
  Invoke-Repo -Arguments @("-C", $Repo, "reset", "--hard", $LkgTag)
  Push-Location $Repo
  try {
    & bun install --no-progress
    if ($LASTEXITCODE -ne 0) {
      throw "bun install failed after rollback"
    }
  } finally {
    Pop-Location
  }
  try {
    Stop-Kit
  } catch {
    Write-Audit "rollback" "warn" "kit down failed: $($_.Exception.Message)"
  }
  Start-Kit
  Write-Audit "rollback" "ok" "from=$current to=$LkgTag branch=recovery/$stamp"
  Write-Output "rolled back to $LkgTag (preserved recovery/$stamp)"
}

# Single-change rollback (85 §3.6, issue #89). The TypeScript side owns the
# revert, the store transition and the unified repo-external audit; kitd only
# keeps this thin and records its own summary. Default is dry-run; -Execute
# performs the rollback.
function Invoke-ChangeRollback {
  if ([string]::IsNullOrWhiteSpace($Change)) {
    throw "rollback --change requires a change id"
  }
  $mode = "dry-run"
  $arguments = @(
    "run", "scripts/change-rollback.ts",
    "--change", $Change,
    "--repo", $Repo,
    "--actor", "kitd:operator"
  )
  if ($Execute -and -not $DryRun) {
    $arguments += "--execute"
    $mode = "execute"
  }

  Push-Location $Repo
  try {
    & bun @arguments
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($exitCode -ne 0) {
    Write-Audit "change-rollback" "failed" "change=$Change mode=$mode exit=$exitCode"
    throw "change rollback failed: $Change (mode $mode)"
  }
  Write-Audit "change-rollback" $mode "change=$Change"
  if ($mode -eq "execute") {
    $health = Get-Health
    $healthStatus = "unhealthy"
    if ($health.ok) {
      $healthStatus = "healthy"
    }
    Write-Audit "change-rollback" $healthStatus "change=$Change $($health.detail)"
  }
  Write-Output "change rollback $mode complete: $Change"
}

function Invoke-ChangeList {
  Push-Location $Repo
  try {
    & bun run scripts/change-rollback.ts --list --repo $Repo
    if ($LASTEXITCODE -ne 0) {
      throw "change list failed"
    }
  } finally {
    Pop-Location
  }
  Write-Audit "change-list" "ok" "change rollback audit"
}

function Invoke-LkgSwitch {
  if ([string]::IsNullOrWhiteSpace($LkgArtifactId)) {
    throw "the lkg command requires -LkgArtifactId"
  }
  $verifiedBy = $LkgVerifiedBy
  if ([string]::IsNullOrWhiteSpace($verifiedBy)) {
    $verifiedBy = "kitd"
  }
  $detail = "workspace=$LkgWorkspace target=$LkgTarget artifact=$LkgArtifactId@$LkgArtifactVersion verifier=$verifiedBy"

  if ($DryRun) {
    Push-Location $Repo
    try {
      & bun run scripts/lkg-switch.ts --workspace $LkgWorkspace --target $LkgTarget --artifact $LkgArtifactId --version $LkgArtifactVersion --verified-by $verifiedBy
    } finally {
      Pop-Location
    }
    Write-Audit "lkg-switch" "dry-run" $detail
    Write-Output "dry-run: snapshot then switch artifact LKG $LkgArtifactId@$LkgArtifactVersion (no changes)"
    return
  }

  Write-Audit "lkg-switch" "start" $detail
  # Snapshot first: the repo bundle + tag is the rollback point for the switch.
  Invoke-Snapshot
  Push-Location $Repo
  try {
    & bun run scripts/lkg-switch.ts --workspace $LkgWorkspace --target $LkgTarget --artifact $LkgArtifactId --version $LkgArtifactVersion --verified-by $verifiedBy --execute
    if ($LASTEXITCODE -ne 0) {
      throw "artifact LKG switch failed"
    }
  } finally {
    Pop-Location
  }

  $lkgFile = Join-Path $StateDir "lkg-artifacts.txt"
  @(
    "artifact=$LkgArtifactId",
    "version=$LkgArtifactVersion",
    "workspace=$LkgWorkspace",
    "target=$LkgTarget",
    "verifier=$verifiedBy",
    "at=$((Get-Date).ToUniversalTime().ToString('o'))"
  ) | Set-Content -Path $lkgFile -Encoding UTF8
  Write-Audit "lkg-switch" "ok" $detail
  Write-Output "artifact LKG switched: $LkgArtifactId@$LkgArtifactVersion (snapshot taken, audited)"
}

function Invoke-Check {
  $health = Get-Health
  if ($health.ok) {
    Set-Failures 0
    Write-Audit "check" "healthy" $health.detail
    return $true
  }
  $failures = (Get-Failures) + 1
  Set-Failures $failures
  Write-Audit "check" "unhealthy" "failures=$failures $($health.detail)"
  Write-Output "unhealthy ($failures/$FailuresBeforeRollback): $($health.detail)"
  if ($failures -ge $FailuresBeforeRollback) {
    try {
      Invoke-Rollback
    } catch {
      Write-Audit "rollback" "failed" $_.Exception.Message
      Write-Output "rollback failed: $($_.Exception.Message)"
    }
    Set-Failures 0
  }
  return $false
}

switch ($Command) {
  "status" {
    $health = Get-Health
    $health | ConvertTo-Json
  }
  "check" {
    $ok = Invoke-Check
    if (-not $ok) {
      exit 1
    }
  }
  "up" {
    Start-Kit
    Write-Audit "up" "ok" "kit up --no-infra web=$Web"
  }
  "down" {
    Stop-Kit
    Write-Audit "down" "ok" "kit down --keep-infra"
  }
  "snapshot" {
    Invoke-Snapshot
  }
  "rollback" {
    if ([string]::IsNullOrWhiteSpace($Change)) {
      Invoke-Rollback
    } else {
      Invoke-ChangeRollback
    }
  }
  "lkg" {
    Invoke-LkgSwitch
  }
  "list" {
    Invoke-ChangeList
  }
  "watch" {
    Write-Audit "watch" "start" "interval=$IntervalSeconds failures=$FailuresBeforeRollback web=$Web"
    while ($true) {
      if (Test-Path $KillFile) {
        Write-Audit "watch" "kill" "kill switch file present"
        Stop-Kit
        Write-Output "kill switch triggered"
        break
      }
      $ok = Invoke-Check
      if ($ok) {
        Write-Output "healthy"
      }
      Start-Sleep -Seconds $IntervalSeconds
    }
  }
  "install-task" {
    $scriptPath = Join-Path $HomeDir "bin\kitd.ps1"
    if (-not (Test-Path $scriptPath)) {
      throw "install kitd first: powershell -File scripts\install-kitd.ps1"
    }
    $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" watch -Repo `"$Repo`" -LkgTag `"$LkgTag`""
    & schtasks /Create /SC ONLOGON /TN "AgentTeamKit-Kitd" /TR $taskCommand /F
    if ($LASTEXITCODE -ne 0) {
      throw "schtasks failed"
    }
    Write-Audit "install-task" "ok" "AgentTeamKit-Kitd"
    Write-Output "scheduled task AgentTeamKit-Kitd installed (logon)"
  }
}
