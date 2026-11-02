<#
.SYNOPSIS
  dsh-browser-bridge installer for Windows.

.DESCRIPTION
  Registers this plugin into a dsh profile (default: desktop) and prepares a
  Python venv with playwright at %USERPROFILE%\.dsh\browser-bridge\venv.

  Three registrations are performed automatically:
    1. <profile>\node_modules\dsh-browser-bridge  -> junction to this plugin dir
    2. <profile>\package.json                     -> dependencies + dsh.profile.bundles
    3. <plugin>\node_modules\@deepseek-ai\{cosmokit,dsh-tools,schemastery}
                                                  -> junction to dsh shared layer

  Junctions are used instead of symlinks on purpose: directory junctions do NOT
  require Administrator rights or Developer Mode on Windows.

  All output is ASCII on purpose - PowerShell 5.1 reads BOM-less .ps1 files with
  the system ANSI code page, so non-ASCII literals would garble on some hosts.

.PARAMETER Profile
  Target dsh profile name. Default: desktop

.PARAMETER Python
  Path to a python.exe that already has playwright. When omitted the script
  probes %USERPROFILE%\.dsh\browser-bridge\venv, then creates it if missing.

.PARAMETER Check
  Read-only. Inspects the current state and exits 0 (ready) or 1 (needs install).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Check
#>
[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$Python = "",
    [switch]$Check
)

$ErrorActionPreference = "Stop"

$PluginName    = "dsh-browser-bridge"
$PluginDir     = (Get-Item $PSScriptRoot).FullName
$DshProfiles   = if ($env:DSH_PROFILES) { $env:DSH_PROFILES } else { Join-Path $env:USERPROFILE ".dsh\profiles" }
$SharedModules = Join-Path $env:USERPROFILE ".dsh\profiles\node_modules"
$BridgeHome    = Join-Path $env:USERPROFILE ".dsh\browser-bridge"
$DefaultVenvPy = Join-Path $BridgeHome "venv\Scripts\python.exe"

