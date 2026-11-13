$ProjectRoot = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path } else { (Get-Location).Path }
$ErrorActionPreference = 'Stop'
$folder = Join-Path $ProjectRoot 'release-lite'
$stable = Join-Path $folder 'NHD-Harness-Lite-Setup.exe'
$versioned = Get-ChildItem -LiteralPath $folder -File -Filter 'NHD-Harness-Lite-*.exe' |
  Where-Object { $_.Name -match '^NHD-Harness-Lite-[0-9]+\.[0-9]+\.[0-9]+\.exe$' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($versioned) {
  $sourceHash = (Get-FileHash -LiteralPath $versioned.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $stableHash = if (Test-Path -LiteralPath $stable) { (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
  if ($sourceHash -ne $stableHash) {
    if ($stableHash) {
      Copy-Item -LiteralPath $stable -Destination (Join-Path $folder 'NHD-Harness-Lite-Setup.previous.exe') -Force
    }
    Copy-Item -LiteralPath $versioned.FullName -Destination $stable -Force
    $writtenHash = (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $writtenHash) { throw 'Stable installer failed SHA-256 verification after copy' }
    Write-Output 'STABLE_INSTALLER_REFRESHED=true'
  }
}
if (!(Test-Path -LiteralPath $stable -PathType Leaf)) { throw 'No Lite setup installer found' }
$hash = (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  NHD-Harness-Lite-Setup.exe" | Set-Content -LiteralPath (Join-Path $folder 'SHA256SUMS.txt') -Encoding ascii
Write-Output ('RELEASE_SETUP='+$stable)
Write-Output ('SHA256='+$hash)
