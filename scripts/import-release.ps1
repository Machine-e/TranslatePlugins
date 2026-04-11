param(
  [string]$ReleaseZip = "releases/stream-translate-page-latest.zip",
  [string]$DestinationRoot = "releases/unpacked"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$zipPath = Join-Path $repoRoot $ReleaseZip

if (-not (Test-Path $zipPath)) {
  throw "Release zip not found: $zipPath"
}

$zipFile = Get-Item -LiteralPath $zipPath
$releaseName = [System.IO.Path]::GetFileNameWithoutExtension($zipFile.Name)
$destinationDir = Join-Path (Join-Path $repoRoot $DestinationRoot) $releaseName

if (Test-Path $destinationDir) {
  Remove-Item -LiteralPath $destinationDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
Expand-Archive -LiteralPath $zipPath -DestinationPath $destinationDir -Force

Set-Clipboard -Value $destinationDir
Start-Process explorer.exe $destinationDir
Start-Process "chrome://extensions"

Write-Output "Release unpacked to:"
Write-Output "  $destinationDir"
Write-Output ""
Write-Output "The unpacked folder path has been copied to your clipboard."
Write-Output "Chrome extensions page has been opened."
Write-Output "Next step: click 'Load unpacked' and paste the copied path."
