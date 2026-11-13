$Root = if($env:NHD_CUTOVER_ROOT){$env:NHD_CUTOVER_ROOT}else{'D:\ChatGPT-Workstation-MCP'}
$ReleaseId = if($env:NHD_CUTOVER_RELEASE_ID){$env:NHD_CUTOVER_RELEASE_ID}else{''}
$InitialDelaySeconds = if($env:NHD_CUTOVER_INITIAL_DELAY_SECONDS){[int]$env:NHD_CUTOVER_INITIAL_DELAY_SECONDS}else{10}
$TimeoutSeconds = if($env:NHD_CUTOVER_TIMEOUT_SECONDS){[int]$env:NHD_CUTOVER_TIMEOUT_SECONDS}else{90}
$ReceiptPath = if($env:NHD_CUTOVER_RECEIPT_PATH){$env:NHD_CUTOVER_RECEIPT_PATH}else{''}
$ErrorActionPreference='Stop'
$StatePath=Join-Path $Root 'runtime\release-state.json'
$Manager=Join-Path $Root 'scripts\atomic-release.mjs'
$initialState=Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not $ReleaseId){
  if(-not $initialState.candidate){throw 'No staged candidate is available.'}
  if(-not $initialState.candidate.verifiedAt -or -not $initialState.candidate.smokeReceipt){throw 'Staged candidate has not passed the atomic smoke gate.'}
  $ReleaseId=[string]$initialState.candidate.id
}
if(-not $ReceiptPath){$safe=$ReleaseId -replace '[^A-Za-z0-9._-]','_';$ReceiptPath=Join-Path $Root "deploy-backups\atomic-release-$safe-cutover.json"}
$LogPath=[IO.Path]::ChangeExtension($ReceiptPath,'.log')
function Log([string]$m){Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $m" -Encoding UTF8}
function Json([string]$u,[int]$t=3){try{Invoke-RestMethod -Uri $u -TimeoutSec $t}catch{$null}}
function State(){Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8|ConvertFrom-Json}
function Atomic([string[]]$Arguments){
  $out=& node.exe $Manager @Arguments 2>&1
  if($LASTEXITCODE -ne 0){throw "atomic-release failed: $($out -join ' ')"}
  return (($out -join [Environment]::NewLine)|ConvertFrom-Json)
}
function WaitReady([string]$version,[string]$releaseId,[int]$seconds=$TimeoutSeconds){
  for($i=0;$i -lt ($seconds*4);$i++){
    Start-Sleep -Milliseconds 250
    $live=Json 'http://127.0.0.1:39100/api/health/live' 1
    $fast=Json 'http://127.0.0.1:39100/api/health/fast' 3
    if($live -and [string]$live.version -eq $version -and $fast -and $fast.available -and $fast.data -and [string]$fast.data.version -eq $version){
      $identity=$fast.data.runtimeIdentity
      if($identity -and $identity.release -and [string]$identity.release.active.id -eq $releaseId -and [bool]$identity.release.currentMatchesActive){return [pscustomobject]@{live=$live;fast=$fast}}
      if($identity -and -not $identity.release){
        $expectedState=State
        $expectedPath=$null
        if([string]$expectedState.current.id -eq $releaseId){$expectedPath=[string]$expectedState.current.path}
        elseif($expectedState.previous -and [string]$expectedState.previous.id -eq $releaseId){$expectedPath=[string]$expectedState.previous.path}
        if($expectedPath -and [IO.Path]::GetFullPath([string]$identity.runtimeRoot).TrimEnd('\') -ieq [IO.Path]::GetFullPath($expectedPath).TrimEnd('\')){return [pscustomobject]@{live=$live;fast=$fast}}
      }
    }
  }
  return $null
}
function RestartBackend([int]$processId){if($processId -gt 0){Stop-Process -Id $processId -Force -ErrorAction Stop}}

New-Item -ItemType File -Path $LogPath -Force|Out-Null
Start-Sleep -Seconds ([Math]::Max(0,$InitialDelaySeconds))
$before=$null;$beforeState=$null;$promoted=$false
try{
  $beforeState=State
  if(-not $beforeState.candidate -or [string]$beforeState.candidate.id -ne $ReleaseId){throw "Candidate $ReleaseId is not staged."}
  if(-not $beforeState.candidate.verifiedAt -or -not $beforeState.candidate.smokeReceipt){throw 'Candidate has not passed the atomic smoke gate.'}
  $targetVersion=[string]$beforeState.candidate.version
  $before=Json 'http://127.0.0.1:39100/api/health/fast' 5
  if(-not $before -or -not $before.available -or -not $before.data){throw 'Pre-cutover Fast Health unavailable.'}
  if([string]$before.data.version -ne [string]$beforeState.current.version){throw "Live version does not match current release-state."}
  $beforeIdentity=$before.data.runtimeIdentity
  $controllerReady=$false
  if($beforeIdentity.release){
    $controllerReady=([string]$beforeIdentity.release.active.id -eq [string]$beforeState.current.id -and [bool]$beforeIdentity.release.currentMatchesActive)
  } elseif($beforeIdentity.runtimeRoot){
    $controllerReady=([IO.Path]::GetFullPath([string]$beforeIdentity.runtimeRoot).TrimEnd('\') -ieq [IO.Path]::GetFullPath([string]$beforeState.current.path).TrimEnd('\'))
  }
  if(-not $controllerReady){throw 'Atomic release controller is not active on the current production backend.'}
  if(-not $before.data.tunnel.running -or -not $before.data.tunnel.supervisor.running){throw 'Pre-cutover tunnel/supervisor is not healthy.'}
  $backendPid=[int]$before.data.runtime.pid;$mainPid=[int]$before.data.runtime.parentPid
  $supervisorPid=[int]$before.data.tunnel.supervisor.pid;$tunnelPid=[int]$before.data.tunnel.pid;$connectedAt=[string]$before.data.tunnel.connectedAt
  Log "preflight current=$($beforeState.current.id) candidate=$ReleaseId backend=$backendPid main=$mainPid supervisor=$supervisorPid tunnel=$tunnelPid"

  $promotedState=Atomic -Arguments @('promote','--root',$Root,'--release-id',$ReleaseId)
  $promoted=$true
  if([string]$promotedState.current.id -ne $ReleaseId){throw 'Atomic pointer promotion did not select the expected release.'}
  $sw=[Diagnostics.Stopwatch]::StartNew()
  RestartBackend $backendPid
  $ready=WaitReady $targetVersion $ReleaseId $TimeoutSeconds
  $sw.Stop()
  if(-not $ready){throw "Promoted release $ReleaseId did not become ready."}
  $after=$ready.fast.data;$identity=$after.runtimeIdentity
  $assertions=[ordered]@{
    versionCorrect=([string]$after.version -eq $targetVersion)
    releaseCurrent=([string]$identity.release.current.id -eq $ReleaseId)
    releaseActive=([string]$identity.release.active.id -eq $ReleaseId -and [bool]$identity.release.currentMatchesActive)
    previousRelease=([string]$identity.release.previous.id -eq [string]$beforeState.current.id)
    candidateCleared=($null -eq $identity.release.candidate)
    governorRuntimeScoped=([string]$after.governor.lifecycle -eq 'runtime-scoped-v1' -and -not [bool]$after.governor.closed)
    supervisorPidUnchanged=([int]$after.tunnel.supervisor.pid -eq $supervisorPid)
    cloudflaredPidUnchanged=([int]$after.tunnel.pid -eq $tunnelPid)
    tunnelConnectedAtUnchanged=([string]$after.tunnel.connectedAt -eq $connectedAt)
    tunnelRestartAttemptZero=([int]$after.tunnel.restartAttempt -eq 0)
    fastFailureCountZero=([int]$ready.fast.failureCount -eq 0)
  }
  $ok=$true;foreach($v in $assertions.Values){if(-not [bool]$v){$ok=$false}}
  if(-not $ok){throw 'Post-cutover atomic release assertions failed.'}
  $receipt=[ordered]@{ok=$true;releaseId=$ReleaseId;version=$targetVersion;at=(Get-Date).ToUniversalTime().ToString('o');recoveryMs=[math]::Round($sw.Elapsed.TotalMilliseconds,1);before=[ordered]@{releaseId=$beforeState.current.id;version=$beforeState.current.version;backendPid=$backendPid;mainPid=$mainPid;supervisorPid=$supervisorPid;tunnelPid=$tunnelPid;connectedAt=$connectedAt};after=[ordered]@{releaseId=$identity.release.active.id;version=$after.version;backendPid=$after.runtime.pid;mainPid=$after.runtime.parentPid;supervisorPid=$after.tunnel.supervisor.pid;tunnelPid=$after.tunnel.pid;connectedAt=$after.tunnel.connectedAt;generation=$identity.release.generation};assertions=$assertions;rollback=[ordered]@{version=$identity.rollbackVersion;path=$identity.rollbackPath;releaseId=$identity.release.previous.id};fastState=$ready.fast.state;failureCount=$ready.fast.failureCount;log=$LogPath}
  [IO.File]::WriteAllText($ReceiptPath,(($receipt|ConvertTo-Json -Depth 16)+[Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
  Log "cutover passed release=$ReleaseId backend=$($after.runtime.pid) recoveryMs=$([math]::Round($sw.Elapsed.TotalMilliseconds,1))"
  $receipt|ConvertTo-Json -Depth 16
}catch{
  $reason=$_.Exception.Message;Log "cutover failed: $reason"
  $rolledBack=$false
  try{
    if($promoted){
      $current=State
      if([string]$current.current.id -eq $ReleaseId -and $current.previous){$rollbackState=Atomic -Arguments @('rollback','--root',$Root);$rolledBack=$true}else{$rollbackState=$current}
      $liveNow=Json 'http://127.0.0.1:39100/api/health/fast' 2
      if($liveNow -and $liveNow.data -and [int]$liveNow.data.runtime.pid -gt 0){try{Stop-Process -Id ([int]$liveNow.data.runtime.pid) -Force -ErrorAction SilentlyContinue}catch{}}
      if($beforeState -and $rollbackState){$null=WaitReady ([string]$beforeState.current.version) ([string]$beforeState.current.id) $TimeoutSeconds}
    }
  }catch{Log "rollback recovery failed: $($_.Exception.Message)"}
  $failure=[ordered]@{ok=$false;releaseId=$ReleaseId;reason=$reason;rolledBack=$rolledBack;at=(Get-Date).ToUniversalTime().ToString('o');log=$LogPath}
  [IO.File]::WriteAllText($ReceiptPath,(($failure|ConvertTo-Json -Depth 10)+[Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
  throw
}

