# ============================================================================
#  Rumbleverse server setup - sets a Windows box up exactly like our NYC server.
#
#  COMMUNITY edition (default): for anyone hosting a server for the community.
#    Your server registers with our backend and waits for approval. Once an admin
#    approves it, it joins public matchmaking in your region. You control your own
#    server (modes on/off, restarts); we can block it if it misbehaves.
#
#  PRIVATE edition (-Edition Private): your own server for you and friends you pick. Never in
#    public matchmaking or the public server list. Get a setup code in your launcher (Server
#    Status > My private servers), run this, then join and share it from the launcher. Friends
#    connect over Tailscale or Radmin VPN; the firewall only lets those networks in.
#
#  OFFICIAL edition (-Edition Official -AdminToken ...): our own boxes (Kamatera etc).
#    Live as soon as it registers. Can run fully unattended (-Unattended).
#
#  What it does:
#    1. installs Node.js if missing (the server supervisor runs on it)
#    2. game files: copied from your Rumbleverse install, unpacked from a zip you
#       downloaded (e.g. the gofile package), or downloaded from a direct link
#    3. signs the box up with our backend (community: pending approval)
#    4. downloads our server kit THROUGH our backend (Server.dll, server pak,
#       supervisor) and checks every file's SHA-256
#    5. writes the configs (fresh secrets), opens the firewall ports, adds an
#       auto-start task, starts the servers and waits until the box registers
#
#  Run: right-click -> Run with PowerShell (it asks for admin rights), or
#    powershell -ExecutionPolicy Bypass -File Setup-RVServer.ps1 [options]
#  Options:
#    -Edition Community|Official   -AdminToken <token>   (Official only)
#    -InstallDir C:\RVServer       -GameDir <Rumbleverse folder>
#    -GameZip <zip>   -GameUrl <direct download link to a zip>
#    -Name "My Box"   -Contact "discordname"   -Region us-east-1   -PublicIp 1.2.3.4
#    -Modes solo,playground        -Backend http://185.150.190.30:9977
#    -Unattended (no questions; defaults + given options)   -NoStart
#    -KitDir <folder>  install the server kit from a folder (manifest.json + zip) instead of
#                      downloading it through the backend (testing / offline)
#    -SkipSystemChanges (no admin rights needed: skips firewall, auto-start task and
#                        runtime install - for a trial run or when you do those yourself)
#
#  Private play (friends/family over LAN, Tailscale or Radmin VPN): use -Edition Private.
#  Such a server is never put into our public matchmaking.
# ============================================================================
param(
    [ValidateSet('Community', 'Official', 'Private')][string]$Edition = 'Community',
    [string]$Backend = 'http://185.150.190.30:9977',
    [string]$InstallDir = 'C:\RVServer',
    [string]$GameDir = '', [string]$GameZip = '', [string]$GameUrl = '',
    [ValidateSet('', 'Copy', 'Link')][string]$GameFiles = '',
    [string]$Name = '', [string]$Contact = '', [string]$Region = '', [string]$PublicIp = '',
    [string]$Modes = '', [string]$AdminToken = '', [string]$NodeId = '', [string]$NodeKey = '', [string]$SetupCode = '', [string]$KitDir = '',
    [switch]$Unattended, [switch]$NoStart, [switch]$SkipSystemChanges, [switch]$Auto, [switch]$ForceCommunity
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- elevate --------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SkipSystemChanges) {
    Write-Host 'Asking for administrator rights (needed for the firewall and auto-start)...'
    $pass = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    foreach ($k in $PSBoundParameters.Keys) {
        $v = $PSBoundParameters[$k]
        if ($v -is [switch]) { if ($v) { $pass += "-$k" } } else { $pass += "-$k"; $pass += "`"$v`"" }
    }
    try { Start-Process powershell.exe -Verb RunAs -ArgumentList $pass } catch { Write-Host 'Administrator rights were refused - nothing was changed.' -ForegroundColor Red; Read-Host 'Press Enter to close' }
    exit
}

# Which drive? Not passed: an existing install stays where it is; otherwise, with more than one
# drive, ask - suggesting your game's drive (fastest; links work from any drive), or the one with
# the most free space.
if (-not $PSBoundParameters.ContainsKey('InstallDir')) {
    $prev = $null
    $markerFile = Join-Path $env:ProgramData 'RVServer\install.json'
    if (Test-Path $markerFile) { try { $prev = (Get-Content -Raw $markerFile) -replace '^﻿', '' | ConvertFrom-Json } catch { } }
    if ($prev -and $prev.installDir -and (Test-Path (Join-Path $prev.installDir 'server'))) { $InstallDir = $prev.installDir }
    else {
        $gameDrive = ''
        $probe = if ($GameDir) { $GameDir } else { '' }
        if (-not $probe) {
            foreach ($ini in @("$env:USERPROFILE\rVclient\rVclient.ini", "$env:LOCALAPPDATA\RVClient\rVclient.ini")) {
                if ($probe -or -not (Test-Path $ini)) { continue }
                $line = Select-String -LiteralPath $ini -Pattern '^\s*GameExe\s*=\s*(.+?)\s*$' | Select-Object -First 1
                if ($line) { $probe = $line.Matches[0].Groups[1].Value }
            }
        }
        if ($probe -and (Test-Path $probe)) { $gameDrive = ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($probe))).Substring(0, 1).ToUpper() }
        $drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady })
        if ($drives.Count -gt 1) {
            $suggest = if ($gameDrive -and ($drives | Where-Object { $_.Name.StartsWith($gameDrive) })) { $gameDrive }
                       else { ($drives | Sort-Object AvailableFreeSpace -Descending | Select-Object -First 1).Name.Substring(0, 1) }
            Write-Host ''
            Write-Host '   Where should the server go? Any drive works: about 1 GB when it links your game files,'
            Write-Host "   about 15 GB when it copies them. Your game's drive is suggested (fastest to set up)."
            foreach ($d in $drives) {
                $l = $d.Name.Substring(0, 1)
                Write-Host ("     {0}:  {1,7:N1} GB free{2}" -f $l, ($d.AvailableFreeSpace / 1GB), $(if ($l -eq $gameDrive) { '   <- your game is here' } else { '' }))
            }
            $pick = $suggest
            if (-not $Unattended) {
                $a = Read-Host "   Drive letter [$suggest]"
                if ($a -match '^\s*([A-Za-z])') { $pick = $Matches[1].ToUpper() }
            }
            if (-not ($drives | Where-Object { $_.Name.StartsWith($pick) })) { Write-Host "   No drive $pick`: - using $suggest`:" -ForegroundColor Yellow; $pick = $suggest }
            $InstallDir = "$($pick):\RVServer"
        }
    }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$Server = Join-Path $InstallDir 'server'
$Win64 = Join-Path $Server 'Rumbleverse\Binaries\Win64'
$Sup = Join-Path $Win64 'RVSupervisor'
$StateFile = Join-Path $InstallDir 'setup-state.json'
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Start-Transcript -Path (Join-Path $InstallDir 'setup.log') -Append | Out-Null

function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Info($t) { Write-Host "   $t" }
function Fail($t) { Write-Host ''; Write-Host "SETUP STOPPED: $t" -ForegroundColor Red; Write-Host "Log: $(Join-Path $InstallDir 'setup.log')"; Stop-Transcript | Out-Null; if (-not $Unattended) { Read-Host 'Press Enter to close' }; exit 1 }
# -Auto (what Setup-RVServer.bat uses): every question takes its automatic answer, but the window
# still waits at the end so the owner can read the result. -Always: asked even then (a setup code).
function Ask($q, $def, [switch]$Always) {
    if ($Unattended -or ($Auto -and -not $Always)) { if ($Auto -and "$def" -ne '') { Info "$q -> $def" }; return $def }
    $a = Read-Host ("   $q" + $(if ($def) { " [$def]" } else { '' }))
    if ([string]::IsNullOrWhiteSpace($a)) { return $def } else { return $a.Trim() }
}
function PostJson($route, $body) {
    $json = $body | ConvertTo-Json -Compress -Depth 5
    try { return Invoke-RestMethod -Method Post -Uri ($Backend.TrimEnd('/') + $route) -ContentType 'application/json' -Body $json -TimeoutSec 60 }
    catch {
        $msg = $_.Exception.Message
        try { $r = $_.ErrorDetails.Message | ConvertFrom-Json; if ($r.error) { $msg = $r.error } } catch { }
        throw $msg
    }
}
function Sha256($p) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

Write-Host ''
Write-Host '  Rumbleverse server setup' -ForegroundColor Green
Write-Host "  Edition: $Edition    Install folder: $InstallDir"
if ($Edition -eq 'Private') {
    Write-Host '  A private server: only you and the friends you share it with can see and join it.'
    Write-Host '  Each running mode needs about 3.5 GB of RAM on top of the game - Playground alone is lightest.'
}
if ($Edition -eq 'Community') {
    Write-Host '  Your server will be reviewed before it joins public matchmaking.'
    Write-Host '  Each running mode needs about 3.5 GB of RAM; Solo + Playground = ~7 GB.'
}
$state = @{}
if (Test-Path $StateFile) { $state = Get-Content $StateFile -Raw | ConvertFrom-Json }

# Community servers in public matchmaking must run on a VPS / dedicated server. On a HOME
# connection a private server (you + friends over Tailscale / Radmin VPN) is what works - so a
# home PC always gets one. (-ForceCommunity skips this; an already registered box is left as it is.)
if ($Edition -eq 'Community' -and -not $ForceCommunity -and -not $state.nodeId -and -not $NodeId) {
    $net = $null
    try { $net = PostJson '/nodes/network-check' @{} } catch { }
    # A backend without that route (or unreachable): ask the same lookup service directly.
    if (-not $net -or $null -eq $net.hosting) {
        try {
            $r = Invoke-RestMethod -Uri 'http://ip-api.com/json/?fields=status,hosting,isp' -TimeoutSec 10
            if ($r.status -eq 'success') { $net = [pscustomobject]@{ hosting = [bool]$r.hosting; isp = "$($r.isp)" } }
        } catch { }
    }
    if ($net -and $net.hosting -eq $false) {
        Write-Host ''
        Write-Host "   This PC is on a HOME internet connection$(if ($net.isp) { " ($($net.isp))" })." -ForegroundColor Yellow
        Write-Host '   Public matchmaking needs a VPS or dedicated server, so this sets up a PRIVATE server instead'
        Write-Host '   (recommended): you and the friends you share it with play on it over Tailscale / Radmin VPN.'
        $Edition = 'Private'
    }
}

# ---- 1. Node.js -------------------------------------------------------------------------
Step 'Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Info 'Not installed - downloading Node.js 22 LTS...'
    $msi = Join-Path $env:TEMP 'node-lts-x64.msi'
    Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi' -OutFile $msi -UseBasicParsing
    $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "Node.js install failed (msiexec exit $($p.ExitCode))" }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Fail 'Node.js installed but not found on PATH - restart the PC and run setup again.' }
}
Info ("Node.js " + (& node --version))

# ---- 2. game files ----------------------------------------------------------------------
Step 'Game files'
function Find-GameRoot($dir) {
    # The folder that holds Rumbleverse\Binaries\Win64\RumbleverseClient-Win64-Shipping.exe
    $exe = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'RumbleverseClient-Win64-Shipping.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -like '*\Rumbleverse\Binaries\Win64' } | Select-Object -First 1
    if ($exe) { return (Resolve-Path (Join-Path $exe.DirectoryName '..\..\..')).Path } else { return $null }
}
if (Test-Path (Join-Path $Win64 'RumbleverseClient-Win64-Shipping.exe')) {
    Info "Already in place: $Server"
} else {
    $src = $null
    if ($GameZip -or $GameUrl) {
        if ($GameUrl) {
            $GameZip = Join-Path $InstallDir 'game-files.zip'
            Info "Downloading the game files (about 11 GB) from $GameUrl ..."
            try { Start-BitsTransfer -Source $GameUrl -Destination $GameZip -ErrorAction Stop }
            catch { Invoke-WebRequest -Uri $GameUrl -OutFile $GameZip -UseBasicParsing }
        }
        if (-not (Test-Path $GameZip)) { Fail "Game zip not found: $GameZip" }
        $unz = Join-Path $InstallDir '_game-unpack'
        Info "Unpacking $GameZip (this takes a while)..."
        New-Item -ItemType Directory -Force $unz | Out-Null
        & $Tar -xf $GameZip -C $unz
        if ($LASTEXITCODE -ne 0) { Fail 'Could not unpack the game zip' }
        $src = Find-GameRoot $unz
        if (-not $src) { Fail 'No Rumbleverse\Binaries\Win64\RumbleverseClient-Win64-Shipping.exe inside that zip' }
        Move-Item -LiteralPath $src -Destination $Server
        Remove-Item -Recurse -Force $unz -ErrorAction SilentlyContinue
        # A zip of someone's server folder carries their configs/secrets and supervisor state:
        # drop them so this box gets its own (and the player mod, which a server doesn't use).
        # (Matched with -like per name: -Include is ignored with -LiteralPath in PowerShell 5.1.)
        $drop = @('Config*.ini*', 'ds-instances.json*', 'modes.json*', 'rv-server.version', '*.log', '*.dmp', 'crash_trace*',
                  'Client.dll*', 'cnsl.dll*', 'odin.dll*', 'odin_crypto.dll*', 'rvclient.version*')
        Get-ChildItem -LiteralPath $Server -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $n = $_.Name; @($drop | Where-Object { $n -like $_ }).Count -gt 0 } |
            Remove-Item -Force -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force (Join-Path $Win64 'RVSupervisor'), (Join-Path $Server '_updates') -ErrorAction SilentlyContinue
    } else {
        if (-not $GameDir) {
            # 1st choice: the game your rVclient launcher already uses (GameExe= in rVclient.ini).
            foreach ($ini in @("$env:USERPROFILE\rVclient\rVclient.ini", "$env:LOCALAPPDATA\RVClient\rVclient.ini")) {
                if ($GameDir -or -not (Test-Path $ini)) { continue }
                $line = Select-String -LiteralPath $ini -Pattern '^\s*GameExe\s*=\s*(.+?)\s*$' | Select-Object -First 1
                if ($line) {
                    $exeDir = Split-Path $line.Matches[0].Groups[1].Value
                    if ($exeDir -and (Test-Path $exeDir)) { $r = Find-GameRoot $exeDir; if ($r) { $GameDir = $r; Info "Found your game (from the rVclient launcher): $r" } }
                }
            }
            foreach ($c in @("$env:ProgramFiles\Epic Games\Rumbleverse", "${env:ProgramFiles(x86)}\Epic Games\Rumbleverse",
                             "$env:USERPROFILE\Downloads", 'C:\Games', 'D:\Games', 'D:\Epic Games\Rumbleverse')) {
                if ($GameDir) { break }
                if ($c -and (Test-Path $c)) { $r = Find-GameRoot $c; if ($r) { $GameDir = $r; break } }
            }
            # Found: auto mode just uses it. Not found: always ask, even in auto mode.
            if ($GameDir) { $GameDir = Ask 'Your Rumbleverse game folder (the one with Rumbleverse and Engine inside)' $GameDir }
            else { $GameDir = Ask 'Your Rumbleverse game folder (the one with Rumbleverse and Engine inside)' '' -Always }
        }
        if (-not $GameDir) { Fail 'No game files. Use -GameDir <your Rumbleverse folder>, -GameZip <downloaded zip> or -GameUrl <direct link>.' }
        $src = Find-GameRoot $GameDir
        if (-not $src) { Fail "No Rumbleverse\Binaries\Win64\RumbleverseClient-Win64-Shipping.exe under $GameDir" }
        # The server is the SAME game files as your install, minus the player mod (rVclient) - the
        # kit adds the server loader. The big pak files (~11 GB) are HARD-LINKED when the server
        # folder is on the same drive: no extra disk space, done in seconds, and your install is
        # never changed (the kit never writes to them). Everything small is copied.
        # Your game stays where it is and keeps launching from the rVclient launcher as before - the
        # server gets its OWN folder. Its big files are either COPIED (fully separate, needs the space
        # once - recommended) or LINKED (no extra space: the same files on disk, read only for the
        # server - nothing of the server ever writes to them). Same drive: hard links; another drive:
        # symbolic links (Windows needs administrator rights for those - setup has them).
        $bigFiles = @(Get-ChildItem -LiteralPath $src -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { @('.pak', '.ucas', '.utoc') -contains $_.Extension.ToLower() })
        $bigBytes = ($bigFiles | Measure-Object Length -Sum).Sum
        $free = (Get-PSDrive ([IO.Path]::GetPathRoot($Server).Substring(0, 1))).Free
        $sameVolume = [IO.Path]::GetPathRoot($src) -eq [IO.Path]::GetPathRoot($Server)
        $isAdminNow = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
                      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        $canLink = $sameVolume -or $isAdminNow
        $canCopy = $free -gt $bigBytes + 5GB
        $gb = '{0:N1} GB' -f ($bigBytes / 1GB)
        if (-not $GameFiles) {
            if ($canCopy -and $canLink) {
                Write-Host ''
                Write-Host "   The server needs its own copy of the game files ($gb). Your game is not changed either way"
                Write-Host '   and still starts from the rVclient launcher, also while your server runs.'
                Write-Host "     C = copy them ($gb of space, fully separate - recommended)"
                Write-Host '     L = link them (no extra space - the same files on disk, only read by the server)'
                $GameFiles = if ((Ask 'Copy or link? (C/l)' 'c' -Always) -match '^\s*l') { 'Link' } else { 'Copy' }
            } elseif ($canCopy) { $GameFiles = 'Copy' }
            elseif ($canLink) { $GameFiles = 'Link'; Info ("Not enough free space to copy the game files ($gb + 5 GB spare) - linking them instead.") }
            else { Fail ("Not enough free space on $([IO.Path]::GetPathRoot($Server)) to copy the game files ($gb + 5 GB spare). Free some space or use -InstallDir on another drive.") }
        }
        if ($GameFiles -eq 'Link' -and -not $canLink) { Info 'Linking to another drive needs administrator rights - copying instead.'; $GameFiles = 'Copy' }
        $sameDrive = $GameFiles -eq 'Link'
        Info $(if ($sameDrive) { "Using your game files in $src (big files linked, no extra space; your install is not changed)..." }
               else { "Copying $src -> $Server ($gb - takes a few minutes; your own install is not changed)..." })
        # Left out: the player mod and, when the source is another server, its configs/secrets,
        # logs, dumps and supervisor state - this box gets fresh ones.
        $xf = @('Client.dll*', 'cnsl.dll*', 'odin.dll*', 'odin_crypto.dll*', 'RVUpdateHelper.exe*', 'rvclient.version*', 'Config*.ini*',
                '*.bak*', '*.inuse-*', '*.old-update-*', '*.log', '*.dmp', 'crash_trace*', 'rv-server.version')
        if ($sameDrive) { $xf += @('*.pak', '*.ucas', '*.utoc') }
        & robocopy $src $Server /E /R:1 /W:1 /NFL /NDL /NJH /NP /XD Saved RVSupervisor backups _updates /XF @xf | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "Copy failed (robocopy exit $LASTEXITCODE)" }
        if ($sameDrive) {
            $linked = 0
            # Filter by extension explicitly: in Windows PowerShell 5.1, -Include is ignored with
            # -LiteralPath, which linked EVERY skipped file (the player mod included).
            $big = Get-ChildItem -LiteralPath $src -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { @('.pak', '.ucas', '.utoc') -contains $_.Extension.ToLower() }
            foreach ($f in $big) {
                $rel = $f.FullName.Substring($src.TrimEnd('\').Length).TrimStart('\')
                $dst = Join-Path $Server $rel
                if (Test-Path -LiteralPath $dst) { continue }
                New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
                # Same drive: hard link. Another drive (or a hard link refused): symbolic link.
                # Neither possible (e.g. not NTFS): a plain copy.
                $done = $false
                foreach ($kind in $(if ($sameVolume) { 'HardLink', 'SymbolicLink' } else { 'SymbolicLink' })) {
                    if ($done) { break }
                    try { New-Item -ItemType $kind -Path $dst -Target $f.FullName -ErrorAction Stop | Out-Null; $linked++; $done = $true } catch { }
                }
                if (-not $done) { Copy-Item -LiteralPath $f.FullName -Destination $dst -Force }
            }
            Info "$linked game files linked"
        }
    }
    if (-not (Test-Path (Join-Path $Win64 'RumbleverseClient-Win64-Shipping.exe'))) { Fail 'Game files are not where they should be after copying' }
    Info 'Game files ready.'
}

# ---- 3. address, region, sign-up ------------------------------------------------------------
Step 'Your server'
$IsPrivate = $Edition -eq 'Private'
if (-not $PublicIp -and $IsPrivate) {
    # The address your FRIENDS connect to: your Tailscale (100.64-127.x) or Radmin VPN (26.x)
    # address. You yourself always join through this PC (127.0.0.1).
    $vpn = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.IPAddress -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' -or $_.IPAddress -match '^26\.' } |
        ForEach-Object { $n = if ($_.IPAddress -like '26.*') { 'Radmin VPN' } else { 'Tailscale' }; [pscustomobject]@{ Ip = $_.IPAddress; Name = $n } })
    foreach ($v in $vpn) { Info "Found $($v.Name) address $($v.Ip)" }
    if (-not $vpn.Count) { Info 'No Tailscale or Radmin VPN address found - only this PC can join until you set one up and run setup again.' }
    $PublicIp = Ask 'Address your friends connect to (127.0.0.1 = only this PC)' $(if ($vpn.Count) { $vpn[0].Ip } else { '127.0.0.1' })
}
if (-not $PublicIp) {
    try { $PublicIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 15).Trim() } catch { }
    $PublicIp = Ask 'Public IP address players connect to' $PublicIp
}
if ($PublicIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Fail "Not an IPv4 address: $PublicIp" }
$regions = [ordered]@{ 'us-east-1' = 'USA East'; 'us-west-1' = 'USA West'; 'eu-central-1' = 'Europe'; 'sa-east-1' = 'South America';
    'ap-northeast-1' = 'Asia (Tokyo)'; 'ap-south-1' = 'India'; 'ap-southeast-1' = 'Asia (Singapore)'; 'ap-southeast-2' = 'Oceania' }
if (-not $Region -and $IsPrivate) { $Region = 'us-east-1' }   # never matchmade: region unused
if (-not $Region) {
    # The same pings the game uses: TCP connect to the AWS GameLift endpoint of each region.
    Info 'Measuring the ping to each region...'
    $best = $null; $bestMs = 99999
    foreach ($k in $regions.Keys) {
        $ms = $null
        try {
            $c = New-Object Net.Sockets.TcpClient; $sw = [Diagnostics.Stopwatch]::StartNew()
            $t = $c.ConnectAsync("gamelift.$k.amazonaws.com", 443)
            if ($t.Wait(2500)) { $ms = $sw.ElapsedMilliseconds }
            $c.Dispose()
        } catch { }
        Info ("  {0,-16} {1}" -f $regions[$k], $(if ($null -ne $ms) { "$ms ms" } else { 'no answer' }))
        if ($null -ne $ms -and $ms -lt $bestMs) { $best = $k; $bestMs = $ms }
    }
    $Region = Ask ('Region (' + ($regions.Keys -join ', ') + ')') $(if ($best) { $best } else { 'us-east-1' })
}
if (-not $regions.Contains($Region)) { Fail "Unknown region $Region" }
if (-not $Name -and $IsPrivate) { $Name = Ask 'Name of your server (you and your friends see it)' "$env:USERNAME's server" }
if (-not $Name) { $Name = Ask 'Server name shown to admins' ("$($regions[$Region]) " + $(if ($Edition -eq 'Official') { 'Box' } else { 'Community' })) }
if (-not $Modes) { $Modes = Ask 'Modes to run (solo, playground, duos, trios, squads)' $(if ($IsPrivate) { 'playground' } else { 'solo,playground' }) }
# "This PC" for the owner's launcher: a hash of the Windows machine id (the id itself never leaves the PC).
$HostId = ''
try {
    $guid = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid.ToLower()
    $sha = [Security.Cryptography.SHA256]::Create()
    $HostId = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("rv-host:$guid")) | ForEach-Object { $_.ToString('x2') }) -join '')
} catch { }

if (-not $NodeId -and $state.nodeId) {
    # Still known to the backend? A removed one (launcher Remove, an admin) needs a new code / sign-up.
    $known = $true
    try { PostJson '/nodes/status' @{ nodeId = $state.nodeId; key = $state.nodeKey } | Out-Null }
    catch { if ("$_" -match 'Unknown node|bad key') { $known = $false } }
    if ($known) { $NodeId = $state.nodeId; $NodeKey = $state.nodeKey; Info "Using this box's existing registration $NodeId" }
    else { Info "This box's old registration $($state.nodeId) was removed - registering it again."; Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
}
if (-not $NodeId) {
    if ($Edition -eq 'Official') {
        if (-not $AdminToken) { $AdminToken = Ask 'Admin token (RVCOZMO_ADMIN_TOKEN)' '' -Always }
        try { $r = PostJson '/admin/nodes/create' @{ token = $AdminToken; name = $Name; owner = 'admin' } } catch { Fail "Backend refused: $_" }
    } elseif ($IsPrivate) {
        Info 'In your rVclient launcher: Server Status > My private servers > Get setup code.'
        if (-not $SetupCode) { $SetupCode = Ask 'Setup code (like ABCDE-FGH23)' '' -Always }
        try { $r = PostJson '/nodes/signup-private' @{ code = $SetupCode; name = $Name } } catch { Fail "Setup code refused: $_" }
    } else {
        if (-not $Contact) { $Contact = Ask 'Your Discord name (so we can reach you about approval)' '' -Always }
        try { $r = PostJson '/nodes/signup' @{ name = $Name; contact = $Contact; publicIp = $PublicIp } } catch { Fail "Sign-up refused: $_" }
        # Public matchmaking needs a VPS or dedicated server - say so now, not after a review.
        if ($r.node.network -and $r.node.network.hosting -eq $false) {
            Write-Host ''
            Write-Host "   NOTE: $PublicIp looks like a HOME internet connection ($($r.node.network.isp))." -ForegroundColor Yellow
            Write-Host '   Community servers in public matchmaking must run on a VPS or dedicated server, so this'
            Write-Host '   one will not be approved for matchmaking as it is. To play with friends instead, run:'
            Write-Host '     Setup-RVServer.bat -Edition Private'
            if ((Ask 'Continue the setup anyway? (y/N)' 'y') -notmatch '^y') { Fail 'Stopped - nothing else was changed.' }
        }
    }
    $NodeId = $r.node.id; $NodeKey = $r.key
    @{ nodeId = $NodeId; nodeKey = $NodeKey; edition = $Edition; backend = $Backend } | ConvertTo-Json | Set-Content -Encoding UTF8 $StateFile
    # The key is a password for this box: only administrators may read the state file.
    & icacls $StateFile /inheritance:r /grant:r '*S-1-5-32-544:F' 'SYSTEM:F' "${env:USERDOMAIN}\${env:USERNAME}:F" | Out-Null
    Info "Registered as $NodeId ($($r.node.status))"
}

# ---- 4. server kit -----------------------------------------------------------------------
# -KitDir <folder with manifest.json + the kit zip>: install the kit from there instead of
# downloading it (testing before kits are served, or an offline box). Hashes are still checked.
if ($KitDir) {
    Step "Server kit (from $KitDir)"
    $mf = Join-Path $KitDir 'manifest.json'
    if (-not (Test-Path $mf)) { Fail "No manifest.json in $KitDir" }
    $m = Get-Content $mf -Raw | ConvertFrom-Json
} else {
    Step 'Server kit (through our backend)'
    try { $m = (PostJson '/nodes/update/manifest' @{ nodeId = $NodeId; key = $NodeKey }).manifest }
    catch { Fail "Could not get the server kit: $_  (not served by this backend yet? use -KitDir <folder with manifest.json + zip>)" }
}
$have = ''
if (Test-Path (Join-Path $Server 'rv-server.version')) { $have = (Get-Content (Join-Path $Server 'rv-server.version') -Raw).Trim() }
if ($have -eq $m.version) { Info "Already on server kit $have" } else {
    Info "Server kit $($m.version) ($([math]::Round($m.size / 1MB)) MB)"
    if ($KitDir) {
        $zip = Join-Path $KitDir $m.package
        if (-not (Test-Path $zip)) { Fail "Kit zip $($m.package) is not in $KitDir" }
    } else {
        $zip = Join-Path $InstallDir $m.package
        $json = @{ nodeId = $NodeId; key = $NodeKey; version = $m.version } | ConvertTo-Json -Compress
        Invoke-WebRequest -Method Post -Uri ($Backend.TrimEnd('/') + '/nodes/update/package') -ContentType 'application/json' -Body $json -OutFile $zip -UseBasicParsing -TimeoutSec 3600
    }
    if ((Sha256 $zip) -ne $m.sha256) { if (-not $KitDir) { Remove-Item $zip -Force }; Fail 'The kit does not match its SHA-256 - not installed. Try again.' }
    $stage = Join-Path $InstallDir '_kit'
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $stage | Out-Null
    & $Tar -xf $zip -C $stage
    if ($LASTEXITCODE -ne 0) { Fail 'Could not unpack the server kit' }
    foreach ($f in $m.files) {
        $p = Join-Path $stage ($f.path -replace '/', '\')
        if (-not (Test-Path $p) -or (Sha256 $p) -ne $f.sha256) { Fail "Kit file failed its SHA-256 check: $($f.path)" }
    }
    # Re-run on a working box: rV Modes may be open and the servers running (Server.dll loaded).
    # Close rV Modes (reopened below); a file still in use is renamed aside - Windows allows that
    # for a loaded DLL/exe - and the new one copied in. Running servers switch at their next restart.
    # Stop this box's supervisor (Node.js) and its servers first, so the new files and the new
    # supervisor take over - it is started again at the end. Older supervisors without /shutdown:
    # their game servers are closed directly (the in-use rename below covers anything left).
    $instFile = Join-Path $Sup 'ds-instances.json'
    if (Test-Path $instFile) {
        try {
            $ic = (Get-Content -Raw $instFile) -replace '^\uFEFF', '' | ConvertFrom-Json
            $port = if ($ic.adminPort) { $ic.adminPort } else { 9988 }
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/shutdown" -Headers @{ 'x-admin-token' = "$($ic.adminToken)" } -TimeoutSec 10 | Out-Null
            Info 'Stopping the running servers and supervisor for the update...'
            for ($i = 0; $i -lt 30; $i++) {
                Start-Sleep 1
                try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/instances" -Headers @{ 'x-admin-token' = "$($ic.adminToken)" } -TimeoutSec 2 | Out-Null } catch { break }
            }
        } catch { }
        foreach ($gp in @(Get-Process RumbleverseClient-Win64-Shipping -ErrorAction SilentlyContinue)) {
            try { if ($gp.Path -and $gp.Path.StartsWith($Server, [StringComparison]::OrdinalIgnoreCase)) { $gp.Kill(); $gp.WaitForExit(5000) | Out-Null } } catch { }
        }
    }
    $rvmWasOpen = $false
    foreach ($proc in @(Get-Process RVModes -ErrorAction SilentlyContinue)) {
        if (-not $proc.Path -or -not $proc.Path.StartsWith($Server, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $rvmWasOpen = $true
        try { $proc.Kill(); $proc.WaitForExit(5000) | Out-Null } catch { }
    }
    Get-ChildItem -LiteralPath $Server -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*.old-setup-*' } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }   # left by earlier runs
    $stamp = Get-Date -Format yyyyMMddHHmmss
    foreach ($f in $m.files) {
        $dst = Join-Path $Server ($f.path -replace '/', '\')
        $srcFile = Join-Path $stage ($f.path -replace '/', '\')
        New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
        # Hard-linked to your own game install: drop this link first - writing through it would
        # change your game's file too.
        if ((Test-Path -LiteralPath $dst) -and @('HardLink', 'SymbolicLink') -contains (Get-Item -LiteralPath $dst -Force).LinkType) {
            try { Remove-Item -LiteralPath $dst -Force -ErrorAction Stop }
            catch { Rename-Item -LiteralPath $dst -NewName ((Split-Path $dst -Leaf) + ".old-setup-$stamp") }
        }
        try { Copy-Item -LiteralPath $srcFile -Destination $dst -Force -ErrorAction Stop }
        catch {
            try {
                Rename-Item -LiteralPath $dst -NewName ((Split-Path $dst -Leaf) + ".old-setup-$stamp") -ErrorAction Stop
                Copy-Item -LiteralPath $srcFile -Destination $dst -Force -ErrorAction Stop
                Info "$($f.path) was in use - replaced (the running copy switches at its next restart)"
            } catch { Fail "Could not replace $($f.path) (in use?) - close rV Modes, run Stop-AllModes.bat and run setup again. ($($_.Exception.Message))" }
        }
    }
    if ($rvmWasOpen) { $script:ReopenRVModes = $true }
    Set-Content -NoNewline -Encoding ASCII (Join-Path $Server 'rv-server.version') $m.version
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    if (-not $KitDir) { Remove-Item -Force $zip -ErrorAction SilentlyContinue }   # never delete the given kit
    Info "Installed server kit $($m.version) ($($m.files.Count) files, all checked)"
}

# ---- 5. Windows prerequisites ------------------------------------------------------------
Step 'Windows runtime (Visual C++)'
if ($SkipSystemChanges) { Info 'Skipped (-SkipSystemChanges)' } else {
$pre = Join-Path $Server 'Engine\Extras\Redist\en-us\UE4PrereqSetup_x64.exe'
if (Test-Path $pre) { $p = Start-Process $pre -ArgumentList '/quiet', '/norestart' -Wait -PassThru; Info "UE4 prerequisites (exit $($p.ExitCode))" }
else {
    $vc = Join-Path $env:TEMP 'vc_redist.x64.exe'
    Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $vc -UseBasicParsing
    $p = Start-Process $vc -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru; Info "Visual C++ runtime (exit $($p.ExitCode))"
}
}

# ---- 6. configs ---------------------------------------------------------------------------
Step 'Configs'
$extra = @()
if ($IsPrivate) { $extra += '--private' }
if ($HostId) { $extra += '--host-id'; $extra += $HostId }
& node (Join-Path $Sup 'setup-box.mjs') --backend $Backend --node-id $NodeId --node-key $NodeKey --region $Region --public-ip $PublicIp --modes $Modes @extra
if ($LASTEXITCODE -ne 0) { Fail 'Writing the configs failed (see above)' }

# ---- 7. firewall + auto-start ---------------------------------------------------------------
Step 'Firewall and auto-start'
if ($SkipSystemChanges) { Info 'Skipped (-SkipSystemChanges): open UDP 7777-7781 inbound and start Start-AllModes.bat yourself.' } else {
$rule = 'Rumbleverse servers (UDP 7777-7781)'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($IsPrivate) {
    # Private: only this PC's network, Tailscale and Radmin VPN - never the open internet.
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol UDP -LocalPort 7777-7781 -Action Allow `
        -RemoteAddress LocalSubnet, '100.64.0.0/10', '26.0.0.0/8' | Out-Null
    Info "Firewall: $rule - only your network, Tailscale and Radmin VPN (do NOT forward these ports on your router)"
    # Ping from the same VPNs: a launcher on your Tailscale / Radmin network lists your server only
    # when this PC answers it (Windows blocks ping by default).
    $pingRule = 'Rumbleverse private server (ping from Tailscale / Radmin)'
    Get-NetFirewallRule -DisplayName $pingRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $pingRule -Direction Inbound -Protocol ICMPv4 -IcmpType 8 -Action Allow `
        -RemoteAddress '100.64.0.0/10', '26.0.0.0/8' | Out-Null
} else {
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol UDP -LocalPort 7777-7781 -Action Allow | Out-Null
    Info "Firewall: $rule (also open these in your provider's panel / router if it has a firewall)"
    # Ping: players' launchers show their ping to each server (Windows blocks ping by default).
    $pingRule = 'Rumbleverse server (ping)'
    Get-NetFirewallRule -DisplayName $pingRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $pingRule -Direction Inbound -Protocol ICMPv4 -IcmpType 8 -Action Allow | Out-Null
    Info "Firewall: $pingRule - players' launchers show their ping to this server"
}
if ($IsPrivate -and -not $Unattended -and (Ask 'Start your server automatically when you log on? (y/N)' 'n') -notmatch '^y') {
    Info 'No auto-start: run Start-AllModes.bat when you want to play.'
} else {
$task = 'Rumbleverse Server Supervisor'
$act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$(Join-Path $Win64 'Start-AllModes.bat')`"" -WorkingDirectory $Win64
$trg = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $act -Trigger $trg -Settings $set -RunLevel Highest -Force | Out-Null
Info "Auto-start: '$task' starts the servers when $env:USERNAME logs on (on a VPS, turn on auto-logon)"
}
}

# Remove later: Uninstall-RVServer next to the server (the launcher's Remove runs it too) and a
# marker telling it - and the launcher - where the server and YOUR game install are (setup links
# your game's big files; the uninstaller makes sure your game is left normal).
foreach ($f in @('Uninstall-RVServer.ps1', 'Uninstall-RVServer.bat')) {
    $p = Join-Path $PSScriptRoot $f
    if ((Test-Path $p) -and ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ne $InstallDir.TrimEnd('\'))) { Copy-Item -LiteralPath $p -Destination $InstallDir -Force }
}
try {
    $marker = Join-Path $env:ProgramData 'RVServer\install.json'
    $old = $null; if (Test-Path $marker) { try { $old = (Get-Content -Raw $marker) -replace '^﻿', '' | ConvertFrom-Json } catch { } }
    $gs = if ($src -and -not ([IO.Path]::GetFullPath($src).StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase))) { $src }
          elseif ($old -and $old.installDir -eq $InstallDir) { $old.gameSource } else { '' }
    New-Item -ItemType Directory -Force (Split-Path $marker) | Out-Null
    @{ installDir = $InstallDir; gameSource = $gs; edition = $Edition; nodeId = $NodeId; backend = $Backend } |
        ConvertTo-Json | Set-Content -Encoding UTF8 $marker
    Info "To remove it later: Uninstall-RVServer.bat in $InstallDir (or Remove in your launcher for a private server)"
} catch { Info "Could not write $marker ($($_.Exception.Message)) - Uninstall-RVServer.bat still works with -InstallDir." }

# RV Modes: the owner's app - switch modes, see if the server is approved / denied (and why),
# and update it. Desktop shortcut for the user running setup.
$rvm = Join-Path $Server 'RVModes.exe'
if (Test-Path $rvm) {
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'rV Modes (server).lnk'
        $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
        $sh.TargetPath = $rvm; $sh.WorkingDirectory = $Server; $sh.Description = 'Rumbleverse server: modes, status and updates'
        $sh.Save()
        Info "RV Modes: desktop shortcut 'rV Modes (server)' - your server's modes, review status and updates"
    } catch { Info "RV Modes is at $rvm" }
    # It was open before the update: open the new one again (as the logged-on user would see it).
    if ($script:ReopenRVModes) { try { Start-Process -FilePath $rvm -WorkingDirectory $Server; Info 'rV Modes reopened (new version).' } catch { } }
}

# ---- 8. start + wait for registration -----------------------------------------------------
if ($NoStart) { Step 'Done'; Info ("Not started (-NoStart). Start with Start-AllModes.bat in $Win64"); Stop-Transcript | Out-Null; exit 0 }
Step 'Starting'
$log = Join-Path $Sup 'supervisor.log'
$before = 0; if (Test-Path $log) { $before = (Get-Item $log).Length }
Start-Process cmd.exe -ArgumentList '/c', "`"$(Join-Path $Win64 'Start-AllModes.bat')`"" -WorkingDirectory $Win64
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep 2
    if (Test-Path $log) {
        $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($before, 'Begin') | Out-Null
        $new = (New-Object IO.StreamReader($fs)).ReadToEnd(); $fs.Close()
        if ($new -match '\[node\] registered') { $ok = $true; break }
        if ($new -match '\[node\] (register failed|backend refused)[^\r\n]*') { Info $Matches[0] }
    }
}
Step 'Done'
if ($ok) {
    if ($IsPrivate) {
        Write-Host '   Your private server is ready.' -ForegroundColor Green
        Write-Host '   In your launcher: Server Status > My private servers - Join it from there.'
        Write-Host '   Share it with friends there too (their rVclient name); only you and they can see it.'
        Write-Host '   Friends need to be on the same Tailscale / Radmin VPN network as this PC.'
    } elseif ($Edition -eq 'Community') {
        Write-Host '   Your server is registered and WAITING FOR APPROVAL.' -ForegroundColor Yellow
        Write-Host '   An admin reviews it; once approved it joins matchmaking by itself - nothing to do on your side.'
        Write-Host "   Your server id: $NodeId   (keep $StateFile private - it holds the server's key)"
    } else { Write-Host '   The box is registered and live in matchmaking.' -ForegroundColor Green }
} else { Write-Host "   The servers started, but the box has not registered yet. Check $log" -ForegroundColor Yellow }
Write-Host ''
Write-Host "   YOUR SERVER IS INSTALLED IN:  $Server" -ForegroundColor Green
Write-Host "   Manage it with the 'rV Modes (server)' shortcut on your desktop: modes on/off, bots and"
Write-Host '   barge countdown (gear button on each mode), review status and updates.'
Write-Host "   Settings files: $Win64\Config.<mode>.ini  (rV Modes edits these for you)"
Write-Host '   The folder you ran setup from (with kit\) is not used by the server - you can delete it.'
Stop-Transcript | Out-Null
if (-not $Unattended) { Read-Host 'Press Enter to close' }
