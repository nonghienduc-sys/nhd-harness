param(
  [switch]$EnableFeature,
  [switch]$GenerateConfig,
  [int]$MemoryMB = 3072
)
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
$Feature='Containers-DisposableClientVM'
$SandboxExe='C:\Windows\System32\WindowsSandbox.exe'
$AgentDir=Join-Path $Root 'isolated-agent'
$Exchange='D:\NHD-Agent-Exchange'
$NodeDir='C:\Program Files\nodejs'
$ConfigPath=Join-Path $AgentDir 'NHD-Isolated-Agent.wsb'

function Is-Admin {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Feature-State {
  try { return (Get-WindowsOptionalFeature -Online -FeatureName $Feature -ErrorAction Stop).State.ToString() }
  catch { return 'Unknown' }
}
function XmlEscape([string]$s){ return [Security.SecurityElement]::Escape($s) }

$admin=Is-Admin
$state=Feature-State
if($EnableFeature -and $state -ne 'Enabled'){
  if(-not $admin){ throw 'Enabling Windows Sandbox requires an elevated PowerShell session. Re-run this script as Administrator.' }
  $result=Enable-WindowsOptionalFeature -Online -FeatureName $Feature -All -NoRestart -ErrorAction Stop
  $state=Feature-State
  Write-Host "Windows Sandbox feature state: $state"
  if($result.RestartNeeded){ Write-Warning 'Windows reports RestartNeeded=True. Configuration is saved; reboot once before starting Isolated Agent.' }
}

if($GenerateConfig){
  New-Item -ItemType Directory -Force -Path $AgentDir,$Exchange,(Join-Path $Exchange 'commands'),(Join-Path $Exchange 'responses'),(Join-Path $Exchange 'screenshots'),(Join-Path $Exchange 'state') | Out-Null
  if(-not(Test-Path (Join-Path $AgentDir 'agent.mjs'))){ throw 'isolated-agent\agent.mjs is missing.' }
  if(-not(Test-Path (Join-Path $AgentDir 'desktop-worker.ps1'))){ throw 'isolated-agent\desktop-worker.ps1 is missing.' }
  if(-not(Test-Path (Join-Path $NodeDir 'node.exe'))){ throw "Node runtime was not found at $NodeDir." }
  $MemoryMB=[Math]::Max(2048,[Math]::Min($MemoryMB,6144))
  $command='cmd /d /s /c "set NHD_AGENT_EXCHANGE=C:\NHD\Exchange&& C:\NHD\Node\node.exe C:\NHD\Agent\agent.mjs --bootstrap"'
  $xml=@"
<Configuration>
  <MemoryInMB>$MemoryMB</MemoryInMB>
  <vGPU>Disable</vGPU>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MappedFolders>
    <MappedFolder><HostFolder>$(XmlEscape $AgentDir)</HostFolder><SandboxFolder>C:\NHD\Agent</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(XmlEscape $NodeDir)</HostFolder><SandboxFolder>C:\NHD\Node</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(XmlEscape $Exchange)</HostFolder><SandboxFolder>C:\NHD\Exchange</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>$(XmlEscape $command)</Command></LogonCommand>
</Configuration>
"@
  Set-Content -LiteralPath $ConfigPath -Value $xml -Encoding UTF8
}

[pscustomobject]@{
  Admin=$admin
  Feature=$Feature
  FeatureState=$state
  SandboxExecutablePresent=(Test-Path $SandboxExe)
  AgentCompanionPresent=(Test-Path (Join-Path $AgentDir 'agent.mjs'))
  DesktopHelperPresent=(Test-Path (Join-Path $AgentDir 'desktop.ps1'))
  PersistentDesktopWorkerPresent=(Test-Path (Join-Path $AgentDir 'desktop-worker.ps1'))
  NodeRuntimePresent=(Test-Path (Join-Path $NodeDir 'node.exe'))
  ConfigPresent=(Test-Path $ConfigPath)
  ConfigPath=$ConfigPath
  ExchangeRoot=$Exchange
  RestartMayBeRequired=($EnableFeature -and $state -eq 'Enabled' -and -not(Test-Path $SandboxExe))
} | Format-List

