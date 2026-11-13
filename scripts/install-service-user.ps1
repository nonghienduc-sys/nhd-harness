$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$parts = $identity.Split('\', 2)
$secure = Read-Host "Windows password for $identity" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:WORKSTATION_SERVICE_DOMAIN = $parts[0]
  $env:WORKSTATION_SERVICE_ACCOUNT = $parts[1]
  $env:WORKSTATION_SERVICE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  node "$root\scripts\install-service.cjs"
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:WORKSTATION_SERVICE_PASSWORD -ErrorAction SilentlyContinue
}
