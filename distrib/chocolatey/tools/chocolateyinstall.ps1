$ErrorActionPreference = 'Stop'

$url      = 'https://github.com/PaRr0tBoY/Trace/releases/download/v2026.8.15/Trace-Setup-2026.8.15.exe'
$checksum = '2FCAA90AF26A4389C0B236D80D3023D357BA6A81DF9BFCBFCD1D21418065B9CA'

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
