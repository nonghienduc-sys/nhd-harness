param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$base = Join-Path $PSScriptRoot 'desktop_automation.base.ps1'
if (-not (Test-Path -LiteralPath $base)) { throw 'Base desktop automation script is missing.' }

if ($Action -eq 'windows') {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $raw = (& $base -Action $Action -PayloadBase64 $PayloadBase64 | Out-String).Trim()
  $result = $raw | ConvertFrom-Json
  $windows = @($result.windows)
  $seen = @{}
  foreach ($item in $windows) { $seen[[string]$item.windowId] = $true }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $children) {
    try {
      $handle = [int]$element.Current.NativeWindowHandle
      if ($handle -le 0 -or $seen.ContainsKey([string]$handle)) { continue }
      $className = [string]$element.Current.ClassName
      $name = [string]$element.Current.Name
      $rect = $element.Current.BoundingRectangle
      if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      $isTaskbar = $className -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd')
      $isVisibleShellSurface = (-not $name) -and $rect.Width -ge 250 -and $rect.Height -ge 120 -and $rect.X -gt -10000 -and $rect.Y -gt -10000
      if (-not $isTaskbar -and -not $isVisibleShellSurface) { continue }
      $title = if ($isTaskbar) { 'Windows Taskbar' } elseif ($className) { "Shell Surface [$className]" } else { 'Shell Surface' }
      $windows += [pscustomobject]@{
        windowId = [string]$handle
        title = $title
        processId = [int]$element.Current.ProcessId
        automationId = [string]$element.Current.AutomationId
        className = $className
        controlType = 'Pane'
        bounds = [ordered]@{ x=[math]::Round($rect.X,2); y=[math]::Round($rect.Y,2); width=[math]::Round($rect.Width,2); height=[math]::Round($rect.Height,2) }
      }
    } catch {}
  }
  @{ windows = $windows } | ConvertTo-Json -Compress -Depth 6
  exit 0
}

if ($Action -eq 'activate') {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NhdDesktopRestoreNative {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
  $payload = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json)
  $handle = [int]$payload.windowId
  if ($handle -gt 0) {
    try {
      $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
      $pattern = $null
      if ($null -ne $element -and $element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) {
        try { ([System.Windows.Automation.WindowPattern]$pattern).SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) } catch {}
      }
    } catch {}
    [NhdDesktopRestoreNative]::ShowWindowAsync([IntPtr]$handle, 9) | Out-Null
    Start-Sleep -Milliseconds 120
    [NhdDesktopRestoreNative]::SetForegroundWindow([IntPtr]$handle) | Out-Null
  }
}

& $base -Action $Action -PayloadBase64 $PayloadBase64
exit $LASTEXITCODE
