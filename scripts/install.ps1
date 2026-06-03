#Requires -Version 5.1
<#
.SYNOPSIS
    Markus — AI Digital Workforce Platform
    One-line installer: irm https://markus.global/install.ps1 | iex

    If Node.js 22+ is present  → lightweight npm install (~5 MB)
    If Node.js is missing       → downloads standalone binary with bundled runtime (~45 MB)

    Post-install: PATH registration, desktop shortcut, auto-start on login.
#>

$ErrorActionPreference = 'Stop'
$VERSION = 'latest'
$NPM_PACKAGE = '@markus-global/cli'
$GITHUB_REPO = 'markus-global/markus'
$INSTALL_DIR = "$env:LOCALAPPDATA\markus"

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

function Test-NpmInstalled {
    try {
        $npmVer = & npm -v 2>$null
        return [bool]$npmVer
    } catch {
        return $false
    }
}

# ─── Resolve latest version from GitHub (fallback to hub mirror) ──────────────

function Get-LatestVersion {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GITHUB_REPO/releases/latest" -UseBasicParsing -TimeoutSec 10
        return $release.tag_name -replace '^v', ''
    } catch {
        # Fallback to hub API
        try {
            $hubResp = Invoke-RestMethod -Uri "https://markus.global/api/releases/latest" -UseBasicParsing -TimeoutSec 15
            return $hubResp.version
        } catch {
            return $null
        }
    }
}

# ─── npm install path ───────────────────────────────────────────────────────

function Install-ViaNpm {
    param([string]$Package)
    Write-Host "  ⠋  Installing $Package via npm..." -ForegroundColor Cyan -NoNewline
    $logFile = [System.IO.Path]::GetTempFileName()
    try {
        $npmCmd = (Get-Command npm -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $process = Start-Process -FilePath $npmCmd `
            -ArgumentList "install -g --no-audit --no-fund --ignore-optional --loglevel=error $Package" `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
        Write-Host "`r                                                        `r" -NoNewline
        if ($process.ExitCode -ne 0) {
            Write-Err "npm installation failed. Output:"
            Write-Host ''
            if (Test-Path $logFile) { Get-Content $logFile | Write-Host }
            if (Test-Path "$logFile.err") { Get-Content "$logFile.err" | Write-Host }
            Write-Host ''
            Write-Info 'If you see permission errors, try running PowerShell as Administrator.'
            return $false
        }
        Write-Ok "Installed @markus-global/cli via npm"
        return $true
    } catch {
        Write-Host "`r" -NoNewline
        Write-Err "npm installation failed: $_"
        return $false
    } finally {
        Remove-Item $logFile -ErrorAction SilentlyContinue
        Remove-Item "$logFile.err" -ErrorAction SilentlyContinue
    }
}

# ─── Binary install path ────────────────────────────────────────────────────

function Install-ViaBinary {
    Write-Info 'Node.js not found — downloading standalone binary (includes runtime)...'

    $ver = Get-LatestVersion
    if (-not $ver) {
        Write-Err 'Could not determine latest release version.'
        Write-Err 'Check your network connection and try again.'
        return $false
    }
    Write-Info "Latest version: v$ver"

    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x64' }
    $archiveName = "markus-v${ver}-win-${arch}"
    $githubUrl = "https://github.com/$GITHUB_REPO/releases/download/v${ver}/${archiveName}.zip"
    $mirrorUrl = "https://markus.global/releases/${archiveName}.zip"

    $tmpDir = Join-Path $env:TEMP "markus-download-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $zipPath = Join-Path $tmpDir "${archiveName}.zip"

    Write-Info "Downloading ${archiveName}.zip..."
    $downloaded = $false
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $githubUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 60
        $downloaded = $true
    } catch {
        Write-Warn "GitHub download failed or timed out, trying mirror..."
        try {
            Invoke-WebRequest -Uri $mirrorUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
            $downloaded = $true
        } catch {
            Write-Err "Download failed from both GitHub and mirror."
            Write-Err "Binary for win-${arch} may not be available yet for v${ver}."
            Remove-Item $tmpDir -Recurse -ErrorAction SilentlyContinue
            return $false
        }
    }
    Write-Ok "Downloaded ${archiveName}.zip"

    Write-Info "Extracting to $INSTALL_DIR..."
    if (Test-Path $INSTALL_DIR) {
        Remove-Item $INSTALL_DIR -Recurse -Force
    }
    Expand-Archive -Path $zipPath -DestinationPath $env:TEMP -Force
    Move-Item -Path (Join-Path $env:TEMP $archiveName) -Destination $INSTALL_DIR -Force
    Write-Ok "Extracted to $INSTALL_DIR"

    Remove-Item $tmpDir -Recurse -ErrorAction SilentlyContinue
    return $true
}

