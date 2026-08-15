$ErrorActionPreference = 'Stop'

$url      = 'https://github.com/PaRr0tBoY/Trace/releases/download/v2026.8.16/Trace-Setup-2026.8.16.exe'
$checksum = '1461C0AC057A67150188AE710E8A5C789020A7C9A853B983BDFEC35851BB64D2'

$packageArgs = @{
  packageName    = 'trace'
  fileType       = 'exe'
  url            = $url
  url64bit       = $url
  checksum       = $checksum
  checksum64     = $checksum
  checksumType   = 'sha256'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
