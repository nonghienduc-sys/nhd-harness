# Publish only reviewed binary assets from this computer; never upload source or private runtime.
# One-time prerequisites: install GitHub CLI, run "gh auth login", create a public
# assets-only repo with an initial README, set NHD_DISTRIBUTION_REPO=owner/repository.
$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path } else { (Get-Location).Path }
$repo = if ($env:NHD_DISTRIBUTION_REPO) { [string]$env:NHD_DISTRIBUTION_REPO } else { 'nonghienduc-sys/nhd-harness-downloads' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'Set NHD_DISTRIBUTION_REPO to owner/repo (a reviewed public assets-only GitHub repository).'
}
$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
$gh = if ($ghCommand) { $ghCommand.Source } elseif (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe') { 'C:\Program Files\GitHub CLI\gh.exe' } else { $null }
if (-not $gh) { throw 'GitHub CLI is missing. Install via winget install --id GitHub.cli -e, then gh auth login.' }
& $gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub account not authenticated. Run gh auth login on this computer.' }
$metadataJson = & $gh repo view $repo --json nameWithOwner,visibility
if ($LASTEXITCODE -ne 0) { throw 'Cannot access destination GitHub repository; verify GitHub permissions and owner/repo.' }
$metadata = $metadataJson | ConvertFrom-Json
if ($metadata.nameWithOwner -ne $repo -or $metadata.visibility -ne 'PUBLIC') {
  throw 'Destination repository must match the explicit owner/repo and be PUBLIC (binary downloads for friends).'
}
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tag = 'lite-v' + $package.version
$dir = Join-Path $root 'release-lite'
$exe = Join-Path $dir 'NHD-Harness-Lite-Setup.exe'
$checksums = Join-Path $dir 'SHA256SUMS.txt'
$receipt = Join-Path $dir 'release-readiness.json'
foreach ($path in @($exe,$checksums,$receipt)) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing validated release artifact: $path" }
}
$expect = ((Get-Content -LiteralPath $checksums -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expect -notmatch '^[a-f0-9]{64}$' -or $expect -ne $actual) { throw 'Installer SHA-256 does not match SHA256SUMS.txt; refuse to upload.' }
$ready = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ready.installerSha256 -ne $actual -or $ready.testSuite.failed -ne 0 -or !$ready.packagedBackendSmoke.passed -or !$ready.privacyAudit.runtimeMemoryExcluded) {
  throw 'Release readiness receipt is absent, stale or failed; refuse to upload.'
}
# Never overwrite a prior GitHub release, even a partial draft.
$releaseListJson = & $gh release list --repo $repo --limit 100 --json tagName,isDraft
if ($LASTEXITCODE -ne 0) { throw "Cannot read existing releases; refusing blind upload." }
$releaseList = @($releaseListJson | ConvertFrom-Json)
if (@($releaseList | Where-Object { $_.tagName -eq $tag }).Count -gt 0) {
  throw "Release already exists for tag $tag; inspect manually, no duplicate or overwrite."
}
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid') {
  Write-Warning "Installer is unsigned. Upload as DRAFT only; review SmartScreen before publishing."
}
$notes = "NHD Harness Lite $($package.version). Windows NSIS installer. SHA-256 in SHA256SUMS.txt. Optional OCR/semantic modules excluded. Unsigned release candidate: owner must review before publishing."
& $gh release create $tag $exe $checksums --repo $repo --draft --title "NHD Harness Lite $($package.version)" --notes $notes
if ($LASTEXITCODE -ne 0) { throw "GitHub draft release creation failed; inspect repository permissions." }
$release = & $gh release view $tag --repo $repo --json url,isDraft,assets | ConvertFrom-Json
if (!$release.isDraft) { throw "GitHub release is not DRAFT: inspect immediately." }
$installerAsset = @($release.assets | Where-Object { $_.name -eq 'NHD-Harness-Lite-Setup.exe' })
$checksumAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' })
if ($installerAsset.Count -ne 1 -or $checksumAsset.Count -ne 1) { throw "Draft exists but assets are missing; inspect without automatic retry." }
if ($installerAsset[0].size -ne (Get-Item -LiteralPath $exe).Length) { throw "GitHub uploaded installer size mismatch." }
Write-Output ("DRAFT_RELEASE_CREATED="+$release.url)
Write-Output ("DRAFT_ASSETS="+(@($release.assets.name) -join ','))
Write-Output ("LOCAL_SHA256="+$actual)
Write-Output ("AFTER_OWNER_PUBLISH=https://github.com/"+$repo+"/releases/latest/download/NHD-Harness-Lite-Setup.exe")