function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[install] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[install] $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# Python probing
# ---------------------------------------------------------------------------
function Test-Playwright([string]$py) {
    if (-not $py) { return $false }
    if (-not (Test-Path -LiteralPath $py)) { return $false }
    try {
        & $py -c "import playwright" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Resolve-BridgePython {
    if ($Python) {
        if (-not (Test-Path -LiteralPath $Python)) {
            Fail "specified python not found: $Python"
        }
        if (-not (Test-Playwright $Python)) {
            Fail "specified python has no playwright: $Python  (run: <venv>\Scripts\pip install playwright)"
        }
        return $Python
    }
    if (Test-Playwright $DefaultVenvPy) { return $DefaultVenvPy }

    $legacy = @(
        (Join-Path $env:USERPROFILE ".aiconfig\venv\Scripts\python.exe")
    )
    foreach ($c in $legacy) {
        if (Test-Playwright $c) { return $c }
    }
    return $null
}

function Find-SystemPython {
    $cands = New-Object System.Collections.ArrayList
    foreach ($name in @("python", "python3")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { [void]$cands.Add($cmd.Source) }
    }
    foreach ($c in $cands) {
        try {
            & $c -c "import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return $c }
        } catch {
            # Windows Store alias stub throws when launched non-interactively - skip it
        }
    }
    return $null
}

function Install-PlaywrightVenv {
    $sysPy = Find-SystemPython
    if (-not $sysPy) {
        Warn "no Python 3.9+ found on PATH"
        Warn "install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH')"
        return $false
    }
    Info "creating venv with: $sysPy"
    New-Item -ItemType Directory -Force -Path $BridgeHome | Out-Null

    if (-not (Test-Path -LiteralPath $DefaultVenvPy)) {
        & $sysPy -m venv (Join-Path $BridgeHome "venv")
        if ($LASTEXITCODE -ne 0) {
            Warn "venv creation failed: $(Join-Path $BridgeHome 'venv')"
            return $false
        }
        Ok "venv created: $(Join-Path $BridgeHome 'venv')"
    } else {
        Info "reusing existing venv: $(Join-Path $BridgeHome 'venv')"
    }

    Info "installing playwright (first run: 1-2 minutes)..."
    & $DefaultVenvPy -m pip install --disable-pip-version-check -q playwright
    if ($LASTEXITCODE -ne 0) {
        Warn "pip install failed. Behind a corporate proxy / slow network, run:"
        Warn "  `$env:PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple'"
        Warn "then re-run this script."
        return $false
    }
    Ok "playwright installed"
    return $true
}

# ---------------------------------------------------------------------------
# Chrome detection (only needed by the managed channel; builtin works without)
# ---------------------------------------------------------------------------
function Test-Chrome {
    $paths = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
    foreach ($p in $paths) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Junction helper (no admin needed, unlike New-Item -ItemType SymbolicLink)
# ---------------------------------------------------------------------------
function Set-DirJunction([string]$link, [string]$target) {
    $parent = Split-Path -Parent $link
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -eq "Junction") {
            $current = @($item.Target) | Select-Object -First 1
            if ($current -and ((Resolve-Path -LiteralPath $current -ErrorAction SilentlyContinue).Path -eq (Resolve-Path -LiteralPath $target).Path)) {
                return $false   # already correct
            }
        }
        # IMPORTANT: never use Remove-Item -Recurse on a junction. PowerShell 5.1
        # has followed reparse points in some builds and deleted the TARGET tree.
        # `rmdir` removes only the link itself.
        & cmd /c rmdir "$link" | Out-Null
        if (Test-Path -LiteralPath $link) {
            throw "could not remove existing junction: $link"
        }
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    return $true
}

# ---------------------------------------------------------------------------
# package.json merge via node (dsh ships node, so it is always available)
# ---------------------------------------------------------------------------
function Merge-ProfilePackageJson([string]$pkgJson, [string]$linkTarget) {
    $js = @'
const fs = require("fs");
const p = process.argv[2], link = process.argv[3], name = process.argv[4];
let j = {};
if (fs.existsSync(p)) {
  try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { j = {}; }
}
j.name = j.name || "dsh-profile";
j.private = true;
j.dependencies = j.dependencies || {};
j.dependencies[name] = "link:" + link.replace(/\\/g, "/");
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = j.dsh.profile.bundles || [];
if (!j.dsh.profile.bundles.includes(name)) { j.dsh.profile.bundles.push(name); }
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
'@
    $tmp = Join-Path $env:TEMP ("dsh-bridge-merge-" + [guid]::NewGuid().ToString("N") + ".js")
    Set-Content -LiteralPath $tmp -Value $js -Encoding ASCII
    try {
        & node $tmp $pkgJson $linkTarget $PluginName
        if ($LASTEXITCODE -ne 0) { throw "node exited with $LASTEXITCODE" }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Write-Host ""
Info "dsh-browser-bridge install (plugin dir: $PluginDir)"
Info "dsh profiles root: $DshProfiles"

# 1. python
$py = Resolve-BridgePython
if (-not $py) {
    if ($Check) {
        Warn "no playwright venv found (--Check never writes anything)"
        Write-Host ""
        Write-Host "result: NOT ready (missing venv; run install.ps1 without -Check)"
        exit 1
    }
    Info "no playwright venv found, preparing one..."
    if (-not (Install-PlaywrightVenv)) {
        Fail "could not prepare the venv. Pass -Python <path-to-venv-python.exe> to reuse an existing one."
    }
    $py = $DefaultVenvPy
    if (-not (Test-Playwright $py)) {
        Fail "venv exists but playwright still not importable: $py"
    }
}
Ok "venv python: $py"

# 2. chrome (soft check)
if (Test-Chrome) {
    Ok "system Chrome: found (managed channel available)"
} else {
    Warn "Chrome not found - builtin (in-app panel) is unaffected, but target=managed would fail"
    Warn "install Google Chrome if you need the managed channel"
}

# 3. peer junctions
$incomplete = $false
foreach ($pkg in @("cosmokit", "dsh-tools", "schemastery")) {
    $src = Join-Path $SharedModules "@deepseek-ai\$pkg"
    $dst = Join-Path $PluginDir "node_modules\@deepseek-ai\$pkg"
    if (-not (Test-Path -LiteralPath $src)) {
        Warn "shared layer missing @deepseek-ai/$pkg ($src) - is dsh installed?"
        $incomplete = $true
        continue
    }
    if ($Check) {
        $okLink = $false
        if (Test-Path -LiteralPath $dst) {
            $item = Get-Item -LiteralPath $dst -Force
            if ($item.LinkType -eq "Junction") { $okLink = $true }
        }
        if (-not $okLink) { Warn "peer junction missing or wrong: $pkg"; $incomplete = $true }
        continue
    }
    if (Set-DirJunction $dst $src) { Ok "peer junction: @deepseek-ai/$pkg" }
}

# 4. profile registration
$profileDir = Join-Path $DshProfiles $Profile
$pkgJson    = Join-Path $profileDir "package.json"
$patchYml   = Join-Path $profileDir "cordis.patch.yml"
$nodeModulesDir = Join-Path $profileDir "node_modules"

if (-not (Test-Path -LiteralPath $profileDir)) {
    Warn "profile '$Profile' not found: $profileDir"
    Warn "start the DSH desktop app once (it creates the profile), then re-run"
    $incomplete = $true
} else {
    Info "target profile: $Profile"
    $linkPath = Join-Path $nodeModulesDir $PluginName

    if ($Check) {
        $okLink = $false
        if (Test-Path -LiteralPath $linkPath) {
            $item = Get-Item -LiteralPath $linkPath -Force
            if ($item.LinkType -eq "Junction") { $okLink = $true }
        }
        if (-not $okLink) { Warn "node_modules junction missing or wrong"; $incomplete = $true }

        if (Test-Path -LiteralPath $pkgJson) {
            $j = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
            $hasDep = $j.dependencies -and $j.dependencies.$PluginName
            $hasBun = $j.dsh -and $j.dsh.profile -and ($j.dsh.profile.bundles -contains $PluginName)
            if (-not ($hasDep -and $hasBun)) { Warn "package.json missing registration (dependencies or bundles)"; $incomplete = $true }
        } else {
            Warn "profile has no package.json: $pkgJson"
            $incomplete = $true
        }
    } else {
        if (Set-DirJunction $linkPath $PluginDir) { Ok "node_modules junction: $linkPath" }
        else { Ok "node_modules junction already correct: $linkPath" }

        Merge-ProfilePackageJson $pkgJson $PluginDir
        Ok "package.json: dependencies + bundles registered"

        # cordis.patch.yml override, only when the detected python differs from
        # the plugin default (which is exactly $DefaultVenvPy)
        $needBlock = ($py -ne $DefaultVenvPy)
        $hasBlock = $false
        if (Test-Path -LiteralPath $patchYml) {
            $hasBlock = [bool](Select-String -LiteralPath $patchYml -Pattern '^- id: browser-bridge' -Quiet)
        }
        if (-not $needBlock) {
            Ok "cordis.patch.yml: no override needed (plugin default pythonBin == detected venv)"
        } elseif ($hasBlock) {
            if (Select-String -LiteralPath $patchYml -Pattern ([regex]::Escape("pythonBin: " + ($py -replace '\\', '/'))) -Quiet) {
                Ok "cordis.patch.yml: browser-bridge block already has pythonBin"
            } else {
                Warn "cordis.patch.yml already has a browser-bridge block but pythonBin != $py"
                Warn "edit it manually (see README config section)"
                $incomplete = $true
            }
        } else {
            $yamlPy = $py -replace '\\', '/'
            $block = @"

# -- dsh-browser-bridge (install.ps1) --
- id: browser-bridge
  name: dsh-browser-bridge
  config:
    pythonBin: $yamlPy
    defaultTarget: builtin
"@
            Add-Content -LiteralPath $patchYml -Value $block -Encoding UTF8
            Ok "cordis.patch.yml: browser-bridge block appended (pythonBin=$yamlPy)"
        }
    }
}

# 5. verdict
if ($Check) {
    Write-Host ""
    if ($incomplete) {
        Write-Host "result: NOT ready (see warnings above)"
        exit 1
    }
    Write-Host "result: ready ($Profile profile)"
    exit 0
}

Write-Host ""
if ($incomplete) {
    Warn "registration written, but something above was skipped -> the plugin will NOT load yet"
    Write-Host ""
    Write-Host "Most common cause: dsh desktop app not installed, or never started"
    Write-Host "  (missing shared layer: $SharedModules)"
    Write-Host "Fix: start the dsh desktop app once, then re-run this script (idempotent)."
    Write-Host ""
    Write-Host "Uninstall: delete the junctions above, the two package.json entries,"
    Write-Host "           and the cordis.patch.yml block."
    exit 2
}

Ok "install complete"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart the DSH desktop app (plain restart, no flags needed)"
Write-Host "  2. Open a NEW session (tool schemas are snapshotted per session)"
Write-Host "  3. Self-check: ask the model to run browser_emulate(list=true) - 46 devices = OK"
Write-Host ""
Write-Host "Uninstall: delete the junctions above, the two package.json entries,"
Write-Host "           and the cordis.patch.yml block."
