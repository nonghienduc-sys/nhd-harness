param(
  [string]$BridgePath,
  [string]$Path,
  [switch]$ReadOnly,
  [switch]$RemoveStaleLock
)
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
function Emit($item) {[Console]::Out.WriteLine(($item|ConvertTo-Json -Compress -Depth 10));[Console]::Out.Flush()}
Emit @{kind='ready';pid=$PID;winwordPid=888888;winwordStarted='2000-01-01T00:00:00.0000000Z';path=$Path;readOnly=[bool]$ReadOnly;stale_lock=$false}
while($true) {
  $line=[Console]::In.ReadLine()
  if($null-eq$line){break}
  try {
    $request=$line|ConvertFrom-Json
    Start-Sleep -Milliseconds 60
    Emit @{kind='response';id=[string]$request.id;ok=$true;result=@{open=$true;verified=$true;path=$Path}}
    if([string]$request.action-eq'close'){break}
  }catch{
    Emit @{kind='response';id=[string]$request.id;ok=$false;error=$_.Exception.Message}
  }
}
