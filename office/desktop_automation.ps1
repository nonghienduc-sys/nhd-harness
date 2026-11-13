param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$PayloadBase64
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NhdDesktopNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint target, bool attachMode);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

function Read-Payload {
  $bytes = [Convert]::FromBase64String($PayloadBase64)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  return $json | ConvertFrom-Json
}

function Get-TypeName($element) {
  try { return $element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") } catch { return "Unknown" }
}

function Get-ElementInfo($element, [int]$depth) {
  $rect = $element.Current.BoundingRectangle
  $runtimeId = @($element.GetRuntimeId())
  [ordered]@{
    runtimeId = ($runtimeId -join ".")
    name = [string]$element.Current.Name
    automationId = [string]$element.Current.AutomationId
    className = [string]$element.Current.ClassName
    controlType = Get-TypeName $element
    processId = [int]$element.Current.ProcessId
    nativeWindowHandle = [int]$element.Current.NativeWindowHandle
    enabled = [bool]$element.Current.IsEnabled
    offscreen = [bool]$element.Current.IsOffscreen
    password = [bool]$element.Current.IsPassword
    depth = $depth
    bounds = if ($rect.IsEmpty) { $null } else { [ordered]@{ x = [math]::Round($rect.X, 2); y = [math]::Round($rect.Y, 2); width = [math]::Round($rect.Width, 2); height = [math]::Round($rect.Height, 2) } }
  }
}

function Get-Window([int]$handle) {
  if ($handle -le 0) { throw "Invalid window handle." }
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
}

function Walk-Elements($root, [int]$maxDepth, [int]$limit) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue([pscustomobject]@{ Element = $root; Depth = 0 })
  $results = [System.Collections.Generic.List[object]]::new()
  while ($queue.Count -gt 0 -and $results.Count -lt $limit) {
    $current = $queue.Dequeue()
    try { $results.Add((Get-ElementInfo $current.Element $current.Depth)) } catch {}
    if ($current.Depth -ge $maxDepth) { continue }
    try { $child = $walker.GetFirstChild($current.Element) } catch { $child = $null }
    while ($null -ne $child -and $results.Count + $queue.Count -lt ($limit * 2)) {
      $queue.Enqueue([pscustomobject]@{ Element = $child; Depth = $current.Depth + 1 })
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  return $results
}

function Find-RuntimeId($root, [string]$runtimeId, [int]$limit = 5000) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($root)
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt $limit) {
    $element = $queue.Dequeue(); $visited++
    try { if ((@($element.GetRuntimeId()) -join ".") -eq $runtimeId) { return $element } } catch {}
    try { $child = $walker.GetFirstChild($element) } catch { $child = $null }
    while ($null -ne $child) {
      $queue.Enqueue($child)
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  return $null
}

function Activate-Window([int]$handle) {
  $h=[IntPtr]$handle
  if ($handle -le 0) { throw "Invalid target window handle." }
  [NhdDesktopNative]::ShowWindowAsync($h, 9) | Out-Null
  Start-Sleep -Milliseconds 100
  $ok=[NhdDesktopNative]::SetForegroundWindow($h)
  if ([NhdDesktopNative]::GetForegroundWindow() -ne $h) {
    $foreground=[NhdDesktopNative]::GetForegroundWindow()
    [uint32]$foregroundProcessId=0
    $foregroundThread=[NhdDesktopNative]::GetWindowThreadProcessId($foreground,[ref]$foregroundProcessId)
    $currentThread=[NhdDesktopNative]::GetCurrentThreadId()
    $attached=$false
    if ($foregroundThread -gt 0 -and $currentThread -gt 0 -and $foregroundThread -ne $currentThread) {
      $attached=[NhdDesktopNative]::AttachThreadInput($currentThread,$foregroundThread,$true)
    }
    try {
      $ok=[NhdDesktopNative]::SetForegroundWindow($h)
      if ($ok) { [NhdDesktopNative]::BringWindowToTop($h) | Out-Null }
    } finally {
      if ($attached) { [NhdDesktopNative]::AttachThreadInput($currentThread,$foregroundThread,$false) | Out-Null }
    }
  }
  Start-Sleep -Milliseconds 120
  if ([NhdDesktopNative]::GetForegroundWindow() -ne $h) { throw "Target window did not become foreground; refusing a blind desktop action." }
}

function Get-RuntimeKey($element) {
  try { return (@($element.GetRuntimeId()) -join ".") } catch { return "" }
}

function Test-IsWithinWindow($element, $window) {
  $windowKey = Get-RuntimeKey $window
  if (-not $windowKey) { return $false }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $element
  for ($depth = 0; $depth -lt 64 -and $null -ne $current; $depth++) {
    if ((Get-RuntimeKey $current) -eq $windowKey) { return $true }
    try { $current = $walker.GetParent($current) } catch { $current = $null }
  }
  return $false
}

function Convert-ToPolicyText([string]$value) {
  $normalized = $value.Normalize([Text.NormalizationForm]::FormD)
  $builder = [Text.StringBuilder]::new()
  foreach ($character in $normalized.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($character) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$builder.Append($character) }
  }
  return $builder.ToString().Replace([char]0x0111, 'd').Replace([char]0x0110, 'd').ToLowerInvariant()
}

function Get-SafeHitTest($window, [int]$x, [int]$y) {
  $hit = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($x, $y))
  if ($null -eq $hit) { throw "No UI Automation element exists at the requested point." }
  if (-not (Test-IsWithinWindow $hit $window)) { throw "The requested point is covered by another window or is outside the selected window." }
  $info = Get-ElementInfo $hit 0
  $label = Convert-ToPolicyText "$($info.name) $($info.automationId) $($info.className) $($info.controlType)"
  $blockedPattern = '(send|gui|delete|xoa|remove|upload|tai\s+len|attach\s+(?:file|files)|dinh\s+kem\s+(?:tep|file)|login|log\s*in|sign\s*in|dang\s+nhap|password|mat\s+khau|payment|thanh\s+toan|transfer|chuyen\s+(?:tien|khoan)|call|goi\s+(?:dien|video)|video\s*call|checkout|purchase|submit|nop)'
  if ($info.password -or $label -match $blockedPattern) { throw "The control at the requested point is blocked by read-only desktop navigation policy." }
  return [ordered]@{ withinSelectedWindow = $true; blocked = $false; control = $info }
}

