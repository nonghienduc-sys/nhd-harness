param(
  [Parameter(Mandatory=$true)][string]$BridgePath,
  [Parameter(Mandatory=$true)][string]$Path,
  [switch]$ReadOnly,
  [switch]$RemoveStaleLock
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
function Emit($message) {
  [Console]::Out.WriteLine(($message | ConvertTo-Json -Depth 14 -Compress))
  [Console]::Out.Flush()
}
# Import the same Word inspection, formatting and editing functions as legacy Word Live.
. $BridgePath -Action '__load_functions_only__' -PayloadBase64 'e30='
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NhdWordPid {
 [DllImport("user32.dll", SetLastError=true)]
 public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$word = $null
$doc = $null
$ownedPid = 0
$started = ''
try {
  $Path = [IO.Path]::GetFullPath($Path)
  if (-not [IO.Path]::IsPathRooted($Path) -or [IO.Path]::GetExtension($Path).ToLowerInvariant() -ne '.docx' -or -not [IO.File]::Exists($Path)) {
    throw 'WORD_LIVE_INVALID_PATH: absolute existing .docx required'
  }
  $prefix = [IO.Path]::GetFileName($Path)
  $dir = [IO.Path]::GetDirectoryName($Path)
  $locks = @()
  if ($prefix.Length -gt 2) { $locks += [IO.Path]::Combine($dir, ('~$' + $prefix.Substring(2))) }
  $locks += [IO.Path]::Combine($dir, ('~$' + $prefix))
  $lockPath = @($locks | Where-Object {[IO.File]::Exists($_)} | Select-Object -First 1)
  # Word owner files may be stale; never delete one without explicit opt-in.
  $owner = ''
  if ($lockPath.Count -gt 0) {
    try {
      $bytes = [IO.File]::ReadAllBytes($lockPath[0])
      $owner = ([Text.Encoding]::Unicode.GetString($bytes) -replace '[^\p{L}\p{N} ._-]', '').Trim()
      if ($owner.Length -gt 80) { $owner = $owner.Substring(0,80) }
    } catch {}
  }
  $probe = $null
  try { $probe = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
  catch { throw ('WORD_LIVE_FILE_IN_USE: ' + [IO.Path]::GetFileName($Path) + ' owner=' + $owner) }
  finally { if ($probe) { $probe.Dispose() } }
  $stale = $lockPath.Count -gt 0
  if ($stale -and $RemoveStaleLock) {
    try { [IO.File]::Delete($lockPath[0]); $stale = $false }
    catch { throw ('WORD_LIVE_STALE_LOCK_REMOVE_FAILED: ' + $_.Exception.Message) }
  }
  # Hidden Office has no reliable HWND. Serialize the entire application
  # activation + initial Documents.Open phase; per-file editing remains parallel.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\NHD.WordLive.Activation.v1')
  $locked = $false
  try {
    $locked = $mutex.WaitOne(60000)
    if (-not $locked) { throw 'WORD_LIVE_START_BUSY: timed out waiting for Office activation/open gate' }
    $before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
    $word = New-Object -ComObject Word.Application
    $after = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
    $created = @($after | Where-Object { $before -notcontains $_ })
    if ($created.Count -ne 1) {
      # Do not quit or manipulate a COM instance whose PID was not confidently identified.
      throw 'WORD_LIVE_SHARED_INSTANCE: COM activation did not create one isolated WINWORD'
    }
    $ownedPid = [int]$created[0]
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $word.Options.SaveNormalPrompt = $false
    $doc = $word.Documents.Open($Path, $false, [bool]$ReadOnly, $false)
    if (-not $ReadOnly -and $doc.ReadOnly) { throw 'WORD_LIVE_FILE_IN_USE: Word opened document read-only' }
    $started = (Get-Process -Id $ownedPid -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  Emit ([ordered]@{kind='ready';worker='word-session';pid=$PID;winwordPid=$ownedPid;winwordStarted=$started;path=$Path;readOnly=[bool]$ReadOnly;stale_lock=[bool]$stale;at=(Get-Date).ToUniversalTime().ToString('o')})
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = ''
    try {
      $request = $line | ConvertFrom-Json
      $id = [string]$request.id
      switch ([string]$request.action) {
        'word_inspect' { $output = Get-WordInspect $request.input $word $doc }
        'word_apply' {
          if ($ReadOnly) { throw 'WORD_LIVE_READ_ONLY: writes and saves prohibited' }
          $output = Apply-WordOperation $request.input.operation $word $doc
        }
        'test_timeout' { Start-Sleep -Seconds 30; $output = @{ok=$true} }
        'close' {
          $doc.Close($false); $doc=$null
          $word.Quit(); $word=$null
          $output=@{ok=$true;closed=$true}
          Emit ([ordered]@{kind='response';id=$id;ok=$true;result=$output})
          break
        }
        default { throw ('Unsupported Word session action: ' + [string]$request.action) }
      }
      Emit ([ordered]@{kind='response';id=$id;ok=$true;result=$output})
      if ([string]$request.action -eq 'close') { break }
    } catch {
      Emit ([ordered]@{kind='response';id=$id;ok=$false;error=$_.Exception.Message})
    }
  }
} catch {
  Emit ([ordered]@{kind='failure';error=$_.Exception.Message;pid=$PID;winwordPid=$ownedPid})
} finally {
  try { if ($doc) { $doc.Close($false) } } catch {}
  try { if ($word -and $ownedPid -gt 0) { $word.Quit() } } catch {}
  try { if ($doc) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) } } catch {}
  try { if ($word) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } } catch {}
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
