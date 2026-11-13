param([Parameter(Mandatory=$true)][string]$PayloadB64)
$ErrorActionPreference = "Stop"
# Detached Windows update guardian. Never trusts arbitrary commands, URL input or paths outside
# the user-scoped updater directory. Runs only after the Electron UI explicitly approved install.
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadB64)) | ConvertFrom-Json
$root = [System.IO.Path]::GetFullPath([string]$payload.updaterRoot).TrimEnd('\')
$transaction = [System.IO.Path]::GetFullPath([string]$payload.transactionDir).TrimEnd('\')
if (!$transaction.StartsWith(($root + '\'),[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update transaction path' }
$target = [string]$payload.targetVersion
$old = [string]$payload.previousVersion
$id = [string]$payload.id
if ($id -notmatch '^[a-f0-9-]{36}$' -or $target -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,4}$' -or $old -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,4}$') { throw 'Invalid update version/transaction' }
$newInstaller = [System.IO.Path]::GetFullPath([string]$payload.newInstaller)
$oldInstaller = [System.IO.Path]::GetFullPath([string]$payload.oldInstaller)
foreach($file in @($newInstaller,$oldInstaller)) {
  if (!$file.StartsWith(($root + '\'),[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Installer outside user update cache' }
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing rollback/update installer' }
}
$exe = [System.IO.Path]::GetFullPath([string]$payload.executablePath)
$dataDir = [System.IO.Path]::GetFullPath([string]$payload.userData)
if ($dataDir -eq $root -or !($root.StartsWith(($dataDir.TrimEnd('\')+'\'),[System.StringComparison]::OrdinalIgnoreCase))) { throw 'Invalid userData updater root' }
$backup = Join-Path $transaction 'backup'
$healthPath = Join-Path $transaction 'health-ok.json'
$receipt = Join-Path $transaction 'guardian-receipt.json'
function Set-Receipt([string]$phase,[string]$detail) {
  $record=@{schemaVersion=1; id=$id; previousVersion=$old; targetVersion=$target; phase=$phase; detail=$detail; updatedAt=[DateTime]::UtcNow.ToString('o')}
  $tmp=$receipt+'.tmp'
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $receipt -Force
}
function Hash-Verified([string]$file,[string]$digest) {
  if ($digest -notmatch '^[a-f0-9]{64}$') { throw 'Invalid expected installer digest' }
  return ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -eq $digest)
}
function Execute-Installer([string]$installer) {
  $proc=Start-Process -FilePath $installer -ArgumentList @('--updated','/S','--force-run') -PassThru
  if (!$proc.WaitForExit(240000)) {
    Set-Receipt 'installer-timeout' 'Installer is still running; refusing overlapping rollback'
    throw 'Installer timed out and may still be running'
  }
  return $proc.ExitCode
}
function Healthy([string]$version,[int]$seconds) {
  $end=[DateTime]::UtcNow.AddSeconds($seconds)
  while([DateTime]::UtcNow -lt $end) {
    if ($version -eq $target -and (Test-Path -LiteralPath $healthPath)) {
      try {
        $marker=Get-Content -LiteralPath $healthPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($marker.id -eq $id -and $marker.version -eq $version -and $marker.backendVersion -eq $version) { return $true }
      } catch {}
    }
    if ($version -eq $old) {
      try {
        $resp=Invoke-RestMethod -Uri 'http://127.0.0.1:39100/api/setup/status' -TimeoutSec 2
        if ($resp.version -eq $old) { return $true }
      } catch {}
    }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Restore-Backup {
  $manifestPath=Join-Path $backup 'backup-manifest.json'
  if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Missing config backup manifest' }
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1) { throw 'Invalid backup schema' }
  $allow=@('config.json','setup-complete.json','cloudflare/config.yml')
  foreach($entry in $manifest.files) {
    $relative=[string]$entry.relativePath
    if ($allow -cnotcontains $relative) { throw 'Backup manifest contains unapproved file' }
    $from=Join-Path $backup ($relative.Replace('/','\'))
    if (!(Test-Path -LiteralPath $from -PathType Leaf)) { throw 'Backup file missing' }
    if (!(Hash-Verified $from ([string]$entry.sha256))) { throw 'Backup content digest mismatch' }
    $to=Join-Path (Join-Path $dataDir 'bridge-data') ($relative.Replace('/','\'))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Copy-Item -LiteralPath $from -Destination $to -Force
  }
}
try {
  if(Test-Path -LiteralPath $healthPath) { Remove-Item -LiteralPath $healthPath -Force }
  Set-Receipt 'waiting-for-exit' 'Waiting for old Electron process to exit'
  $parentPid=[int]$payload.parentPid
  if($parentPid -gt 0) {
    try { Wait-Process -Id $parentPid -Timeout 35 -ErrorAction Stop } catch {
      if(Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { throw 'Old application still running; update refused' }
    }
  }
  if (!(Hash-Verified $newInstaller ([string]$payload.newSha256))) { throw 'Staged installer SHA-256 changed before launch' }
  if (!(Hash-Verified $oldInstaller ([string]$payload.oldSha256))) { throw 'Rollback installer SHA-256 changed before launch' }
  Set-Receipt 'installing' 'Installing user-approved verified update'
  $code=Execute-Installer $newInstaller
  if($code -ne 0) { throw ('Update installer exit code '+$code) }
  if(Test-Path -LiteralPath $exe -PathType Leaf) { Start-Process -FilePath $exe | Out-Null }
  if (Healthy $target 150) {
    Set-Receipt 'success' 'New application and MCP backend reported expected version'
    exit 0
  }
  throw 'Updated application failed to report healthy status'
} catch {
  $failure=$_.Exception.Message
  try {
    Set-Receipt 'rollback-started' $failure
    if (!(Hash-Verified $oldInstaller ([string]$payload.oldSha256))) { throw 'Rollback installer hash mismatch' }
    $revertExit=Execute-Installer $oldInstaller
    if($revertExit -ne 0) { throw ('Rollback installer exit code '+$revertExit) }
    Restore-Backup
    if(Test-Path -LiteralPath $exe -PathType Leaf) { Start-Process -FilePath $exe | Out-Null }
    if(Healthy $old 120) {
      Set-Receipt 'rolled-back' $failure
      exit 2
    }
    Set-Receipt 'rollback-unverified' 'Old installer ran and config was restored, but health did not confirm'
    exit 3
  } catch {
    Set-Receipt 'rollback-failed' ($failure+'; rollback: '+$_.Exception.Message)
    exit 4
  }
}
