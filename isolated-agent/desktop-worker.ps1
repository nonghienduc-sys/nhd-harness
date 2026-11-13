param(
  [Parameter(Mandatory=$true)][string]$ExchangeRoot
)
$ErrorActionPreference='Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NhdIsoPersistentUser32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,UIntPtr dwExtraInfo);
  public const uint LEFTDOWN=0x0002;
  public const uint LEFTUP=0x0004;
}
'@

$script:WorkerVersion='0.1.0'
$script:SelectorTtlMs=300000
$script:SelectorCache=@{}
$script:WindowCache=@{}

function Emit-Json([object]$value){
  $json=$value|ConvertTo-Json -Depth 16 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
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
    foreach($v in $vals){if([double]::IsNaN($v)-or[double]::IsInfinity($v)){return $null}}
    return [ordered]@{x=$vals[0];y=$vals[1];width=$vals[2];height=$vals[3]}
  }catch{return $null}
}
function Top-Windows {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond))
}
function Refresh-Windows {
  $seen=@{}
  foreach($w in Top-Windows){
    try{
      $id=[string][int64]$w.Current.NativeWindowHandle
      if(-not $id -or $id -eq '0'){continue}
      $seen[$id]=$w
    }catch{}
  }
  $script:WindowCache=$seen
  return $seen
}
function Window-ById([string]$id){
  if(-not $id){throw 'windowId is required.'}
  $cached=$script:WindowCache[$id]
  if($null-ne$cached){
    try{if([string][int64]$cached.Current.NativeWindowHandle -eq $id){return $cached}}catch{}
  }
  $null=Refresh-Windows
  $w=$script:WindowCache[$id]
  if($null-ne$w){return $w}
  throw "Isolated window not found: $id"
}
function Prune-Selectors {
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach($key in @($script:SelectorCache.Keys)){
    $item=$script:SelectorCache[$key]
    if($null-eq$item -or [int64]$item.expiresAt -lt $now){$script:SelectorCache.Remove($key)}
  }
}
function New-Selector($el,[string]$windowId){
  Prune-Selectors
  $id='iso-uia-'+[guid]::NewGuid().ToString('N')
  $script:SelectorCache[$id]=[pscustomobject]@{
    element=$el
    windowId=$windowId
    processId=[int]$el.Current.ProcessId
    expiresAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$script:SelectorTtlMs
  }
  return $id
}
function Resolve-Control([string]$selectorId,[string]$windowId){
  Prune-Selectors
  if(-not $selectorId.StartsWith('iso-uia-')){throw 'Invalid isolated selector.'}
  $item=$script:SelectorCache[$selectorId]
  if($null-eq$item){throw 'Isolated selector expired; inspect again.'}
  if($windowId -and [string]$item.windowId -ne $windowId){throw 'Isolated selector belongs to another window.'}
  $el=$item.element
  try{
    $pid=[int]$el.Current.ProcessId
    if($pid -ne [int]$item.processId){throw 'selector stale'}
    $item.expiresAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$script:SelectorTtlMs
    return $el
  }catch{throw 'Isolated selector is stale; inspect again.'}
}
function Inspect-Control($el,[string]$windowId){
  return [ordered]@{
    selectorId=New-Selector $el $windowId
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
  $map=@{'ESCAPE'='{ESC}';'TAB'='{TAB}';'SHIFT_TAB'='+{TAB}';'UP'='{UP}';'DOWN'='{DOWN}';'LEFT'='{LEFT}';'RIGHT'='{RIGHT}';'PAGE_UP'='{PGUP}';'PAGE_DOWN'='{PGDN}';'HOME'='{HOME}';'END'='{END}';'ENTER'='{ENTER}';'SPACE'=' '}
  if(-not $map.ContainsKey($key)){throw "Unsupported isolated desktop key: $key"}
  [System.Windows.Forms.SendKeys]::SendWait($map[$key])
}
function Handle-Request([string]$Action,$payload){
  switch($Action){
    'ping' {return [ordered]@{ok=$true;workerVersion=$script:WorkerVersion;pid=$PID;selectorCache=$script:SelectorCache.Count;windowCache=$script:WindowCache.Count}}
    'list' {
      $windows=@();$map=Refresh-Windows
      foreach($id in $map.Keys){$w=$map[$id];try{$windows += [ordered]@{windowId=$id;title=Safe $w.Current.Name 500;processId=[int]$w.Current.ProcessId;className=Safe $w.Current.ClassName 300;offscreen=[bool]$w.Current.IsOffscreen;bounds=Bounds $w}}catch{}}
      return [ordered]@{windows=$windows;count=$windows.Count;worker=[ordered]@{persistent=$true;pid=$PID;version=$script:WorkerVersion;selectorCache=$script:SelectorCache.Count}}
    }
    'inspect' {
      $windowId=Safe $payload.windowId 128;$query=(Safe $payload.query 500).ToLowerInvariant();$limitRaw=300;if($null-ne$payload.limit){$limitRaw=[int]$payload.limit};$limit=[Math]::Max(20,[Math]::Min($limitRaw,1000))
      $w=Window-ById $windowId;$all=@($w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition));$controls=@()
      foreach($el in $all){if($controls.Count-ge$limit){break};try{$name=Safe $el.Current.Name 500;$aid=Safe $el.Current.AutomationId 300;$cls=Safe $el.Current.ClassName 300;$type=ControlTypeName $el;$hay=("$name $aid $cls $type").ToLowerInvariant();if($query-and-not$hay.Contains($query)){continue};$controls += Inspect-Control $el $windowId}catch{}}
      return [ordered]@{windowId=$windowId;controls=$controls;returned=$controls.Count;truncated=$all.Count-gt$controls.Count;worker=[ordered]@{persistent=$true;pid=$PID;version=$script:WorkerVersion;selectorCache=$script:SelectorCache.Count}}
    }
    'action' {
      $kind=Safe $payload.action 40;$windowId=Safe $payload.windowId 128;$w=if($windowId){Window-ById $windowId}else{$null}
      if($w){[void][NhdIsoPersistentUser32]::SetForegroundWindow([IntPtr][int64]$w.Current.NativeWindowHandle);Start-Sleep -Milliseconds 60}
      if($kind-eq'invoke'){$el=Resolve-Control (Safe $payload.selectorId 256) $windowId;if(-not$el.Current.IsEnabled){throw 'Isolated control is disabled.'};$pat=$null;if(-not$el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pat)){throw 'Control does not support InvokePattern.'};([System.Windows.Automation.InvokePattern]$pat).Invoke();return [ordered]@{ok=$true;action='invoke';workerPid=$PID}}
      elseif($kind-eq'set_text'){$el=Resolve-Control (Safe $payload.selectorId 256) $windowId;if($el.Current.IsPassword){throw 'Password controls are blocked.'};$desc=("$($el.Current.Name) $($el.Current.AutomationId) $($el.Current.ClassName)");if($desc-match'(?i)password|passcode|otp|cvv|cvc|card|bank|routing|secret|token'){throw 'Sensitive field is blocked.'};$pat=$null;if(-not$el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pat)){throw 'Control does not support ValuePattern.'};$text=[string]$payload.text;if($text.Length-gt 2000){$text=$text.Substring(0,2000)};([System.Windows.Automation.ValuePattern]$pat).SetValue($text);return [ordered]@{ok=$true;action='set_text';characters=$text.Length;workerPid=$PID}}
      elseif($kind-eq'press_key'){Press-Key ((Safe $payload.key 40).ToUpperInvariant());return [ordered]@{ok=$true;action='press_key';key=(Safe $payload.key 40);workerPid=$PID}}
      elseif($kind-eq'click_point'){if(-not$w){throw 'windowId is required for click_point.'};$r=$w.Current.BoundingRectangle;$xr=[Math]::Max(0,[Math]::Min(1,[double]$payload.xRatio));$yr=[Math]::Max(0,[Math]::Min(1,[double]$payload.yRatio));$x=[int]($r.X+$r.Width*$xr);$y=[int]($r.Y+$r.Height*$yr);[void][NhdIsoPersistentUser32]::SetCursorPos($x,$y);Start-Sleep -Milliseconds 40;[NhdIsoPersistentUser32]::mouse_event([NhdIsoPersistentUser32]::LEFTDOWN,0,0,0,[UIntPtr]::Zero);[NhdIsoPersistentUser32]::mouse_event([NhdIsoPersistentUser32]::LEFTUP,0,0,0,[UIntPtr]::Zero);return [ordered]@{ok=$true;action='click_point';x=$x;y=$y;workerPid=$PID}}
      else{throw "Unsupported isolated desktop action: $kind"}
    }
    'screenshot' {
      $screen=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$bmp=New-Object System.Drawing.Bitmap($screen.Width,$screen.Height);$g=[System.Drawing.Graphics]::FromImage($bmp)
      try{$g.CopyFromScreen($screen.Location,[System.Drawing.Point]::Empty,$screen.Size);$name=('desktop-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.png');$dir=Join-Path $ExchangeRoot 'screenshots';New-Item -ItemType Directory -Force -Path $dir|Out-Null;$path=Join-Path $dir $name;$bmp.Save($path,[System.Drawing.Imaging.ImageFormat]::Png);return [ordered]@{ok=$true;mimeType='image/png';relativePath=('screenshots\'+$name);width=$screen.Width;height=$screen.Height;workerPid=$PID}}
      finally{$g.Dispose();$bmp.Dispose()}
    }
    default {throw "Unsupported persistent desktop worker action: $Action"}
  }
}

Emit-Json ([ordered]@{kind='ready';version=$script:WorkerVersion;pid=$PID;at=(Get-Date).ToUniversalTime().ToString('o')})
while($true){
  $line=[Console]::In.ReadLine()
  if($null-eq$line){break}
  if([string]::IsNullOrWhiteSpace($line)){continue}
  $sw=[Diagnostics.Stopwatch]::StartNew();$id=''
  try{
    $req=$line|ConvertFrom-Json;$id=Safe $req.id 128;$action=Safe $req.action 40
    if(-not$id-or-not$action){throw 'Invalid desktop worker request envelope.'}
    $payload=if($null-ne$req.payload){$req.payload}else{[pscustomobject]@{}}
    $result=Handle-Request $action $payload;$sw.Stop();Emit-Json ([ordered]@{kind='response';id=$id;ok=$true;result=$result;elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,3)})
  }catch{
    $sw.Stop();Emit-Json ([ordered]@{kind='response';id=$id;ok=$false;error=(Safe $_.Exception.Message 3000);elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,3)})
  }
}