function Click-WindowPoint($window, [double]$xRatio, [double]$yRatio, [bool]$doubleClick) {
  $rect = $window.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw "Window has no clickable bounds." }
  if ($xRatio -lt 0 -or $xRatio -gt 1 -or $yRatio -lt 0 -or $yRatio -gt 1) { throw "Click ratios must be between 0 and 1." }
  $x = [int]($rect.X + ($rect.Width * $xRatio)); $y = [int]($rect.Y + ($rect.Height * $yRatio))
  $hitTest = Get-SafeHitTest $window $x $y
  [NhdDesktopNative]::SetCursorPos($x, $y) | Out-Null
  $count = if ($doubleClick) { 2 } else { 1 }
  for ($index = 0; $index -lt $count; $index++) {
    [NhdDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [NhdDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    if ($doubleClick) { Start-Sleep -Milliseconds 90 }
  }
  return [ordered]@{ x = $x; y = $y; xRatio = $xRatio; yRatio = $yRatio; doubleClick = $doubleClick; hitTest = $hitTest }
}

function Scroll-WindowPoint($window, [double]$xRatio, [double]$yRatio, [string]$direction, [int]$amount) {
  if ([string]$window.Current.Name -ne "NEU Reader") { throw "Reader scroll requires the verified NEU Reader window." }
  if ($direction -notin @('up', 'down') -or $amount -lt 1 -or $amount -gt 6) { throw "Wheel scroll must be up/down and 1-6 steps." }
  $rect = $window.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw "Window has no scrollable bounds." }
  if ($xRatio -lt 0.12 -or $xRatio -gt 0.64 -or $yRatio -lt 0.16 -or $yRatio -gt 0.90) { throw "Scroll location is outside approved PDF content area." }
  $x = [int]($rect.X + ($rect.Width * $xRatio)); $y = [int]($rect.Y + ($rect.Height * $yRatio))
  $hitTest = Get-SafeHitTest $window $x $y
  [NhdDesktopNative]::SetCursorPos($x, $y) | Out-Null
  $signedDelta = [int](120 * $amount * $(if ($direction -eq 'down') { -1 } else { 1 }))
  $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes($signedDelta), 0)
  [NhdDesktopNative]::mouse_event(0x0800, 0, 0, $wheelData, [UIntPtr]::Zero)
  return [ordered]@{ x = $x; y = $y; xRatio = $xRatio; yRatio = $yRatio; direction = $direction; amount = $amount; hitTest = $hitTest }
}

