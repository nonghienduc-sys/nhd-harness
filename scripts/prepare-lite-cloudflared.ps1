$ProjectRoot = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path } else { (Get-Location).Path }
$ErrorActionPreference = 'Stop'
$version = '2026.9.1'
$expectedSha256 = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712'
$url = "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-windows-amd64.exe"
$target = Join-Path $ProjectRoot 'runtime\cloudflared.exe'
if (Test-Path -LiteralPath $target) {
  $found = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($found -eq $expectedSha256) {
    Write-Output 'LITE_CLOUDFLARED_ALREADY_VERIFIED'
    exit 0
  }
  throw "Existing cloudflared.exe has unexpected checksum; refusing to overwrite: $target"
}
$stage = Join-Path $ProjectRoot '.lite-stage'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$temp = Join-Path $stage 'cloudflared-windows-amd64.exe'
Invoke-WebRequest -Uri $url -OutFile $temp -UseBasicParsing
$found = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
if ($found -ne $expectedSha256) { throw "Checksum mismatch; expected $expectedSha256, got $found" }
$signature = Get-AuthenticodeSignature -LiteralPath $temp
if ($signature.Status -ne 'Valid') { throw 'Cloudflared binary is not Authenticode-signed correctly' }
New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
Copy-Item -LiteralPath $temp -Destination $target
Write-Output ('LITE_CLOUDFLARED_VERIFIED='+$target)
