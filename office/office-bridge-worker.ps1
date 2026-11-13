param([Parameter(Mandatory=$true)][string]$BridgePath)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
function Emit($o){[Console]::Out.WriteLine(($o|ConvertTo-Json -Depth 12 -Compress));[Console]::Out.Flush()}
Emit ([ordered]@{kind='ready';worker='office';pid=$PID;version='1.0.0';at=(Get-Date).ToUniversalTime().ToString('o')})
while($true){
  $line=[Console]::In.ReadLine();if($null-eq$line){break};if([string]::IsNullOrWhiteSpace($line)){continue}
  $id='';$sw=[Diagnostics.Stopwatch]::StartNew()
  try{
    $req=$line|ConvertFrom-Json;$id=[string]$req.id;$action=[string]$req.action;$payloadJson=([string]$req.payloadJson)
    if(-not$id-or-not$action){throw 'Invalid Office worker request.'}
    $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson))
    $raw=@(& $BridgePath -Action $action -PayloadBase64 $payload 2>&1)
    if(-not$raw.Count){throw 'Office bridge returned no response.'}
    $text=($raw|ForEach-Object{[string]$_}) -join "`n"
    $json=$text|ConvertFrom-Json
    $sw.Stop();Emit ([ordered]@{kind='response';id=$id;ok=$true;result=$json;elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,3);pid=$PID})
  }catch{
    $sw.Stop();Emit ([ordered]@{kind='response';id=$id;ok=$false;error=$_.Exception.Message;elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,3);pid=$PID})
  }
}
