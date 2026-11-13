$Root = if($env:NHD_SMOKE_ROOT){$env:NHD_SMOKE_ROOT}else{'D:\ChatGPT-Workstation-MCP'}
$ReleaseId = if($env:NHD_SMOKE_RELEASE_ID){$env:NHD_SMOKE_RELEASE_ID}else{''}
$Port = if($env:NHD_SMOKE_PORT){[int]$env:NHD_SMOKE_PORT}else{39200}
$TimeoutSeconds = if($env:NHD_SMOKE_TIMEOUT_SECONDS){[int]$env:NHD_SMOKE_TIMEOUT_SECONDS}else{90}
$ReceiptPath = if($env:NHD_SMOKE_RECEIPT_PATH){$env:NHD_SMOKE_RECEIPT_PATH}else{''}
$ErrorActionPreference='Stop'
$StatePath=Join-Path $Root 'runtime\release-state.json'
$state=Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not $ReleaseId){if(-not $state.candidate){throw 'No staged candidate is available.'};$ReleaseId=[string]$state.candidate.id}
if(-not $state.candidate -or [string]$state.candidate.id -ne $ReleaseId){throw "Candidate $ReleaseId is not staged."}
$releasePath=[string]$state.candidate.path
$version=[string]$state.candidate.version
$serverPath=Join-Path $releasePath 'dist\server.js'
if(-not (Test-Path -LiteralPath $serverPath)){throw "Candidate server missing: $serverPath"}
if(-not $ReceiptPath){$safe=$ReleaseId -replace '[^A-Za-z0-9._-]','_';$ReceiptPath=Join-Path $Root "deploy-backups\atomic-release-$safe-smoke.json"}
$dataDir=Join-Path $Root ("temp\atomic-smoke-"+($ReleaseId -replace '[^A-Za-z0-9._-]','_'))
$stdout=Join-Path $dataDir 'stdout.log';$stderr=Join-Path $dataDir 'stderr.log'
New-Item -ItemType Directory -Path $dataDir -Force|Out-Null
function GetJson([string]$url,[int]$timeout=2){try{Invoke-RestMethod -Uri $url -TimeoutSec $timeout}catch{$null}}
$old=@{}
$names=@('WORKSTATION_MCP_PORT','WORKSTATION_MCP_LOCAL_PORT','WORKSTATION_MCP_LOCAL_ENABLED','WORKSTATION_OFFICE_PORT','WORKSTATION_SCREEN_PORT','WORKSTATION_BROWSER_PORT','WORKSTATION_MCP_DATA_DIR','WORKSTATION_MCP_VERSION','NHD_SOURCE_ROOT','NHD_SOURCE_VERSION','NHD_RELEASE_STATE_PATH','NHD_RELEASE_ID','NHD_RELEASE_PATH','WORKSTATION_RESTART_REASON')
foreach($n in $names){$old[$n]=[Environment]::GetEnvironmentVariable($n,'Process')}
$proc=$null
try{
  [Environment]::SetEnvironmentVariable('WORKSTATION_MCP_PORT',[string]$Port,'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_MCP_LOCAL_PORT',[string]($Port+4),'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_MCP_LOCAL_ENABLED','1','Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_OFFICE_PORT',[string]($Port+1),'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_SCREEN_PORT',[string]($Port+2),'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_BROWSER_PORT',[string]($Port+3),'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_MCP_DATA_DIR',$dataDir,'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_MCP_VERSION',$version,'Process')
  [Environment]::SetEnvironmentVariable('NHD_SOURCE_ROOT',$Root,'Process')
  [Environment]::SetEnvironmentVariable('NHD_SOURCE_VERSION',$version,'Process')
  [Environment]::SetEnvironmentVariable('NHD_RELEASE_STATE_PATH',$StatePath,'Process')
  [Environment]::SetEnvironmentVariable('NHD_RELEASE_ID',$ReleaseId,'Process')
  [Environment]::SetEnvironmentVariable('NHD_RELEASE_PATH',$releasePath,'Process')
  [Environment]::SetEnvironmentVariable('WORKSTATION_RESTART_REASON','candidate-smoke','Process')
  $proc=Start-Process -FilePath 'node.exe' -ArgumentList @($serverPath) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $live=$null;$fast=$null;$deep=$null
  for($i=0;$i -lt ($TimeoutSeconds*4);$i++){
    Start-Sleep -Milliseconds 250
    if($proc.HasExited){throw "Candidate exited early with code $($proc.ExitCode)."}
    $live=GetJson "http://127.0.0.1:$Port/api/health/live" 1
    if($live -and [string]$live.version -eq $version){
      $fast=GetJson "http://127.0.0.1:$Port/api/health/fast" 3
      if($fast -and $fast.available -and $fast.data -and [string]$fast.data.version -eq $version){break}
    }
  }
  if(-not $fast -or -not $fast.available -or -not $fast.data){throw 'Candidate Fast Health did not become ready.'}
  $deep=GetJson "http://127.0.0.1:$Port/api/health" 15
  if(-not $deep){throw 'Candidate Deep Health failed.'}
  $local=GetJson ("http://127.0.0.1:"+($Port+4)+"/health") 3
  if(-not $local){throw 'Candidate Local Harness Health failed.'}
  $remoteUnauthStatus=$null
  try{Invoke-WebRequest -Uri "http://127.0.0.1:$Port/mcp" -Method Post -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"atomic-smoke","version":"1"}}}' -TimeoutSec 3 -ErrorAction Stop|Out-Null;$remoteUnauthStatus=200}catch{if($_.Exception.Response){$remoteUnauthStatus=[int]$_.Exception.Response.StatusCode}else{$remoteUnauthStatus=-1}}
  $identity=$deep.runtimeIdentity
  $assertions=[ordered]@{
    liveVersion=([string]$live.version -eq $version)
    fastAvailable=[bool]$fast.available
    fastFailureCount=([int]$fast.failureCount -eq 0)
    deepVersion=([string]$deep.version -eq $version)
    releaseModel=([string]$identity.release.model -eq 'atomic-json-pointer-v1')
    activeRelease=([string]$identity.release.active.id -eq $ReleaseId)
    activeRole=([string]$identity.release.active.role -eq 'candidate')
    stagedCandidate=([string]$identity.release.candidate.id -eq $ReleaseId)
    currentStillProduction=([string]$identity.release.current.id -eq [string]$state.current.id)
    currentNotChanged=(-not [bool]$identity.release.currentMatchesActive)
    governorRuntimeScoped=([string]$deep.governor.lifecycle -eq 'runtime-scoped-v1' -and -not [bool]$deep.governor.closed)
    tunnelNotStarted=(-not [bool]$deep.tunnel.running)
    localHarnessListening=([bool]$deep.connections.localIngress.listening)
    localHarnessPort=([int]$deep.connections.localIngress.port -eq ($Port+4))
    localHarnessModel=([string]$deep.connections.model -eq 'multi-harness-single-core-v1')
    localHealthModel=([string]$local.model -eq 'multi-harness-single-core-v1')
    remoteMcpStillRequiresAuth=([int]$remoteUnauthStatus -eq 401)
    openAiTunnelPrivate=(-not [bool]$deep.openAiTunnel.publicExposure -and -not [bool]$deep.openAiTunnel.domainRequired)
  }
  $ok=$true;foreach($value in $assertions.Values){if(-not [bool]$value){$ok=$false}}
  if(-not $ok){throw 'Candidate smoke assertions failed.'}
  $receipt=[ordered]@{ok=$true;releaseId=$ReleaseId;version=$version;releasePath=$releasePath;port=$Port;at=(Get-Date).ToUniversalTime().ToString('o');fastState=$fast.state;collectorLatencyMs=$fast.collectorLatencyMs;identity=$identity;assertions=$assertions;stdout=$stdout;stderr=$stderr}
  [IO.File]::WriteAllText($ReceiptPath,(($receipt|ConvertTo-Json -Depth 16)+[Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
  $receipt|ConvertTo-Json -Depth 16
} finally {
  if($proc -and -not $proc.HasExited){try{Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue}catch{}}
  foreach($n in $names){[Environment]::SetEnvironmentVariable($n,$old[$n],'Process')}
}
