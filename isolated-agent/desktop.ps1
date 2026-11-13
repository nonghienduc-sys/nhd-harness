param(
  [Parameter(Mandatory=$true)][ValidateSet('list','inspect','action','screenshot')][string]$Action,
  [string]$PayloadBase64 = '',
  [Parameter(Mandatory=$true)][string]$ExchangeRoot
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NhdIsoUser32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,UIntPtr dwExtraInfo);
  public const uint LEFTDOWN=0x0002;
  public const uint LEFTUP=0x0004;
}
'@

function Decode-Payload {
  if(-not $PayloadBase64){ return @{} }
  $json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  if(-not $json){ return @{} }
  return $json | ConvertFrom-Json
}
function Safe([object]$v,[int]$max=500){
  $s=[string]$v
  $s=($s -replace '\s+',' ').Trim()
  if($s.Length -gt $max){$s=$s.Substring(0,$max)}
  return $s
}
function ControlTypeName($el){
  try{return ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.','')}catch{return ''}
}
function Bounds($el){
  try{
    $r=$el.Current.BoundingRectangle
    $vals=@([double]$r.X,[double]$r.Y,[double]$r.Width,[double]$r.Height)
    foreach($v in $vals){ if([double]::IsNaN($v) -or [double]::IsInfinity($v)){ return $null } }
    return [ordered]@{x=$vals[0];y=$vals[1];width=$vals[2];height=$vals[3]}
  }catch{return $null}
}
function Encode-Selector($el){
  $d=[ordered]@{
    pid=[int]$el.Current.ProcessId
    aid=Safe $el.Current.AutomationId 300
    name=Safe $el.Current.Name 300
    type=ControlTypeName $el
    cls=Safe $el.Current.ClassName 300
    bounds=Bounds $el
  }
  $json=$d|ConvertTo-Json -Compress -Depth 5
  return 'iso-uia-'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function Decode-Selector([string]$id){
  if(-not $id.StartsWith('iso-uia-')){throw 'Invalid isolated selector.'}
  $s=$id.Substring(8).Replace('-','+').Replace('_','/')
  while(($s.Length%4)-ne 0){$s+='='}
  return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))|ConvertFrom-Json)
}
function Top-Windows {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond))
}
function Window-ById([string]$id){
  foreach($w in Top-Windows){
    $h=[int64]$w.Current.NativeWindowHandle
    if([string]$h -eq $id){return $w}
  }
  throw "Isolated window not found: $id"
}
function Matches($el,$d){
  try{
    if([int]$el.Current.ProcessId -ne [int]$d.pid){return $false}
    if($d.aid -and (Safe $el.Current.AutomationId 300) -ne [string]$d.aid){return $false}
    if($d.type -and (ControlTypeName $el) -ne [string]$d.type){return $false}
    if($d.cls -and (Safe $el.Current.ClassName 300) -ne [string]$d.cls){return $false}
    if($d.name -and (Safe $el.Current.Name 300) -ne [string]$d.name){return $false}
    return $true
  }catch{return $false}
}
function Resolve-Control([string]$selectorId,[string]$windowId){
  $d=Decode-Selector $selectorId
  $root=if($windowId){Window-ById $windowId}else{[System.Windows.Automation.AutomationElement]::RootElement}
  $all=@($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition))
  $matches=@($all|Where-Object{Matches $_ $d})
  if($matches.Count -ne 1){throw "Isolated selector is stale or ambiguous; inspect again. matches=$($matches.Count)"}
  return $matches[0]
}
function Inspect-Control($el){
  return [ordered]@{
    selectorId=Encode-Selector $el
    name=Safe $el.Current.Name 500
    automationId=Safe $el.Current.AutomationId 300
    className=Safe $el.Current.ClassName 300
    controlType=ControlTypeName $el
    processId=[int]$el.Current.ProcessId
    nativeWindowHandle=[int64]$el.Current.NativeWindowHandle
    enabled=[bool]$el.Current.IsEnabled
    offscreen=[bool]$el.Current.IsOffscreen
    password=[bool]$el.Current.IsPassword
    bounds=Bounds $el
  }
}
function Press-Key([string]$key){
  $map=@{
    'ESCAPE'='{ESC}';'TAB'='{TAB}';'SHIFT_TAB'='+{TAB}';'UP'='{UP}';'DOWN'='{DOWN}';'LEFT'='{LEFT}';'RIGHT'='{RIGHT}';
    'PAGE_UP'='{PGUP}';'PAGE_DOWN'='{PGDN}';'HOME'='{HOME}';'END'='{END}';'ENTER'='{ENTER}';'SPACE'=' '
  }
  if(-not $map.ContainsKey($key)){throw "Unsupported isolated desktop key: $key"}
  [System.Windows.Forms.SendKeys]::SendWait($map[$key])
}

