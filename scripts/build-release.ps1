param(
  [string]$OutputDir = "releases"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "manifest.json"

if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found."
}

$manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Manifest version is missing."
}

$releaseName = "stream-translate-page-v$version"
$outputRoot = Join-Path $repoRoot $OutputDir
$tempRoot = Join-Path $outputRoot ".tmp"
$stageDir = Join-Path $tempRoot $releaseName
$zipPath = Join-Path $outputRoot "$releaseName.zip"
$latestZipPath = Join-Path $outputRoot "stream-translate-page-latest.zip"

$includePaths = @(
  "manifest.json",
  "options.css",
  "options.html",
  "options.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "README.md",
  "README.zh-CN.md",
  "src"
)

function Remove-IfExists {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Assert-NoSecrets {
  param([string]$Root)

  $dangerPatterns = @(
    "sk-[A-Za-z0-9_\-]{12,}",
    '"apiKey"\s*:\s*"(?!")[^"]{6,}"'
  )

  $files = Get-ChildItem -Path $Root -Recurse -File
  foreach ($file in $files) {
    $content = Get-Content -Path $file.FullName -Raw
    foreach ($pattern in $dangerPatterns) {
      if ($content -match $pattern) {
        throw "Potential secret detected in staged release file: $($file.FullName)"
      }
    }
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
Remove-IfExists -Path $stageDir
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

foreach ($relativePath in $includePaths) {
  $sourcePath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path $sourcePath)) {
    throw "Missing release input: $relativePath"
  }

  $destinationPath = Join-Path $stageDir $relativePath
  $destinationParent = Split-Path -Parent $destinationPath
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  Copy-Item -Path $sourcePath -Destination $destinationPath -Recurse -Force
}

Assert-NoSecrets -Root $stageDir

Remove-IfExists -Path $zipPath
Remove-IfExists -Path $latestZipPath

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Copy-Item -LiteralPath $zipPath -Destination $latestZipPath -Force

Write-Output "Created:"
Write-Output "  $zipPath"
Write-Output "  $latestZipPath"
