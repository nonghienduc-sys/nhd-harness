$ProjectRoot = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path } else { (Get-Location).Path }
$ErrorActionPreference = 'Stop'
$version = '3.12.10'
$sha256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
$url = "https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip"
$cache = Join-Path $ProjectRoot '.lite-stage'
$target = Join-Path $ProjectRoot 'runtime\python-embed'
New-Item -Path $cache -ItemType Directory -Force | Out-Null
$zip = Join-Path $cache "python-$version-embed-amd64.zip"
if (!(Test-Path -LiteralPath $zip)) {
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}
$found = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($found -ne $sha256) { throw "Embedded Python checksum mismatch; expected $sha256, got $found" }
New-Item -Path $target -ItemType Directory -Force | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $target -Force
$python = Join-Path $target 'python.exe'
& $python --version
if ($LASTEXITCODE -ne 0) { throw 'Embedded Python self-test failed' }
Write-Output ("LITE_PYTHON_READY=" + $python)