$payload=Decode-Payload
$result=$null
switch($Action){
  'list' {
    $windows=@()
    foreach($w in Top-Windows){
      try{
        if($w.Current.IsOffscreen){continue}
        $windows += [ordered]@{windowId=[string][int64]$w.Current.NativeWindowHandle;title=Safe $w.Current.Name 500;processId=[int]$w.Current.ProcessId;className=Safe $w.Current.ClassName 300;bounds=Bounds $w}
      }catch{}
    }
    $result=[ordered]@{windows=$windows;count=$windows.Count}
  }
  'inspect' {
    $windowId=Safe $payload.windowId 128
    $query=(Safe $payload.query 500).ToLowerInvariant()
    $limitRaw=300; if($null -ne $payload.limit){$limitRaw=[int]$payload.limit}`r`n    $limit=[Math]::Max(20,[Math]::Min($limitRaw,1000))
    $w=Window-ById $windowId
    $all=@($w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition))
    $controls=@()
    foreach($el in $all){
      if($controls.Count -ge $limit){break}
      try{
        if($el.Current.IsOffscreen){continue}
        $item=Inspect-Control $el
        $hay=("$($item.name) $($item.automationId) $($item.className) $($item.controlType)").ToLowerInvariant()
        if($query -and -not $hay.Contains($query)){continue}
        $controls+=$item
      }catch{}
    }
    $result=[ordered]@{windowId=$windowId;controls=$controls;returned=$controls.Count;truncated=$all.Count -gt $controls.Count}
  }
  'action' {
    $kind=Safe $payload.action 40
    $windowId=Safe $payload.windowId 128
    $w=if($windowId){Window-ById $windowId}else{$null}
    if($w){[void][NhdIsoUser32]::SetForegroundWindow([IntPtr][int64]$w.Current.NativeWindowHandle);Start-Sleep -Milliseconds 80}
    if($kind -eq 'invoke'){
      $el=Resolve-Control (Safe $payload.selectorId 1024) $windowId
      if(-not $el.Current.IsEnabled){throw 'Isolated control is disabled.'}
      $pat=$null
      if(-not $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pat)){throw 'Control does not support InvokePattern.'}
      ([System.Windows.Automation.InvokePattern]$pat).Invoke();$result=[ordered]@{ok=$true;action='invoke'}
    }elseif($kind -eq 'set_text'){
      $el=Resolve-Control (Safe $payload.selectorId 1024) $windowId
      if($el.Current.IsPassword){throw 'Password controls are blocked.'}
      $desc=("$($el.Current.Name) $($el.Current.AutomationId) $($el.Current.ClassName)")
      if($desc -match '(?i)password|passcode|otp|cvv|cvc|card|bank|routing|secret|token'){throw 'Sensitive field is blocked.'}
      $pat=$null
      if(-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pat)){throw 'Control does not support ValuePattern.'}
      ([System.Windows.Automation.ValuePattern]$pat).SetValue(([string]$payload.text).Substring(0,[Math]::Min(([string]$payload.text).Length,2000)));$result=[ordered]@{ok=$true;action='set_text';characters=([string]$payload.text).Length}
    }elseif($kind -eq 'press_key'){
      Press-Key ((Safe $payload.key 40).ToUpperInvariant());$result=[ordered]@{ok=$true;action='press_key';key=(Safe $payload.key 40)}
    }elseif($kind -eq 'click_point'){
      if(-not $w){throw 'windowId is required for click_point.'}
      $r=$w.Current.BoundingRectangle;$xr=[Math]::Max(0,[Math]::Min(1,[double]$payload.xRatio));$yr=[Math]::Max(0,[Math]::Min(1,[double]$payload.yRatio));
      $x=[int]($r.X+$r.Width*$xr);$y=[int]($r.Y+$r.Height*$yr);[void][NhdIsoUser32]::SetCursorPos($x,$y);Start-Sleep -Milliseconds 50;[NhdIsoUser32]::mouse_event([NhdIsoUser32]::LEFTDOWN,0,0,0,[UIntPtr]::Zero);[NhdIsoUser32]::mouse_event([NhdIsoUser32]::LEFTUP,0,0,0,[UIntPtr]::Zero);$result=[ordered]@{ok=$true;action='click_point';x=$x;y=$y}
    }else{throw "Unsupported isolated desktop action: $kind"}
  }
  'screenshot' {
    $screen=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp=New-Object System.Drawing.Bitmap($screen.Width,$screen.Height)
    $g=[System.Drawing.Graphics]::FromImage($bmp)
    try{$g.CopyFromScreen($screen.Location,[System.Drawing.Point]::Empty,$screen.Size);$name=('desktop-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.png');$dir=Join-Path $ExchangeRoot 'screenshots';New-Item -ItemType Directory -Force -Path $dir|Out-Null;$path=Join-Path $dir $name;$bmp.Save($path,[System.Drawing.Imaging.ImageFormat]::Png);$result=[ordered]@{ok=$true;mimeType='image/png';relativePath=('screenshots\'+$name);width=$screen.Width;height=$screen.Height}}finally{$g.Dispose();$bmp.Dispose()}
  }
}
$result|ConvertTo-Json -Depth 12 -Compress

