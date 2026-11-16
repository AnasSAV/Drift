<#
.SYNOPSIS
  Configures and builds Drift on Windows (x64) with MSVC + Ninja, using what
  scripts\setup-windows-deps.ps1 installed. Mirrors the Windows job in package.yml.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1                 # RelWithDebInfo
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Config Release
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Target drift   # just the app

  Then run build-relwithdebinfo\drift.exe (build\ for -Config Debug, build-release\ for Release).
#>
param(
  # RelWithDebInfo by default: full-speed playback with symbols. Debug is slow for video and
  # mixes CRTs with vcpkg's static release libraries.
  [ValidateSet("Debug", "Release", "RelWithDebInfo")][string]$Config = "RelWithDebInfo",
  [string]$QtDir = "C:\Qt\6.10.3\msvc2022_64",
  [string]$Target = "",
  [int]$Jobs = 0,
  [switch]$NoSkia,
  [switch]$Reconfigure,
  # Extra CMake cache settings applied to the build directory before building,
  # e.g. -CMakeArgs "-DDRIFT_QML_PREVIEWS=ON"
  [string[]]$CMakeArgs = @()
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$build = if ($Config -eq "Debug") { "build" } else { "build-" + $Config.ToLower() }

# --- MSVC environment ------------------------------------------------------------------------------
# Ninja needs the compiler environment that a Developer prompt sets up; import vcvars64 into this
# PowerShell session unless cl.exe is already on PATH.
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw "No Visual Studio with the C++ workload found." }
  $vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
  cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
  # Visual Studio bundles CMake and Ninja; make sure they are reachable.
  $bundled = Join-Path $vs "Common7\IDE\CommonExtensions\Microsoft\CMake"
  $env:PATH = "$bundled\CMake\bin;$bundled\Ninja;$env:PATH"
}

$vcpkg = Join-Path $repo "vcpkg"
$static = Join-Path $vcpkg "installed\x64-windows-static-md"
if (-not (Test-Path "$QtDir\bin\qmake.exe")) { throw "Qt not found at $QtDir. Run scripts\setup-windows-deps.ps1 first." }
if (-not (Test-Path "$vcpkg\vcpkg.exe")) { throw "vcpkg not found. Run scripts\setup-windows-deps.ps1 first." }

# --- configure -------------------------------------------------------------------------------------
if ($Reconfigure -or -not (Test-Path "$build\CMakeCache.txt")) {
  $skia = if ($NoSkia -or -not (Test-Path "$static\share\skia")) { "OFF" } else { "ON" }
  # zlib's static library is zs.lib up to 1.3.x and libzs.lib (libzsd.lib for debug) from 1.4.
  # CI's FindZLIB knows neither, so it is handed by path, matching the build type's CRT.
  $zlibNames = if ($Config -eq "Debug") { @("debug\lib\libzsd.lib", "debug\lib\zsd.lib") } else { @() }
  $zlibNames += @("lib\libzs.lib", "lib\zs.lib")
  $zlib = $zlibNames | ForEach-Object { Join-Path $static $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $zlib) { throw "No static zlib in $static. Run scripts\setup-windows-deps.ps1." }
  if ($skia -eq "OFF") { Write-Warning "Building without Skia: text, shapes, Lottie and SVG clips will draw nothing." }
  cmake -B $build -G Ninja `
    "-DCMAKE_BUILD_TYPE=$Config" `
    "-DCMAKE_TOOLCHAIN_FILE=$vcpkg\scripts\buildsystems\vcpkg.cmake" `
    "-DCMAKE_PREFIX_PATH=$QtDir;$repo\.deps\ffmpeg;$static" `
    "-DFETCHCONTENT_BASE_DIR=$repo\.deps" `
    "-DZLIB_INCLUDE_DIR=$static\include" `
    "-DZLIB_LIBRARY=$zlib" `
    "-DDRIFT_WITH_SKIA=$skia" `
    "-DDRIFT_BUNDLE_ONNXRUNTIME=OFF" `
    "-DDRIFT_QML_CACHEGEN=OFF"
  if ($LASTEXITCODE) { throw "configure failed" }
}

if ($CMakeArgs.Count -gt 0) {
  cmake -B $build @CMakeArgs
  if ($LASTEXITCODE) { throw "configure failed" }
}

# --- build -----------------------------------------------------------------------------------------
# Leave headroom: a few of Drift's translation units need several GB of compiler heap each.
if ($Jobs -le 0) { $Jobs = [Math]::Max(2, [Math]::Floor([Environment]::ProcessorCount / 2)) }
$cmakeArgs = @("--build", $build, "--parallel", $Jobs)
if ($Target) { $cmakeArgs += @("--target", $Target) }
cmake @cmakeArgs
if ($LASTEXITCODE) { throw "build failed" }

# Qt's own DLLs and plugins next to drift.exe, so it starts without Qt on PATH.
if (-not $Target -or $Target -eq "drift") {
  $exe = Join-Path $build "drift.exe"
  if (Test-Path $exe) {
    & "$QtDir\bin\windeployqt.exe" --no-translations --qmldir "$repo\src\qml" $exe | Out-Null
    Copy-Item "$repo\.deps\ffmpeg\bin\*.dll" $build -Force
    Copy-Item "$vcpkg\installed\x64-windows\bin\*.dll" $build -Force
    Write-Host "`nBuilt $exe" -ForegroundColor Green
  }
}
