<#
.SYNOPSIS
  Installs what a local Windows (x64) build of Drift needs, mirroring the Windows job in
  .github/workflows/package.yml.

.DESCRIPTION
  - Qt 6.10.3 for MSVC 2022 x64 with qtmultimedia and qtimageformats, via aqtinstall, into
    C:\Qt (override with -QtRoot).
  - FFmpeg n7.1 shared, the same pinned CutWire build CI uses, into .deps\ffmpeg.
  - zstd, OpenSSL, SoundTouch (x64-windows) and zlib + Skia (x64-windows-static-md) through a
    vcpkg clone in .\vcpkg. Skia compiles from source the first time (30-60 minutes).

  Every step is skipped when its result is already present, so re-running is cheap.
  Needs Visual Studio 2022 (or its Build Tools) with the C++ workload, git and Python 3.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows-deps.ps1
#>
param(
  [string]$QtRoot = "C:\Qt",
  [string]$QtVersion = "6.10.3",
  [string]$FfmpegTag = "n7.1",
  [switch]$SkipSkia
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# vcpkg and the build must use a Visual Studio that has the C++ tools; with several installed,
# pick the newest one that does rather than whatever vcpkg finds first.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "No Visual Studio with the C++ workload (MSVC x64 tools) found." }
$env:VCPKG_VISUAL_STUDIO_PATH = $vs
Write-Host "Visual Studio: $vs"

# --- Qt ------------------------------------------------------------------------------------------
$qtDir = Join-Path $QtRoot "$QtVersion\msvc2022_64"
Step "Qt $QtVersion -> $qtDir"
if (Test-Path "$qtDir\bin\qmake.exe") {
  Write-Host "already installed"
} else {
  python -m pip install --user --upgrade --quiet aqtinstall
  # aqt writes aqtinstall.log into the current folder; keep it out of the repo.
  Push-Location $env:TEMP
  try {
    python -m aqt install-qt windows desktop $QtVersion win64_msvc2022_64 -m qtmultimedia qtimageformats -O $QtRoot
  } finally {
    Pop-Location
  }
  if (-not (Test-Path "$qtDir\bin\qmake.exe")) { throw "Qt install failed" }
}

# --- FFmpeg --------------------------------------------------------------------------------------
Step "FFmpeg $FfmpegTag -> .deps\ffmpeg"
if (Test-Path ".deps\ffmpeg\lib\avcodec.lib") {
  Write-Host "already present"
} else {
  New-Item -ItemType Directory -Force -Path .deps | Out-Null
  $zip = ".deps\ffmpeg.zip"
  Invoke-WebRequest -Uri "https://github.com/CutWire-Studios/FFmpeg-Builds/releases/download/$FfmpegTag/ffmpeg-$FfmpegTag-win64-gpl-shared.zip" -OutFile $zip
  Remove-Item -Recurse -Force .deps\ffmpeg, .deps\ffmpeg_extracted -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath .deps\ffmpeg_extracted -Force
  $root = (Get-ChildItem .deps\ffmpeg_extracted)[0].FullName
  New-Item -ItemType Directory -Force -Path .deps\ffmpeg | Out-Null
  Copy-Item -Path "$root\*" -Destination .deps\ffmpeg -Recurse -Force
  Remove-Item -Recurse -Force .deps\ffmpeg_extracted, $zip
}

# --- vcpkg ---------------------------------------------------------------------------------------
Step "vcpkg packages"
if (-not (Test-Path "vcpkg\vcpkg.exe")) {
  git clone --depth 1 https://github.com/microsoft/vcpkg.git vcpkg
  & .\vcpkg\bootstrap-vcpkg.bat -disableMetrics
}
& .\vcpkg\vcpkg.exe install zstd openssl soundtouch --triplet x64-windows --disable-metrics
if ($LASTEXITCODE) { throw "vcpkg install (x64-windows) failed" }
# Static-md, as in CI: Skottie needs a static Skia, and Skia's archives link the static zlib.
$static = @("zlib")
if (-not $SkipSkia) { $static += "skia[gl,harfbuzz,icu,freetype,png]" }
& .\vcpkg\vcpkg.exe install @static --triplet x64-windows-static-md --disable-metrics
if ($LASTEXITCODE) { throw "vcpkg install (x64-windows-static-md) failed" }

Step "Done. Build with: powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1"
