<#
.SYNOPSIS
  Recovery drill for the autonomy loop (85 §5.2-6).

.DESCRIPTION
  Three modes:

    plan          Preflight only. Checks the repo, LKG tag, supervisor and
                  gateway, prints the steps a real drill would run, and exits.
                  No side effects.

    kill-worker   Kills the supervised worker child and measures how long the
                  supervisor takes to restart it. The worker is supervised, so
                  this does not touch the repository. Requires -Force.

    rollback      Full recovery-kernel drill. Creates a temporary
                  drill/recovery-<stamp> branch, commits a change that makes
                  the gateway fail at startup, lets kitd detect three failed
                  health checks and roll back to the LKG tag, then verifies
                  HEAD, the preserved recovery branch, the audit trail and the
                  recovery time. Requires -Force. The original branch pointer
                  is untouched; the broken commit lives on the recovery branch
                  that kitd creates before resetting.

  Evidence is appended to %USERPROFILE%\.agent-team-kit\audit\kitd.jsonl and
  written to recovery-drill-<stamp>.json in the same directory.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\recovery-drill.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\recovery-drill.ps1 `
    -Mode rollback -Force -Web
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("plan", "kill-worker", "rollback")]
  [string]$Mode = "plan",
  [string]$Repo = $(if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }),
  [string]$LkgTag = "lkg-0.9.0-preview",
  [int]$DeadlineSeconds = 600,
  [switch]$Web,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$HomeDir = Join-Path $env:USERPROFILE ".agent-team-kit"
$AuditDir = Join-Path $HomeDir "audit"
$StateDir = Join-Path $HomeDir "state"
$AuditFile = Join-Path $AuditDir "kitd.jsonl"
$KillFile = Join-Path $HomeDir "KILL"
$KitdInRepo = Join-Path $PSScriptRoot "kitd.ps1"
$KitdInstalled = Join-Path $HomeDir "bin\kitd.ps1"
$SupervisorState = Join-Path $Repo ".tmp\supervisor\state.json"
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$ReportPath = Join-Path $AuditDir "recovery-drill-$Stamp.json"

New-Item -ItemType Directory -Force -Path $AuditDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$steps = New-Object System.Collections.ArrayList
$checks = New-Object System.Collections.ArrayList
$startedAt = Get-Date

function Add-Step {
  param([string]$Name, [string]$Status, [string]$Detail)
  [void]$steps.Add([ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    step = $Name
    status = $Status
    detail = $Detail
  })
  Write-Output ("[{0}] {1}: {2}" -f $Status.ToUpperInvariant(), $Name, $Detail)
}

function Add-Check {
  param([string]$Name, [bool]$Pass, [string]$Detail)
  [void]$checks.Add([ordered]@{
    name = $Name
    pass = $Pass
    detail = $Detail
  })
  Write-Output ("[{0}] check {1}: {2}" -f $(if ($Pass) { "PASS" } else { "FAIL" }), $Name, $Detail)
}

function Write-DrillAudit {
  param([string]$Action, [string]$Status, [string]$Detail)
  $entry = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    action = $Action
    status = $Status
    detail = $Detail
    repo = $Repo
    lkgTag = $LkgTag
    drill = $Mode
    stamp = $Stamp
  }
  $entry | ConvertTo-Json -Compress | Add-Content -Path $AuditFile -Encoding UTF8
}

function Invoke-Git {
  param([string[]]$Arguments)
  $output = & git -C $Repo @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $output"
  }
  return (($output | Out-String).Trim())
}

function Test-CleanTree {
  $status = (& git -C $Repo status --porcelain 2>&1 | Out-String).Trim()
  return $status -eq ""
}

function Get-Head {
  return ((& git -C $Repo rev-parse HEAD) -join "`n").Trim()
}