function Invoke-Element($element) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke(); return "InvokePattern"
  }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select(); return "SelectionItemPattern"
  }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Expand(); return "ExpandCollapsePattern"
  }
  $rect = $element.Current.BoundingRectangle
  if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { throw "Control has no invokable pattern or clickable bounds." }
  $x = [int]($rect.X + ($rect.Width / 2)); $y = [int]($rect.Y + ($rect.Height / 2))
  [NhdDesktopNative]::SetCursorPos($x, $y) | Out-Null
  [NhdDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [NhdDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return "CoordinateFallback"
}

$payload = Read-Payload
if ($Action -eq "windows") {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $windows = @()
  foreach ($element in $children) {
    try {
      $handle = [int]$element.Current.NativeWindowHandle
      $name = [string]$element.Current.Name
      if ($handle -gt 0 -and $name) {
        $info = Get-ElementInfo $element 0
        $windows += [ordered]@{ windowId = [string]$handle; title = $name; processId = [int]$element.Current.ProcessId; automationId = [string]$element.Current.AutomationId; className = [string]$element.Current.ClassName; controlType = Get-TypeName $element; bounds = $info.bounds }
      }
    } catch {}
  }
  @{ windows = $windows } | ConvertTo-Json -Compress -Depth 6
  exit 0
}

$windowId = [int]$payload.windowId
$window = Get-Window $windowId
if ($Action -eq "inspect") {
  $limit = [math]::Min([math]::Max([int]$payload.limit, 20), 2000)
  $maxDepth = [math]::Min([math]::Max([int]$payload.maxDepth, 1), 30)
  $controls = @(Walk-Elements $window $maxDepth $limit)
  @{ windowId = [string]$windowId; controls = $controls; total = $controls.Count; truncated = ($controls.Count -ge $limit) } | ConvertTo-Json -Compress -Depth 8
  exit 0
}
if ($Action -eq "activate") {
  Activate-Window $windowId
  @{ ok = $true; action = "activate"; windowId = [string]$windowId } | ConvertTo-Json -Compress
  exit 0
}
if ($Action -eq "press_key") {
  Activate-Window $windowId
  [System.Windows.Forms.SendKeys]::SendWait([string]$payload.keySequence)
  @{ ok = $true; action = "press_key"; windowId = [string]$windowId } | ConvertTo-Json -Compress
  exit 0
}
if ($Action -eq "scroll") {
  Activate-Window $windowId
  Start-Sleep -Milliseconds 100
  $point = Scroll-WindowPoint $window ([double]$payload.xRatio) ([double]$payload.yRatio) ([string]$payload.direction) ([int]$payload.amount)
  @{ ok = $true; action = "scroll"; windowId = [string]$windowId; point = $point; hitTest = $point.hitTest } | ConvertTo-Json -Compress -Depth 8
  exit 0
}
if ($Action -eq "click_point") {
  Activate-Window $windowId
  Start-Sleep -Milliseconds 150
  $point = Click-WindowPoint $window ([double]$payload.xRatio) ([double]$payload.yRatio) ([bool]$payload.doubleClick)
  @{ ok = $true; action = "click_point"; windowId = [string]$windowId; point = $point; hitTest = $point.hitTest } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

$element = Find-RuntimeId $window ([string]$payload.runtimeId)
if ($null -eq $element) { throw "UI selector is stale or no longer exists." }
if ($Action -eq "invoke") {
  Activate-Window $windowId
  $method = Invoke-Element $element
  @{ ok = $true; action = "invoke"; method = $method; control = Get-ElementInfo $element 0 } | ConvertTo-Json -Compress -Depth 6
  exit 0
}
if ($Action -eq "set_text") {
  if ($element.Current.IsPassword) { throw "Password controls are blocked." }
  Activate-Window $windowId
  $element.SetFocus()
  $controlName = [string]$element.Current.Name
  $preferClipboardPaste = $controlName -match '^(Message input|Type a message|Compose message|Ask anything|Chat input|Prompt input|Message box)$'
  $clipboardRestored = $null
  $pattern = $null
  $hasWritableValuePattern = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not ([System.Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly
  if ($preferClipboardPaste) {
    $clipboardBackup = $null
    $backupCaptured = $false
    for ($i = 0; $i -lt 8 -and -not $backupCaptured; $i++) {
      try { $clipboardBackup = [System.Windows.Forms.Clipboard]::GetDataObject(); $backupCaptured = $true } catch { Start-Sleep -Milliseconds 50 }
    }
    if (-not $backupCaptured) { throw "Clipboard snapshot failed before approved paste." }
    $clipboardSet = $false
    for ($i = 0; $i -lt 8 -and -not $clipboardSet; $i++) {
      try { [System.Windows.Forms.Clipboard]::SetText([string]$payload.text, [System.Windows.Forms.TextDataFormat]::UnicodeText); $clipboardSet = $true } catch { Start-Sleep -Milliseconds 50 }
    }
    if (-not $clipboardSet) { throw "Clipboard staging failed before approved paste." }
    try {
      [System.Windows.Forms.SendKeys]::SendWait("^a")
      [System.Windows.Forms.SendKeys]::SendWait("^v")
      Start-Sleep -Milliseconds 150
      $method = "ClipboardPastePreferred"
    } finally {
      $clipboardRestored = $false
      for ($i = 0; $i -lt 8 -and -not $clipboardRestored; $i++) {
        try {
          if ($null -ne $clipboardBackup) { [System.Windows.Forms.Clipboard]::SetDataObject($clipboardBackup, $true) } else { [System.Windows.Forms.Clipboard]::Clear() }
          $clipboardRestored = $true
        } catch { Start-Sleep -Milliseconds 50 }
      }
    }
    if (-not $clipboardRestored) { throw "Clipboard restoration failed after approved paste; do not retry automatically." }
  } elseif ($hasWritableValuePattern) {
    ([System.Windows.Automation.ValuePattern]$pattern).SetValue([string]$payload.text)
    $method = "ValuePattern"
  } else {
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait([string]$payload.sendKeysText)
    $method = "SendKeysFallback"
  }
  @{ ok = $true; action = "set_text"; method = $method; textLength = ([string]$payload.text).Length; clipboardRestored = $clipboardRestored } | ConvertTo-Json -Compress
  exit 0
}
throw "Unknown desktop automation action."
