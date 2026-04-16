#Requires -Version 5.1
<#
.SYNOPSIS
    Markus — AI Digital Workforce Platform
    One-line installer: irm https://markus.global/install.ps1 | iex
#>

$ErrorActionPreference = 'Stop'
$VERSION = 'latest'
$NPM_PACKAGE = '@markus-global/cli'

# ─── Colors ──────────────────────────────────────────────────────────────────

function Write-Info    { param([string]$Msg) Write-Host "  [info]  $Msg" -ForegroundColor Blue }
function Write-Ok      { param([string]$Msg) Write-Host "  [ok]    $Msg" -ForegroundColor Green }
function Write-Warn    { param([string]$Msg) Write-Host "  [warn]  $Msg" -ForegroundColor Yellow }
function Write-Err     { param([string]$Msg) Write-Host "  [error] $Msg" -ForegroundColor Red }

# ─── Banner ──────────────────────────────────────────────────────────────────

function Show-Banner {
    Write-Host ''
    Write-Host '  ┌─────────────────────────────────────┐' -ForegroundColor Cyan
    Write-Host '  │         Markus Installer            │' -ForegroundColor Cyan
    Write-Host '  │   AI Digital Workforce Platform     │' -ForegroundColor Cyan
    Write-Host '  └─────────────────────────────────────┘' -ForegroundColor Cyan
    Write-Host ''
}

# ─── Dependency checks ──────────────────────────────────────────────────────

function Test-NodeInstalled {
    try {
        $nodeVer = & node -v 2>$null
        if (-not $nodeVer) { return @{ Installed = $false } }
        $major = [int]($nodeVer -replace '^v','').Split('.')[0]
        return @{ Installed = $true; Version = $nodeVer; Major = $major }
    } catch {
        return @{ Installed = $false }
    }
}

function Show-NodeGuidance {
    Write-Err 'Node.js 22+ is required but not found.'
    Write-Host ''
    Write-Info 'Install Node.js using one of these methods:'
    Write-Host ''
    Write-Host '    Option 1: winget (recommended)' -ForegroundColor White
    Write-Host '      winget install OpenJS.NodeJS.LTS'
    Write-Host ''
    Write-Host '    Option 2: nvm-windows' -ForegroundColor White
    Write-Host '      https://github.com/coreybutler/nvm-windows/releases'
    Write-Host '      nvm install 22'
    Write-Host '      nvm use 22'
    Write-Host ''
    Write-Host '    Option 3: Official installer' -ForegroundColor White
    Write-Host '      https://nodejs.org/en/download'
    Write-Host ''
    Write-Info 'After installing Node.js, re-run this installer.'
}

function Test-NpmInstalled {
    try {
        $npmVer = & npm -v 2>$null
        return [bool]$npmVer
    } catch {
        return $false
    }
}

# ─── npm install ─────────────────────────────────────────────────────────────

function Install-MarkusCli {
    param([string]$Package)
    Write-Host "  ⠋  Installing $Package..." -ForegroundColor Cyan -NoNewline
    $logFile = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath 'npm' `
            -ArgumentList "install -g --no-audit --no-fund --ignore-optional --loglevel=error $Package" `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
        Write-Host "`r" -NoNewline
        Write-Host '                                                        ' -NoNewline
        Write-Host "`r" -NoNewline
        if ($process.ExitCode -ne 0) {
            Write-Err "Installation failed. Output:"
            Write-Host ''
            if (Test-Path $logFile) { Get-Content $logFile | Write-Host }
            if (Test-Path "$logFile.err") { Get-Content "$logFile.err" | Write-Host }
            Write-Host ''
            Write-Info 'If you see permission errors, try running PowerShell as Administrator.'
            Write-Host ''
            return $false
        }
        Write-Ok "Installed @markus-global/cli"
        return $true
    } catch {
        Write-Host "`r" -NoNewline
        Write-Err "Installation failed: $_"
        return $false
    } finally {
        Remove-Item $logFile -ErrorAction SilentlyContinue
        Remove-Item "$logFile.err" -ErrorAction SilentlyContinue
    }
}

# ─── Main ────────────────────────────────────────────────────────────────────

function Main {
    Show-Banner

    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
    Write-Info "Detected: windows / $arch"

    # Step 1: Check Node.js
    Write-Info 'Checking Node.js...'
    $node = Test-NodeInstalled
    if (-not $node.Installed) {
        Show-NodeGuidance
        return
    }
    if ($node.Major -lt 22) {
        Write-Err "Node.js $($node.Version) is too old. Version 22+ is required."
        Write-Host ''
        Show-NodeGuidance
        return
    }
    Write-Ok "Node.js $($node.Version)"

    # Step 2: Check npm
    if (-not (Test-NpmInstalled)) {
        Write-Err 'npm is required but not found (should come with Node.js).'
        return
    }
    $npmVer = & npm -v 2>$null
    Write-Ok "npm $npmVer"

    # Step 3: Install @markus-global/cli
    Write-Host ''
    $pkg = "$NPM_PACKAGE@$VERSION"
    if (-not (Install-MarkusCli -Package $pkg)) {
        return
    }

    Write-Host ''

    # Step 4: Verify installation
    $markusCmd = 'markus'
    $markusFound = $false
    try {
        $null = & markus --version 2>$null
        $markusFound = $true
    } catch {}

    if (-not $markusFound) {
        try {
            $null = Get-Command markus -ErrorAction Stop
            $markusFound = $true
        } catch {}
    }

    if ($markusFound) {
        $ver = try { & markus --version 2>$null } catch { 'installed' }
        Write-Ok "markus $ver"
    } else {
        Write-Warn 'markus command not found in PATH.'
        Write-Info 'npm global bin may not be in PATH. Use npx instead:'
        Write-Host ''
        Write-Host '    npx @markus-global/cli start' -ForegroundColor White
        Write-Host ''
        $markusCmd = 'npx @markus-global/cli'
    }

    # Step 5: Run init
    Write-Info 'Running setup wizard...'
    Write-Host ''
    try {
        if ($markusFound) {
            & markus init 2>$null
        } else {
            & npx @markus-global/cli init 2>$null
        }
    } catch {}

    Write-Host ''
    Write-Host '  ┌─────────────────────────────────────┐' -ForegroundColor Green
    Write-Host '  │     Installation Complete!          │' -ForegroundColor Green
    Write-Host '  └─────────────────────────────────────┘' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Quick start:'
    Write-Host ''
    if ($markusFound) {
        Write-Host '    markus start          ' -ForegroundColor White -NoNewline; Write-Host 'Launch the platform'
        Write-Host '    markus agent list     ' -ForegroundColor White -NoNewline; Write-Host 'List your agents'
        Write-Host '    markus --help         ' -ForegroundColor White -NoNewline; Write-Host 'Show all commands'
    } else {
        Write-Host '    npx @markus-global/cli start          ' -ForegroundColor White -NoNewline; Write-Host 'Launch the platform'
        Write-Host '    npx @markus-global/cli agent list     ' -ForegroundColor White -NoNewline; Write-Host 'List your agents'
        Write-Host '    npx @markus-global/cli --help         ' -ForegroundColor White -NoNewline; Write-Host 'Show all commands'
    }
    Write-Host ''
    Write-Host '  Upgrade or run without global install:' -ForegroundColor DarkGray
    Write-Host '    npx @markus-global/cli@latest start' -ForegroundColor White
    Write-Host ''
    Write-Host '  Documentation:  https://github.com/markus-global/markus'
    Write-Host ''
}

Main
