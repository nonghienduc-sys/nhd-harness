param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'ChatGPT Workstation Office Companion'
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Office Companion startup task removed.'
  exit 0
}
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw 'Electron is not installed. Run npm install first.' }
$action = New-ScheduledTaskAction -Execute $electron -Argument ('"' + $root + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Dashboard tray and Office COM companion for ChatGPT Workstation MCP Bridge.' -Force | Out-Null
Write-Host 'Office Companion will start at Windows logon.'
