# Install the DSH Data Sync plugin that sits next to this script.
#
# Run it on the new machine after cloning the private snapshot repository:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
#
# It does the two things pnpm alone does not:
#   1. adds the package to the profile (dsh plugin add forwards to pnpm)
#   2. registers the bundle in the profile's dsh.profile.bundles list
# Restoring the snapshot itself stays in Settings -> Data Sync, so the human
# still reviews every file change.
param(
  [string]$Profile = 'desktop',
  [string]$Source = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$bundleId = '@local/dsh-data-sync'

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

# Register the bundle, otherwise the package is installed but never loaded.
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileFile = Join-Path $dshHome "profiles/$Profile/package.json"
if (Test-Path $profileFile) {
  $json = Get-Content $profileFile -Raw | ConvertFrom-Json
  if (-not $json.PSObject.Properties['dsh']) {
    $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $json.dsh.PSObject.Properties['profile']) {
    $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $json.dsh.profile.PSObject.Properties['bundles']) {
    $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
  }
  $bundles = @($json.dsh.profile.bundles)
  if ($bundles -notcontains $bundleId) {
    $bundles += $bundleId
    $json.dsh.profile.bundles = $bundles
    $json | ConvertTo-Json -Depth 20 | Set-Content $profileFile -Encoding utf8
    Write-Host "Registered $bundleId in $profileFile"
  } else {
    Write-Host "$bundleId is already registered in $profileFile"
  }
} else {
  Write-Host "Profile file not found: $profileFile" -ForegroundColor Yellow
  Write-Host "Add `"$bundleId`" to dsh.profile.bundles by hand, then restart DeepSeek Harness."
}

Write-Host ''
Write-Host 'Installed. Next steps:' -ForegroundColor Green
Write-Host '  1. Restart DeepSeek Harness.'
Write-Host '  2. Settings -> Data Sync: paste the repository URL and press Connect.'
Write-Host '  3. Press Check remote, review the plan, then Apply pull.'
