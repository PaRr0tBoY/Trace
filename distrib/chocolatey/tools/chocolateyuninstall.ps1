$ErrorActionPreference = 'Stop'

$uninstallKey = Get-UninstallRegistryKey -SoftwareName 'Trace*'
if ($null -eq $uninstallKey) {
  Write-Warning 'Trace is not installed (no uninstall registry entry found).'
  return
}

$uninstallString = $uninstallKey.UninstallString -replace '"', ''

$packageArgs = @{
  packageName    = 'trace'
  fileType       = 'exe'
  silentArgs     = '/S'
  file           = $uninstallString
  validExitCodes = @(0)
}

Uninstall-ChocolateyPackage @packageArgs
