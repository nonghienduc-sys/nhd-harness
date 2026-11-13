$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
function Emit($o){[Console]::Out.WriteLine(($o|ConvertTo-Json -Depth 12 -Compress));[Console]::Out.Flush()}
Emit ([ordered]@{kind='ready';worker='powershell';pid=$PID;version='1.0.0';at=(Get-Date).ToUniversalTime().ToString('o')})
while($true){
  $line=[Console]::In.ReadLine(); if($null-eq$line){break}; if([string]::IsNullOrWhiteSpace($line)){continue}
  $sw=[Diagnostics.Stopwatch]::StartNew();$id=''
  try{
    $req=$line|ConvertFrom-Json;$id=[string]$req.id;$cwd=[string]$req.cwd;$command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$req.commandBase64))
    if(-not$id -or -not$cwd -or -not$command){throw 'Invalid worker request.'}
    $old=(Get-Location).Path; $nativeCode=0
    try{
      Set-Location -LiteralPath $cwd
      $global:LASTEXITCODE=0
      $output=& ([ScriptBlock]::Create($command)) *>&1 | Out-String -Width 4096
      $nativeCode=if($null-ne$global:LASTEXITCODE){[int]$global:LASTEXITCODE}else{0}
    } finally {Set-Location -LiteralPath $old}
    $sw.Stop();Emit ([ordered]@{kind='response';id=$id;ok=$true;code=$nativeCode;stdout=[string]$output;stderr='';elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,3);pid=$PID})
  }catch{
    $sw.Stop();Emit ([ordered]@{kind='response';id=$id;ok=$false;code=1;stdout='';stderr=$_.Exception.Message;elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,3);pid=$PID})
  }
}
