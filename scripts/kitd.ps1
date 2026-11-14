param(
  [Parameter(Position = 0)]
  [ValidateSet("status", "check", "up", "down", "snapshot", "rollback", "watch", "install-task")]
  [string]$Command = "status",
  [string]$Repo = "D:\GitHub\agent-team-kit",
  [string]$LkgTag = "lkg-0.9.0-preview",
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
    Invoke-Rollback
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
