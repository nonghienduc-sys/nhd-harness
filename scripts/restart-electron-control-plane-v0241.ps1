param(
  [int]$TargetPid = 7832,
  [string]$Root = 'D:\ChatGPT-Workstation-MCP'
)
$ErrorActionPreference = 'Stop'
$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$rollbackMain = Join-Path $Root 'deploy-backups\20261023-approval-propagation-pre-v0241\electron\main.cjs'
$receipt = Join-Path $Root 'deploy-backups\electron-control-plane-v0.24.1-restart.json'
$log = Join-Path $Root 'deploy-backups\electron-control-plane-v0.24.1-restart.log'
function Log([string]$message) { Add-Content -LiteralPath $log -Value ("{0:o} {1}" -f (Get-Date), $message) -Encoding UTF8 }
function HealthVersion() {
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:39100/api/health/fast' -TimeoutSec 3
    if ($h.available -and $h.data.version) { return [string]$h.data.version }
  } catch {}
  return $null
}
function FindMainElectronPid() {
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:39100/api/health' -TimeoutSec 3
    $parentPid = [int]$h.runtime.parentPid
    if ($parentPid -gt 0) {
      $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
      if ($candidate -and $candidate.Name -eq 'electron.exe') { return $parentPid }
    }
  } catch {}
  try {
    $p = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'electron.exe' -and
      $_.CommandLine -and
      $_.CommandLine -like ('*' + $Root + '*') -and
      $_.CommandLine -notlike '*--type=*' -and
      $_.CommandLine -notlike '*dist\server.js*' -and
      $_.CommandLine -notlike '*office-companion.js*' -and
      $_.CommandLine -notlike '*tunnel-supervisor.js*'
    } | Select-Object -First 1
    if ($p) { return [int]$p.ProcessId }
  } catch {}
  return $null
}
$started = Get-Date
$rollbackApplied = $false
$newPid = $null
try {
  Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
  Log "Starting controlled Electron restart; targetPid=$TargetPid"
  Start-Sleep -Seconds 2
  if (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {
    Log "Killing Electron process tree pid=$TargetPid"
    & taskkill.exe /PID $TargetPid /T /F | Out-Null
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $port39100 = Get-NetTCPConnection -LocalPort 39100 -State Listen -ErrorAction SilentlyContinue
    $port39102 = Get-NetTCPConnection -LocalPort 39102 -State Listen -ErrorAction SilentlyContinue
    if (-not $port39100 -and -not $port39102) { break }
    Start-Sleep -Milliseconds 500
  }
  Log "Launching Electron from $electron"
  $proc = Start-Process -FilePath $electron -ArgumentList ('"' + $Root + '"') -WorkingDirectory $Root -PassThru
  $newPid = [int]$proc.Id
  Log "Relaunched Electron pid=$newPid"
  $healthy = $false
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $version = HealthVersion
    if ($version -eq '0.24.1') { $healthy = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) { throw 'v0.24.1 health did not become ready after Electron restart.' }
  $mainPid = FindMainElectronPid
  $screenListening = [bool](Get-NetTCPConnection -LocalPort 39102 -State Listen -ErrorAction SilentlyContinue)
  if (-not $mainPid -or -not $screenListening) { throw 'Electron main process or screen companion did not become ready.' }
  $data = [ordered]@{
    ok = $true
    at = (Get-Date).ToString('o')
    oldPid = $TargetPid
    newPid = $mainPid
    productionVersion = (HealthVersion)
    screenPortListening = $screenListening
    rollbackApplied = $false
    rollbackMain = $rollbackMain
  }
  $data | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receipt -Encoding UTF8
  Log "Restart verified: production=0.24.1 mainPid=$mainPid screen=$screenListening"
  exit 0
} catch {
  Log ("Restart failed: " + $_.Exception.Message)
  try {
    if (Test-Path $rollbackMain) {
      Copy-Item -LiteralPath $rollbackMain -Destination (Join-Path $Root 'electron\main.cjs') -Force
      $rollbackApplied = $true
      Log "Restored hard-deny control-plane main.cjs"
    }
    $currentMain = FindMainElectronPid
    if ($currentMain) { & taskkill.exe /PID $currentMain /T /F | Out-Null; Start-Sleep -Seconds 2 }
    $fallback = Start-Process -FilePath $electron -ArgumentList ('"' + $Root + '"') -WorkingDirectory $Root -PassThru
    Log ("Launched rollback Electron pid=" + $fallback.Id)
  } catch { Log ("Rollback relaunch failed: " + $_.Exception.Message) }
  $data = [ordered]@{
    ok = $false
    at = (Get-Date).ToString('o')
    error = $_.Exception.Message
    oldPid = $TargetPid
    attemptedNewPid = $newPid
    productionVersion = (HealthVersion)
    rollbackApplied = $rollbackApplied
    rollbackMain = $rollbackMain
  }
  $data | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receipt -Encoding UTF8
  exit 1
}

