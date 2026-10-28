# Install the DSH Data Sync plugin that sits next to this script.
#
# Run it on the new machine after cloning the private snapshot repository:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
#
# It only links the plugin into a profile; restoring the snapshot itself is done
# from Settings -> Data Sync, so the human still reviews every file change.
param(
  [string]$Profile = 'desktop',
  [string]$Source = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $Source 'package.json'))) {
  throw "not a plugin directory (package.json is missing): $Source"
}

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  Write-Host 'The `dsh` command is not on PATH.' -ForegroundColor Yellow
  Write-Host 'Install DeepSeek Harness first, open a new terminal where `dsh --version` works, then run this script again.'
  exit 1
}

Write-Host "Installing plugin from $Source into profile '$Profile' ..."
& $dsh.Source plugin --profile $Profile add $Source
if ($LASTEXITCODE -ne 0) {
  throw "dsh plugin add failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Installed. Next steps:' -ForegroundColor Green
Write-Host '  1. Restart DeepSeek Harness.'
Write-Host '  2. Settings -> Data Sync: paste the repository URL and press Connect.'
Write-Host '  3. Press Check remote, review the plan, then Apply pull.'