# ─── Post-install: PATH registration ────────────────────────────────────────

function Set-UserPath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and $userPath.Contains($INSTALL_DIR)) {
        Write-Ok "PATH already contains $INSTALL_DIR"
        return
    }
    $newPath = if ($userPath) { "$INSTALL_DIR;$userPath" } else { $INSTALL_DIR }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$INSTALL_DIR;$env:Path"
    Write-Ok "Added to PATH (takes effect in new terminal sessions)"
}

# ─── Post-install: Desktop shortcut ─────────────────────────────────────────

function New-DesktopShortcut {
    param([string]$MarkusCmd, [string]$InstallMode)
    try {
        # Create a launcher script that checks if the server is already running
        $launcherDir = Join-Path $env:LOCALAPPDATA 'markus'
        if (-not (Test-Path $launcherDir)) { New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null }
        $launcherPath = Join-Path $launcherDir 'markus-launch.cmd'

        if ($InstallMode -eq 'binary') {
            $markusCmdPath = Join-Path $INSTALL_DIR 'markus.cmd'
        } else {
            $markusCmdPath = $MarkusCmd
        }

        @"
@echo off
setlocal
set PORT=8056
powershell -NoProfile -Command "try { `$r = Invoke-WebRequest -Uri 'http://localhost:%PORT%/api/health' -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop; exit 0 } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:%PORT%"
    exit /b 0
)
"$markusCmdPath" start
"@ | Set-Content -Path $launcherPath -Encoding ASCII

        $WshShell = New-Object -ComObject WScript.Shell
        $desktopPath = [Environment]::GetFolderPath('Desktop')
        $lnkPath = Join-Path $desktopPath 'Markus.lnk'
        $shortcut = $WshShell.CreateShortcut($lnkPath)

        $shortcut.TargetPath = $launcherPath
        $shortcut.WorkingDirectory = $env:USERPROFILE
        $shortcut.Description = 'Markus - AI Digital Workforce Platform'

        $icoPath = Join-Path $INSTALL_DIR 'markus.ico'
        if (Test-Path $icoPath) {
            $shortcut.IconLocation = "$icoPath,0"
        }

        $shortcut.Save()
        Write-Ok 'Desktop shortcut created: Markus'
    } catch {
        Write-Warn "Could not create desktop shortcut: $_"
    }
}

# ─── Post-install: Auto-start on login ──────────────────────────────────────

function Set-AutoStart {
    param([string]$InstallMode)
    try {
        $WshShell = New-Object -ComObject WScript.Shell
        $startupPath = [Environment]::GetFolderPath('Startup')
        $lnkPath = Join-Path $startupPath 'Markus.lnk'
        $shortcut = $WshShell.CreateShortcut($lnkPath)

        if ($InstallMode -eq 'binary') {
            $shortcut.TargetPath = Join-Path $INSTALL_DIR 'markus.cmd'
        } else {
            $npmGlobalBin = & npm prefix -g 2>$null
            $markusPath = Join-Path $npmGlobalBin 'markus.cmd'
            if (Test-Path $markusPath) {
                $shortcut.TargetPath = $markusPath
            } else {
                $shortcut.TargetPath = 'npx'
                $shortcut.Arguments = '@markus-global/cli start'
                $shortcut.Save()
                Write-Ok 'Auto-start on login: enabled'
                return
            }
        }
        $shortcut.Arguments = 'start'
        $shortcut.WorkingDirectory = $env:USERPROFILE
        $shortcut.WindowStyle = 7  # minimized
        $shortcut.Description = 'Markus - AI Digital Workforce Platform (auto-start)'
        $shortcut.Save()
        Write-Ok 'Auto-start on login: enabled'
    } catch {
        Write-Warn "Could not set up auto-start: $_"
    }
}

# ─── Main ────────────────────────────────────────────────────────────────────

