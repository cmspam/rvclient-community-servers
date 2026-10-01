# ============================================================================
#  Uninstall-RVServer.ps1 - removes a server set up with Setup-RVServer.ps1.
#
#  First asks whether to KEEP the server installed:
#    keep   - servers stopped, auto-start removed, files kept (run setup again to use it again)
#    remove - everything setup added: servers, auto-start, firewall rules, desktop shortcut and
#             the install folder
#  Either way your OWN game install (the one you play with) is checked and put back to normal:
#  setup links your big game files instead of copying them, and nothing of the server may stay
#  in, or be shared with, your game folder.
#
#    -Mode Keep|All     answer the question up front (the launcher's Remove does this)
#    -NoUnregister      the backend registration was already removed (launcher Remove)
#    -InstallDir <dir>  default: where setup put it (C:\RVServer)
#    -GameDir <dir>     your game install, if setup's record / rVclient.ini point elsewhere
# ============================================================================
param(
    [ValidateSet('', 'Keep', 'All')][string]$Mode = '',
    [string]$InstallDir = '', [string]$GameDir = '',
    [switch]$NoUnregister, [switch]$Unattended, [switch]$SkipSystemChanges
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SkipSystemChanges) {
    Write-Host 'Asking for administrator rights (needed for the firewall rules and auto-start)...'
    $pass = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    foreach ($k in $PSBoundParameters.Keys) {
        $v = $PSBoundParameters[$k]
        if ($v -is [switch]) { if ($v) { $pass += "-$k" } } else { $pass += "-$k"; $pass += "`"$v`"" }
    }
    try { Start-Process powershell.exe -Verb RunAs -ArgumentList $pass } catch { Write-Host 'Administrator rights were refused - nothing was changed.' -ForegroundColor Red; Read-Host 'Press Enter to close' }
    exit
}
Set-Location $env:TEMP   # never inside the folder that may be deleted
$Marker = Join-Path $env:ProgramData 'RVServer\install.json'
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Info($t) { Write-Host "   $t" }
function Warn($t) { Write-Host "   $t" -ForegroundColor Yellow }
function Done($code) { Write-Host ''; if (-not $Unattended) { Read-Host 'Press Enter to close' }; exit $code }
function ReadJson($p) { try { return (Get-Content -Raw -LiteralPath $p) -replace '^\uFEFF', '' | ConvertFrom-Json } catch { return $null } }

# ---- where is it --------------------------------------------------------------------------
$info = if (Test-Path $Marker) { ReadJson $Marker } else { $null }
if (-not $InstallDir) { $InstallDir = if ($info -and $info.installDir) { $info.installDir } else { 'C:\RVServer' } }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$Server = Join-Path $InstallDir 'server'
$Win64 = Join-Path $Server 'Rumbleverse\Binaries\Win64'
$Sup = Join-Path $Win64 'RVSupervisor'
$state = ReadJson (Join-Path $InstallDir 'setup-state.json')
if (-not (Test-Path $Server) -and -not $state) { Write-Host "No server installed in $InstallDir." -ForegroundColor Yellow; Done 1 }

# Your game install: recorded by setup, else the one your rVclient launcher uses.
$Game = if ($GameDir) { $GameDir } elseif ($info -and $info.gameSource -and $info.installDir -eq $InstallDir) { $info.gameSource } else { $null }
if (-not $Game) {
    foreach ($ini in @("$env:USERPROFILE\rVclient\rVclient.ini", "$env:LOCALAPPDATA\RVClient\rVclient.ini")) {
        if ($Game -or -not (Test-Path $ini)) { continue }
        $line = Select-String -LiteralPath $ini -Pattern '^\s*GameExe\s*=\s*(.+?)\s*$' | Select-Object -First 1
        if ($line) { $p = $line.Matches[0].Groups[1].Value; if (Test-Path $p) { $Game = (Resolve-Path (Join-Path (Split-Path $p) '..\..\..')).Path } }
    }
}
$sameFolder = $Game -and ([IO.Path]::GetFullPath($Game).TrimEnd('\') -eq $Server.TrimEnd('\') -or
    [IO.Path]::GetFullPath($Game).TrimEnd('\').StartsWith($InstallDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $InstallDir.TrimEnd('\').StartsWith([IO.Path]::GetFullPath($Game).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))

Write-Host ''
Write-Host '  Rumbleverse server - remove' -ForegroundColor Green
Write-Host "  Server folder: $Server"
if ($Game) { Write-Host "  Your game:     $Game" }
if (-not $Mode) {
    Write-Host ''
    Write-Host '   Keep the server installed? Its files stay (no download next time you set it up), it is'
    Write-Host '   stopped and no longer starts by itself. Your game is put back to normal either way.'
    $a = Read-Host '   Keep it installed? (y/N)'
    $Mode = if ($a -match '^\s*y') { 'Keep' } else { 'All' }
}
if ($Mode -eq 'All' -and $sameFolder) {
    Warn 'The server folder and your game folder overlap - the folder is NOT deleted (only the server parts are removed).'
}
Info $(if ($Mode -eq 'Keep') { 'Keeping the server files.' } else { 'Removing everything setup installed.' })

# ---- 1. stop -------------------------------------------------------------------------------
Step 'Stopping the server'
$inst = ReadJson (Join-Path $Sup 'ds-instances.json')
if ($inst) {
    $port = if ($inst.adminPort) { $inst.adminPort } else { 9988 }
    try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/shutdown" -Headers @{ 'x-admin-token' = "$($inst.adminToken)" } -TimeoutSec 10 | Out-Null; Start-Sleep 3 } catch { }
}
$under = { param($p) $p -and $p.StartsWith($Server, [StringComparison]::OrdinalIgnoreCase) }
foreach ($pr in @(Get-Process RumbleverseClient-Win64-Shipping, RVModes -ErrorAction SilentlyContinue)) {
    try { if (& $under $pr.Path) { $pr.Kill(); $pr.WaitForExit(5000) | Out-Null; Info "stopped $($pr.ProcessName) ($($pr.Id))" } } catch { }
}
# The supervisor / node agent (node.exe running scripts from this server's RVSupervisor folder).
foreach ($pr in @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue)) {
    if ($pr.CommandLine -and $pr.CommandLine.IndexOf($Win64, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        try { Stop-Process -Id $pr.ProcessId -Force -ErrorAction Stop; Info "stopped $($pr.Name) ($($pr.ProcessId))" } catch { }
    }
}
$task = 'Rumbleverse Server Supervisor'
if ($SkipSystemChanges) { Info 'Auto-start left alone (-SkipSystemChanges).' }
elseif (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    $t = Get-ScheduledTask -TaskName $task
    if (($t.Actions | ForEach-Object { "$($_.Arguments) $($_.WorkingDirectory)" }) -join ' ' -like "*$Win64*") {
        Unregister-ScheduledTask -TaskName $task -Confirm:$false; Info 'Auto-start removed.'
    } else { Info "Auto-start '$task' belongs to another server folder - left alone." }
}

# A server file that is really one of your game's files: a hard link (setup, same drive) with a
# name inside your game folder, or a symbolic link (setup, another drive) pointing into it.
# Returns that game file's size, else -1.
function SharedWithGame($path, $gameRoot) {
    try {
        $it = Get-Item -LiteralPath $path -Force
        if ($it.LinkType -eq 'SymbolicLink') {
            $t = @($it.Target)[0]
            if ($t -and -not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path $path) $t }
            if ($t -and [IO.Path]::GetFullPath($t).StartsWith($gameRoot, [StringComparison]::OrdinalIgnoreCase)) {
                return (Get-Item -LiteralPath $t -Force).Length
            }
        } elseif ($it.LinkType -eq 'HardLink') {
            $vol = [IO.Path]::GetPathRoot($path)
            if (@(& fsutil hardlink list $path 2>$null | Where-Object { (Join-Path $vol $_.TrimStart('\')).StartsWith($gameRoot, [StringComparison]::OrdinalIgnoreCase) }).Count) { return $it.Length }
        }
    } catch { }
    return -1
}

# ---- 2. your game back to normal ----------------------------------------------------------
Step 'Your game'
$fixed = 0; $broken = @()
if (-not $Game -or -not (Test-Path $Game)) { Info 'Your game install was not found - nothing to check there.' }
elseif ($sameFolder) { Warn 'Skipped: the server lives inside your game folder. Repair the game with your own clean copy.' }
else {
    # (a) Server parts that must never be in a player's game: only removed when they are the very
    #     same file as this server's copy (so a file of yours that happens to share a name stays).
    $serverOnly = @('Rumbleverse\Binaries\Win64\Server.dll', 'Engine\Binaries\Win64\Server.dll',
        'Rumbleverse\Binaries\Win64\CozmoKill.dll', 'Engine\Binaries\Win64\CozmoKill.dll',
        'Rumbleverse\Binaries\Win64\DList.ini', 'Engine\Binaries\Win64\DList.ini',
        'Rumbleverse\Binaries\Win64\UnrealModUnlocker-Settings.ini', 'Rumbleverse\Binaries\Win64\UnrealModPlugins\UnrealModUnlocker.dll',
        'Rumbleverse\Content\Paks\Rumbleverse-WindowsServer_P.pak',
        'Rumbleverse\Binaries\Win64\Start-AllModes.bat', 'Rumbleverse\Binaries\Win64\Stop-AllModes.bat',
        'Register-This-Box.bat', 'RVModes.exe', 'rv-server.version',
        'Rumbleverse\Binaries\Win64\dxgi.dll', 'Engine\Binaries\Win64\dxgi.dll')
    $groot = [IO.Path]::GetFullPath($Game).TrimEnd('\') + '\'
    foreach ($rel in $serverOnly) {
        $g = Join-Path $Game $rel; $s = Join-Path $Server $rel
        if (-not (Test-Path -LiteralPath $g) -or -not (Test-Path -LiteralPath $s)) { continue }
        if ((SharedWithGame $s $groot) -ge 0) { continue }   # the server's name for YOUR file: same content, but it is yours
        if ((Get-FileHash -LiteralPath $g).Hash -ne (Get-FileHash -LiteralPath $s).Hash) { continue }
        if ($rel -like '*dxgi.dll') {
            # Same name as the rVclient loader: the server's one in your game would load the server.
            Rename-Item -LiteralPath $g -NewName "dxgi.dll.server-$(Get-Date -Format yyyyMMddHHmmss)"
            Warn "$rel was the SERVER loader - moved aside. Open rVclient once: it puts its own back."
        } else { Remove-Item -LiteralPath $g -Force; Info "removed server file from your game: $rel" }
        $fixed++
    }
    # (b) Files your game shares with the server (links - setup's no-extra-space option: hard links
    #     on the same drive, symbolic links from another). Setup and updates never write through
    #     them; if anything did, the shared file is no longer your game's original: say which ones.
    if (Test-Path $Server) {
        $kit = @('Rumbleverse\Content\Paks\Rumbleverse-WindowsServer_P.pak')
        foreach ($rel in $kit) {
            $s = Join-Path $Server $rel; $g = Join-Path $Game $rel
            if ((Test-Path -LiteralPath $s) -and (Test-Path -LiteralPath $g) -and (SharedWithGame $s $groot) -ge 0) { $broken += $rel }
        }
        if ($Mode -eq 'Keep') {
            # Kept install: it no longer shares any file with your game, so nothing done to the
            # server folder later can touch your game. Linked files become real copies (needs the
            # space once).
            $mine = @(); $need = 0
            foreach ($f in @(Get-ChildItem -LiteralPath $Server -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType })) {
                $size = SharedWithGame $f.FullName $groot
                if ($size -ge 0) { $mine += $f; $need += $size }
            }
            if ($mine.Count) {
                $free = (Get-PSDrive ([IO.Path]::GetPathRoot($Server).Substring(0, 1))).Free
                if ($free -lt $need + 2GB) {
                    Warn ("{0} server files still share your game's files ({1:N1} GB). Not enough free space to separate them -" -f $mine.Count, ($need / 1GB))
                    Warn 'they are read only for the server and stay identical; delete the server folder to unshare them.'
                } else {
                    Info ("Separating {0} shared files from your game ({1:N1} GB, takes a few minutes)..." -f $mine.Count, ($need / 1GB))
                    foreach ($f in $mine) {
                        $tmp = $f.FullName + '.sep'
                        [IO.File]::Copy($f.FullName, $tmp, $true)   # follows a symbolic link: the real content
                        [IO.File]::Delete($f.FullName)              # removes the server's link, never your game's file
                        Rename-Item -LiteralPath $tmp -NewName $f.Name
                    }
                    Info 'Done - the server folder no longer shares files with your game.'
                }
            }
        }
    }
    if ($broken.Count) {
        Warn 'These files of your game were shared with the server and may have been changed by an older setup:'
        foreach ($b in $broken) { Warn "   $b" }
        Warn 'Put them back from your own clean copy of the game to be sure.'
    }
    if (-not $fixed -and -not $broken.Count) { Info 'Your game is normal - no server files in it.' }
}

# ---- 3. registration ----------------------------------------------------------------------
if (-not $NoUnregister -and $state -and $state.nodeId -and $state.nodeKey) {
    Step 'Registration'
    $be = if ($state.backend) { $state.backend } else { 'http://185.150.190.30:9977' }
    try {
        $r = Invoke-RestMethod -Method Post -Uri ($be.TrimEnd('/') + '/nodes/leave') -ContentType 'application/json' `
            -Body (@{ nodeId = $state.nodeId; key = $state.nodeKey } | ConvertTo-Json -Compress) -TimeoutSec 20
        if ($r.success) { Info "Removed from the server list ($($state.nodeId))." } else { Warn "Backend: $($r.error)" }
    } catch { Warn "Could not reach the backend to remove the registration ($($_.Exception.Message)). An admin / your launcher can remove it." }
}

# ---- 4. everything else (remove) ----------------------------------------------------------
if ($Mode -eq 'All') {
    Step 'Removing'
    if (-not $SkipSystemChanges) { foreach ($rule in @('Rumbleverse servers (UDP 7777-7781)', 'Rumbleverse private server (ping from Tailscale / Radmin)', 'Rumbleverse server (ping)')) {
        if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) { Get-NetFirewallRule -DisplayName $rule | Remove-NetFirewallRule; Info "firewall rule removed: $rule" }
    } }
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'rV Modes (server).lnk'
    if (Test-Path $lnk) {
        $target = try { (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath } catch { '' }
        if (& $under $target) { Remove-Item -LiteralPath $lnk -Force; Info 'desktop shortcut removed' }
    }
    if (-not $sameFolder -and (Test-Path $InstallDir)) {
        # Links to your game's files go first, one by one: deleting a link only removes the server's
        # name for the file - your game keeps it. (Setup only ever links files, never folders.)
        foreach ($f in @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType })) {
            try { if ($f.PSIsContainer) { [IO.Directory]::Delete($f.FullName, $false) } else { [IO.File]::Delete($f.FullName) } } catch { }
        }
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $InstallDir) { Warn "Some files in $InstallDir were still in use - delete the folder after a restart." }
        else { Info "$InstallDir deleted" }
    }
    if ((Test-Path $Marker) -and $info -and $info.installDir -eq $InstallDir) { Remove-Item -LiteralPath $Marker -Force }
} else {
    # The registration is gone: forget it, so setup asks for a new code / sign-up next time.
    $sf = Join-Path $InstallDir 'setup-state.json'
    if (Test-Path $sf) { Remove-Item -LiteralPath $sf -Force }
    Info "Kept in $InstallDir - run Setup-RVServer.bat again to use it (no game copy or download needed)."
}
Write-Host ''
Write-Host '   Done.' -ForegroundColor Green
Done 0