function Get-GatewayHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:8787/health"
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-SupervisorState {
  if (-not (Test-Path $SupervisorState)) {
    return $null
  }
  try {
    return (Get-Content -LiteralPath $SupervisorState -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Get-ChildRecord {
  param($State, [string]$Name)
  if (-not $State -or -not $State.children) {
    return $null
  }
  foreach ($child in $State.children) {
    if ($child.name -eq $Name) {
      return $child
    }
  }
  return $null
}

function Test-PidAlive {
  param([int]$ProcessId)
  if (-not $ProcessId) {
    return $false
  }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Wait-ForCondition {
  param(
    [scriptblock]$Condition,
    [int]$TimeoutSeconds,
    [string]$Label
  )
  $waited = 0
  while ($waited -lt $TimeoutSeconds) {
    if (& $Condition) {
      return [ordered]@{ ok = $true; seconds = $waited }
    }
    Start-Sleep -Seconds 1
    $waited += 1
  }
  Write-Host ("timeout after {0}s waiting for {1}" -f $TimeoutSeconds, $Label)
  return [ordered]@{ ok = $false; seconds = $waited }
}

function Invoke-Kit {
  param([string[]]$Arguments)
  Push-Location $Repo
  try {
    & bun run kit @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "kit $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Start-Kit {
  $arguments = @("up", "--no-infra")
  if ($Web) {
    $arguments += "--web"
  }
  Invoke-Kit -Arguments $arguments
}

function Stop-Kit {
  Invoke-Kit -Arguments @("down", "--keep-infra")
}

function Get-KitdPath {
  if (Test-Path -LiteralPath $KitdInstalled) {
    return $KitdInstalled
  }
  return $KitdInRepo
}

function Invoke-Kitd {
  param([string]$Command)
  $kitd = Get-KitdPath
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $kitd, $Command, "-Repo", $Repo, "-LkgTag", $LkgTag)
  if ($Web) {
    $arguments += "-Web"
  }
  & powershell.exe @arguments
  return $LASTEXITCODE
}

function Assert-Preflight {
  Add-Check -Name "repo" -Pass (Test-Path -LiteralPath $Repo) -Detail $Repo
  if (-not (Test-Path -LiteralPath $Repo)) {
    throw "repository not found: $Repo"
  }
  $isRepo = ((& git -C $Repo rev-parse --is-inside-work-tree 2>&1 | Out-String).Trim() -eq "true")
  Add-Check -Name "git" -Pass $isRepo -Detail "inside work tree=$isRepo"
  if (-not $isRepo) {
    throw "not a git repository: $Repo"
  }
  $tag = (& git -C $Repo rev-parse -q --verify "refs/tags/$LkgTag" 2>&1 | Out-String).Trim()
  $tagOk = $tag -ne ""
  Add-Check -Name "lkg-tag" -Pass $tagOk -Detail "$LkgTag=$tag"
  if (-not $tagOk) {
    throw "LKG tag not found: $LkgTag (run kitd snapshot first)"
  }
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  Add-Check -Name "bun" -Pass ($null -ne $bun) -Detail $(if ($bun) { $bun.Source } else { "missing" })
  if ($null -eq $bun) {
    throw "bun is not on PATH"
  }
  $kitd = Test-Path -LiteralPath $KitdInstalled
  Add-Check -Name "kitd-installed" -Pass $kitd -Detail $(if ($kitd) { $KitdInstalled } else { "using repo copy $KitdInRepo" })
  $kill = Test-Path -LiteralPath $KillFile
  Add-Check -Name "kill-switch" -Pass (-not $kill) -Detail $(if ($kill) { "KILL file present at $KillFile" } else { "absent" })
  if ($kill) {
    throw "kill switch is engaged; clear $KillFile first"
  }
}

function Assert-Force {
  if (-not $Force) {
    throw "mode '$Mode' changes runtime state; re-run with -Force"
  }
}

function Write-Report {
  param([string]$Outcome, [string]$Detail, [int]$RecoverySeconds)
  $report = [ordered]@{
    mode = $Mode
    outcome = $Outcome
    detail = $Detail
    startedAt = $startedAt.ToUniversalTime().ToString("o")
    finishedAt = (Get-Date).ToUniversalTime().ToString("o")
    elapsedSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
    recoverySeconds = $RecoverySeconds
    deadlineSeconds = $DeadlineSeconds
    repo = $Repo
    lkgTag = $LkgTag
    web = [bool]$Web
    checks = $checks
    steps = $steps
  }
  $json = $report | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($ReportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "report: $ReportPath"
  Write-DrillAudit -Action "drill.$Mode" -Status $Outcome -Detail $Detail
}

try {
  Assert-Preflight
  $healthy = Get-GatewayHealth
  $state = Get-SupervisorState
  Add-Check -Name "gateway-healthy" -Pass $healthy -Detail "http://127.0.0.1:8787/health=$healthy"
  Add-Check -Name "supervisor" -Pass ($null -ne $state) -Detail $(if ($state) { "pid $($state.supervisorPid)" } else { "no state.json" })
  $head = Get-Head
  $branch = ((& git -C $Repo rev-parse --abbrev-ref HEAD) -join "`n").Trim()
  Write-Output "head=$head branch=$branch"

  if ($Mode -eq "plan") {
    Write-Output ""
    Write-Output "plan: kill-worker would kill the worker child and wait for the supervisor restart."
    Write-Output "plan: rollback would switch to drill/recovery-$Stamp, inject a gateway startup failure,"
    Write-Output "plan:   drive kitd check until HEAD == $LkgTag, verify recovery/<timestamp> and the audit trail,"
    Write-Output "plan:   then switch back to $branch. Deadline: ${DeadlineSeconds}s."
    Write-Report -Outcome "planned" -Detail "preflight only" -RecoverySeconds 0
    exit 0
  }

  if ($Mode -eq "kill-worker") {
    Assert-Force
    if (-not $healthy -or $null -eq $state) {
      throw "the deployment must be healthy before a kill-worker drill (start kit up first)"
    }
    $worker = Get-ChildRecord -State $state -Name "worker"
    if (-not $worker -or -not (Test-PidAlive -ProcessId $worker.pid)) {
      throw "no live worker child in supervisor state"
    }
    $previousPid = [int]$worker.pid
    Add-Step -Name "kill-worker" -Status "started" -Detail "pid $previousPid"
    $killedAt = Get-Date
    & taskkill /PID $previousPid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "taskkill failed for pid $previousPid"
    }
    $wait = Wait-ForCondition -TimeoutSeconds $DeadlineSeconds -Label "worker restart" -Condition {
      $fresh = Get-SupervisorState
      $record = Get-ChildRecord -State $fresh -Name "worker"
      return ($null -ne $record) -and ([int]$record.pid -ne $previousPid) -and (Test-PidAlive -ProcessId $record.pid)
    }
    $recoverySeconds = [int]((Get-Date) - $killedAt).TotalSeconds
    $restarted = Get-ChildRecord -State (Get-SupervisorState) -Name "worker"
    $newPid = if ($restarted) { $restarted.pid } else { 0 }
    Add-Step -Name "worker-restarted" -Status $(if ($wait.ok) { "ok" } else { "timeout" }) -Detail "seconds=$recoverySeconds"
    Add-Check -Name "recovery-deadline" -Pass ($wait.ok -and $recoverySeconds -le $DeadlineSeconds) -Detail "$recoverySeconds <= $DeadlineSeconds"
    if (-not $wait.ok) {
      throw "worker did not restart within ${DeadlineSeconds}s"
    }
    Write-Report -Outcome "passed" -Detail "worker $previousPid -> $newPid in ${recoverySeconds}s" -RecoverySeconds $recoverySeconds
    exit 0
  }

  # rollback
  Assert-Force
  if (-not (Test-CleanTree)) {
    throw "rollback drill refuses a dirty working tree; commit or stash first"
  }
  if (-not $healthy -or $null -eq $state) {
    throw "the deployment must be healthy before a rollback drill (start kit up first)"
  }
  $tagCommit = ((& git -C $Repo rev-parse "$LkgTag^{commit}") -join "`n").Trim()
  $recoveryBranchesBefore = @(& git -C $Repo for-each-ref --format="%(refname:short)" refs/heads/recovery/ 2>&1)

  $drillBranch = "drill/recovery-$Stamp"
  Add-Step -Name "drill-branch" -Status "started" -Detail $drillBranch
  Invoke-Git -Arguments @("switch", "-c", $drillBranch) | Out-Null

  $gatewayFile = Join-Path $Repo "apps\gateway\src\index.ts"
  $original = [System.IO.File]::ReadAllText($gatewayFile)
  $injected = "// recovery drill $Stamp`nthrow new Error(`"recovery drill: injected startup failure`");`n" + $original
  [System.IO.File]::WriteAllText($gatewayFile, $injected, (New-Object System.Text.UTF8Encoding($false)))
  Invoke-Git -Arguments @("add", "apps/gateway/src/index.ts") | Out-Null
  Invoke-Git -Arguments @("commit", "-m", "drill: inject gateway startup failure ($Stamp)") | Out-Null
  $brokenHead = Get-Head
  Add-Step -Name "inject-failure" -Status "ok" -Detail "commit $brokenHead"

  Add-Step -Name "restart-kit" -Status "started" -Detail "stopping and starting the supervisor"
  Stop-Kit
  Start-Kit
  $down = Wait-ForCondition -TimeoutSeconds 120 -Label "gateway unhealthy" -Condition { -not (Get-GatewayHealth) }
  $unhealthyAt = Get-Date
  Add-Step -Name "gateway-unhealthy" -Status $(if ($down.ok) { "ok" } else { "timeout" }) -Detail "detected at $(Get-Date -Format o)"

  for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
    Invoke-Kitd -Command "check" | Out-Null
    $current = Get-Head
    if ($current -eq $tagCommit) {
      break
    }
    Start-Sleep -Seconds 2
  }
  $rolledBack = (Get-Head) -eq $tagCommit
  Add-Step -Name "kitd-rollback" -Status $(if ($rolledBack) { "ok" } else { "failed" }) -Detail "head=$(Get-Head) lkg=$tagCommit"
  if (-not $rolledBack) {
    throw "kitd did not roll back to $LkgTag"
  }

  $up = Wait-ForCondition -TimeoutSeconds $DeadlineSeconds -Label "gateway healthy after rollback" -Condition { Get-GatewayHealth }
  $recoverySeconds = [int]((Get-Date) - $unhealthyAt).TotalSeconds
  Add-Step -Name "gateway-recovered" -Status $(if ($up.ok) { "ok" } else { "timeout" }) -Detail "seconds=$recoverySeconds"

  $recoveryBranchesAfter = @(& git -C $Repo for-each-ref --format="%(refname:short)" refs/heads/recovery/ 2>&1)
  $newBranches = @($recoveryBranchesAfter | Where-Object { $recoveryBranchesBefore -notcontains $_ })
  $auditLines = @()
  if (Test-Path -LiteralPath $AuditFile) {
    $auditLines = Get-Content -LiteralPath $AuditFile | Where-Object { $_ -match '"action":"(rollback|check)"' }
  }

  Add-Check -Name "head-at-lkg" -Pass $rolledBack -Detail "HEAD=$tagCommit"
  Add-Check -Name "recovery-branch" -Pass ($newBranches.Count -gt 0) -Detail ($newBranches -join ", ")
  Add-Check -Name "audit-trail" -Pass ($auditLines.Count -gt 0) -Detail "$($auditLines.Count) kitd entries"
  Add-Check -Name "recovery-deadline" -Pass ($up.ok -and $recoverySeconds -le $DeadlineSeconds) -Detail "$recoverySeconds <= $DeadlineSeconds"

  Invoke-Git -Arguments @("switch", $branch) | Out-Null
  Add-Step -Name "restore-branch" -Status "ok" -Detail $branch

  $passed = $up.ok -and $rolledBack -and ($newBranches.Count -gt 0) -and ($auditLines.Count -gt 0) -and ($recoverySeconds -le $DeadlineSeconds)
  if ($passed) {
    Write-Report -Outcome "passed" -Detail "rollback to $LkgTag in ${recoverySeconds}s; broken commit preserved on recovery branch" -RecoverySeconds $recoverySeconds
    exit 0
  }
  Write-Report -Outcome "failed" -Detail "rollback drill failed; see checks" -RecoverySeconds $recoverySeconds
  exit 1
} catch {
  $message = $_.Exception.Message
  Write-Output "drill aborted: $message"
  if ($drillBranch -and $branch) {
    $onDrill = ((& git -C $Repo rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim() -eq $drillBranch)
    if ($onDrill -and (Test-CleanTree)) {
      try {
        Invoke-Git -Arguments @("switch", $branch) | Out-Null
        Write-Output "restored branch $branch (drill artifacts remain on $drillBranch)"
      } catch {
        Write-Output "could not restore branch $branch; inspect $drillBranch manually"
      }
    }
  }
  try {
    Write-Report -Outcome "error" -Detail $message -RecoverySeconds 0
  } catch {
    Write-Output "failed to write drill report: $($_.Exception.Message)"
  }
  exit 1
}