function Main {
    Show-Banner

    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
    Write-Info "Detected: windows / $arch"

    # ── Choose install path ──────────────────────────────────────────────
    $installMode = 'npm'
    $markusCmd = 'markus'

    Write-Info 'Checking Node.js...'
    $node = Test-NodeInstalled
    if ($node.Installed -and $node.Major -ge 22) {
        Write-Ok "Node.js $($node.Version)"
        if (Test-NpmInstalled) {
            $npmVer = & npm -v 2>$null
            Write-Ok "npm $npmVer"
            Write-Host ''
            $pkg = "$NPM_PACKAGE@$VERSION"
            if (-not (Install-ViaNpm -Package $pkg)) {
                return
            }
        } else {
            Write-Warn 'npm not found — falling back to binary install'
            $installMode = 'binary'
        }
    } else {
        if ($node.Installed) {
            Write-Warn "Node.js $($node.Version) is too old (22+ required) — using standalone binary"
        } else {
            Write-Info 'Node.js not found — using standalone binary (includes runtime)'
        }
        $installMode = 'binary'
    }

    if ($installMode -eq 'binary') {
        Write-Host ''
        if (-not (Install-ViaBinary)) {
            return
        }
        Set-UserPath
        $markusCmd = Join-Path $INSTALL_DIR 'markus.cmd'
    }

    Write-Host ''

    # ── Verify installation ──────────────────────────────────────────────
    if ($installMode -eq 'npm') {
        $markusFound = $false
        try { $null = Get-Command markus -ErrorAction Stop; $markusFound = $true } catch {}
        if ($markusFound) {
            $ver = try { & markus --version 2>$null } catch { 'installed' }
            Write-Ok "markus $ver"
        } else {
            Write-Warn 'markus command not found in PATH. Use npx instead:'
            Write-Host '    npx @markus-global/cli start' -ForegroundColor White
            $markusCmd = 'npx @markus-global/cli'
        }
    } else {
        Write-Ok "markus installed at $INSTALL_DIR"
    }

    # ── Desktop shortcut ─────────────────────────────────────────────────
    New-DesktopShortcut -MarkusCmd $markusCmd -InstallMode $installMode

    # ── Auto-start on login ──────────────────────────────────────────────
    Write-Host ''
    $enableAutostart = 'Y'
    if ([Environment]::UserInteractive) {
        try {
            $enableAutostart = Read-Host '  Enable auto-start on login? [Y/n]'
            if ([string]::IsNullOrWhiteSpace($enableAutostart)) { $enableAutostart = 'Y' }
        } catch {
            $enableAutostart = 'Y'
        }
    }

    if ($enableAutostart -notmatch '^[nN]') {
        Set-AutoStart -InstallMode $installMode
    } else {
        Write-Info 'Auto-start skipped'
    }

    # ── Run init wizard ──────────────────────────────────────────────────
    Write-Host ''
    Write-Info 'Running setup wizard...'
    Write-Host ''
    try {
        if ($installMode -eq 'binary') {
            & $markusCmd init 2>$null
        } elseif ($markusCmd -eq 'markus') {
            & markus init 2>$null
        } else {
            & npx @markus-global/cli init 2>$null
        }
    } catch {}

    # ── Success banner ───────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ┌─────────────────────────────────────┐' -ForegroundColor Green
    Write-Host '  │     Installation Complete!          │' -ForegroundColor Green
    Write-Host '  └─────────────────────────────────────┘' -ForegroundColor Green
    Write-Host ''
    Write-Host '  Quick start:'
    Write-Host ''

    if ($installMode -eq 'binary') {
        Write-Host '    markus start          ' -ForegroundColor White -NoNewline; Write-Host 'Launch the platform'
        Write-Host '    markus agent list     ' -ForegroundColor White -NoNewline; Write-Host 'List your agents'
        Write-Host '    markus --help         ' -ForegroundColor White -NoNewline; Write-Host 'Show all commands'
        Write-Host ''
        Write-Host '  (restart your terminal for PATH changes to take effect)' -ForegroundColor DarkGray
    } else {
        $found = $false
        try { $null = Get-Command markus -ErrorAction Stop; $found = $true } catch {}
        if ($found) {
            Write-Host '    markus start          ' -ForegroundColor White -NoNewline; Write-Host 'Launch the platform'
            Write-Host '    markus agent list     ' -ForegroundColor White -NoNewline; Write-Host 'List your agents'
            Write-Host '    markus --help         ' -ForegroundColor White -NoNewline; Write-Host 'Show all commands'
        } else {
            Write-Host '    npx @markus-global/cli start          ' -ForegroundColor White -NoNewline; Write-Host 'Launch the platform'
            Write-Host '    npx @markus-global/cli agent list     ' -ForegroundColor White -NoNewline; Write-Host 'List your agents'
            Write-Host '    npx @markus-global/cli --help         ' -ForegroundColor White -NoNewline; Write-Host 'Show all commands'
        }
    }

    Write-Host ''
    Write-Host '  Upgrade:    irm https://markus.global/install.ps1 | iex' -ForegroundColor DarkGray
    Write-Host '  Uninstall:  markus uninstall' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Documentation:  https://github.com/markus-global/markus'
    Write-Host ''
}

Main
