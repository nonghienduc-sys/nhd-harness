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
# Functions are sourced from legacy bridge; path mode passes its own $word/$doc.
. $BridgePath -Action '__load_functions_only__' -PayloadBase64 'e30='
$word = $null
$doc = $null
$ownedPid = 0
$started = ''
$identityKnown = $false
$stage = 'preflight'
$stale = $false
$abandoned = $false
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
  $lockPath = @($locks | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1)
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

  # Serialize COM activation only; opening DOCX must NOT hold the mutex. If an owner dies inside WaitOne, Windows
  # releases the named mutex and throws AbandonedMutexException; we now own it.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\NHD.WordLive.Activation.v1')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(20000) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true; $abandoned = $true }
    if (-not $locked) { throw 'WORD_LIVE_START_BUSY: mutex acquisition timed out' }
    $before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
    $stage = 'word_com_activation'
    $word = New-Object -ComObject Word.Application
    $after = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
    $created = @($after | Where-Object { $before -notcontains $_ })
    if ($created.Count -ne 1) {
      # Never Quit an unidentified COM instance: it may belong to the user.
      throw ('WORD_LIVE_SHARED_INSTANCE: ambiguous new WINWORD count=' + $created.Count)
    }
    $ownedPid = [int]$created[0]
    $process = Get-Process -Id $ownedPid -ErrorAction Stop
    if ($process.ProcessName -ne 'WINWORD') { throw 'WORD_LIVE_INVALID_PROCESS_ID' }
    $started = $process.StartTime.ToUniversalTime().ToString('o')
    $identityKnown = $true

    # Emit the PID/start-time before ANY Office properties or Documents.Open can hang.
    # Pool persists this record immediately and owns cleanup on startup failure.
    Emit ([ordered]@{
      kind='owned_process'; pid=$PID; winwordPid=$ownedPid;
      winwordStarted=$started; path=$Path; readOnly=[bool]$ReadOnly
    })
    if ($env:NHD_WORD_LIVE_TEST_HOLD_MUTEX_AFTER_CREATE -eq '1') {
      Emit ([ordered]@{kind='test_mutex_held';pid=$PID;winwordPid=$ownedPid;winwordStarted=$started})
      Start-Sleep -Seconds 35
    }


  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
    $stage = 'word_visible'
    $word.Visible = $false
    $stage = 'word_alerts'
    $word.DisplayAlerts = 0
    $stage = 'word_security'
    $word.AutomationSecurity = 3
    $stage = 'word_normal_template_option'
    $word.Options.SaveNormalPrompt = $false
    # Office may be temporarily unable to create its owner file while other
    # automation instances initialize. Retry OPEN only after proving the prior
    # attempt did not open this document; never replay an edit.
    $stage = 'word_documents_open'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        $doc = $word.Documents.Open($Path, $false, [bool]$ReadOnly, $false)
        break
      } catch {
        $openingError = $_.Exception.Message
        $alreadyOpened = $null
        try {
          foreach ($candidate in $word.Documents) {
            if ([string]::Equals([string]$candidate.FullName, $Path, [StringComparison]::OrdinalIgnoreCase)) {
              $alreadyOpened = $candidate
              break
            }
          }
        } catch {}
        if ($alreadyOpened) { $doc = $alreadyOpened; break }
        if ($attempt -ge 3) { throw ('WORD_LIVE_DOCUMENT_OPEN_FAILED: ' + $openingError) }
        $probeRetry = $null
        try { $probeRetry = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
        catch { throw ('WORD_LIVE_FILE_IN_USE: ' + [IO.Path]::GetFileName($Path)) }
        finally { if ($probeRetry) { $probeRetry.Dispose() } }
        Start-Sleep -Milliseconds (400 * $attempt)
      }
    }
    if (-not $doc) { throw 'WORD_LIVE_DOCUMENT_OPEN_FAILED: no document opened' }
    if (-not $ReadOnly -and $doc.ReadOnly) { throw 'WORD_LIVE_FILE_IN_USE: opened read-only' }
    Start-Sleep -Milliseconds 250

  Emit ([ordered]@{
    kind='ready';worker='word-session';pid=$PID;winwordPid=$ownedPid;
    winwordStarted=$started;path=$Path;readOnly=[bool]$ReadOnly;
    stale_lock=[bool]$stale;abandoned_mutex_recovered=[bool]$abandoned;
    at=(Get-Date).ToUniversalTime().ToString('o')
  })
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
          if ([string]$request.input.operation.type -eq 'word_save') {
            # Word 365 uses a shared user-profile template/cache for file saves.
            # Serialize save only; independent edits continue in parallel.
            $saveMutex = New-Object System.Threading.Mutex($false, 'Local\NHD.WordLive.Save.v1')
            $saveLock = $false
            try {
              try { $saveLock = $saveMutex.WaitOne(25000) }
              catch [System.Threading.AbandonedMutexException] { $saveLock = $true }
              if (-not $saveLock) { throw 'WORD_LIVE_SAVE_BUSY: mutex timed out' }
              $output = Apply-WordOperation $request.input.operation $word $doc
            } finally {
              if ($saveLock) { $saveMutex.ReleaseMutex() }
              $saveMutex.Dispose()
            }
          } else {
            $output = Apply-WordOperation $request.input.operation $word $doc
          }
        }
        'test_timeout' { Start-Sleep -Seconds 35; $output = @{ok=$true} }
        'close' {
          $doc.Close($false); $doc=$null
          $word.Quit(); $word=$null
          Emit ([ordered]@{kind='response';id=$id;ok=$true;result=@{ok=$true;closed=$true}})
          break
        }
        default { throw ('Unsupported Word session action: ' + [string]$request.action) }
      }
      Emit ([ordered]@{kind='response';id=$id;ok=$true;result=$output})
    } catch {
      Emit ([ordered]@{kind='response';id=$id;ok=$false;error=('WORD_LIVE_ACTION '+[string]$request.action+'/'+[string]$request.input.operation.type+': '+$_.Exception.Message)})
    }
  }
} catch {
  Emit ([ordered]@{kind='failure';error=$_.Exception.Message;stage=$stage;position=$_.InvocationInfo.ScriptLineNumber;pid=$PID;winwordPid=$ownedPid;winwordStarted=$started})
} finally {
  # Only close COM when we have confidently identified a newly created PID.
  # An unresponsive Word is stopped by the owner pool using PID + StartTime.
  if ($identityKnown) {
    try { if ($doc) { $doc.Close($false) } } catch {}
    try { if ($word) { $word.Quit() } } catch {}
  }
  try { if ($doc) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) } } catch {}
  try { if ($word) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } } catch {}
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
