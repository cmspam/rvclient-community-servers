# Host check for a would-be Rumbleverse community server (run it on the box over RDP, ~2 min).
# Measures what matters for a game server and prints a PASS / WARN / FAIL summary.
# Nothing is installed or changed; one temporary 512 MB file is written and deleted.
$ErrorActionPreference = 'SilentlyContinue'
$results = New-Object System.Collections.Generic.List[object]
function Add-Result($name, $value, $status, $note) { $results.Add([pscustomobject]@{ Check = $name; Result = $value; Status = $status; Note = $note }) }
function Line($t) { Write-Host $t -ForegroundColor Cyan }

Line "== Rumbleverse host check =="
# ---- System ----------------------------------------------------------------------------
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cores = (Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum
$logical = (Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$freeGB = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$diskGB = [math]::Round($disk.Size / 1GB); $diskFreeGB = [math]::Round($disk.FreeSpace / 1GB)
$os = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Host "CPU  : $($cpu.Name.Trim())  ($cores cores / $logical threads, rated $($cpu.MaxClockSpeed) MHz)"
Write-Host "RAM  : $ramGB GB ($freeGB GB free)"
Write-Host "Disk : C: $diskGB GB ($diskFreeGB GB free)"
Write-Host "OS   : $os"
Add-Result 'RAM' "$ramGB GB" ($(if ($ramGB -ge 15) {'PASS'} elseif ($ramGB -ge 7.5) {'OK'} else {'FAIL'})) '8 GB minimum for Solos, 16 GB for full lobbies + a 2nd mode'
Add-Result 'Disk free' "$diskFreeGB GB free of $diskGB" ($(if ($diskFreeGB -ge 25) {'PASS'} elseif ($diskFreeGB -ge 16) {'WARN'} else {'FAIL'})) 'game ~12 GB + updates/logs; 25 GB free is comfortable'
Add-Result 'CPU threads' "$logical" ($(if ($logical -ge 4) {'PASS'} elseif ($logical -ge 2) {'OK'} else {'FAIL'})) '2 minimum, 4 for full lobbies'

# ---- Single-core speed + consistency (noisy neighbours) ---------------------------------
Line "Single-core benchmark (10 runs)..."
$buf = New-Object byte[] (1MB); (New-Object Random 7).NextBytes($buf)
$sha = [Security.Cryptography.SHA256]::Create()
$runs = @()
for ($r = 0; $r -lt 10; $r++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt 150; $i++) { [void]$sha.ComputeHash($buf) }
    $runs += $sw.Elapsed.TotalMilliseconds
}
$best = [math]::Round(($runs | Measure-Object -Minimum).Minimum)
$worst = [math]::Round(($runs | Measure-Object -Maximum).Maximum)
$score = [math]::Round(150000 / $best)          # higher = faster (MB hashed per second)
$spread = [math]::Round(($worst - $best) / $best * 100)
Write-Host "Score: $score (best $best ms, worst $worst ms, spread $spread%)"
Add-Result 'Single-core score' "$score" ($(if ($score -ge 200) {'PASS'} elseif ($score -ge 150) {'WARN'} else {'FAIL'})) 'i5-14600KF 2400; our EU + USA East VPS score ~225 and run full lobbies fine; under 150 = too slow'
Add-Result 'Consistency' "$spread% spread" ($(if ($spread -le 25) {'PASS'} elseif ($spread -le 60) {'WARN'} else {'FAIL'})) 'big swings = overloaded host (noisy neighbours)'

# ---- Throttling under load (the NYC 800 MHz problem) ------------------------------------
Line "Full-load test (30 s, all cores) - checking the CPU keeps its speed..."
$jobs = 1..$logical | ForEach-Object { Start-Job { $end = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $end) { $x = 0; for ($i = 0; $i -lt 100000; $i++) { $x += $i } } } }
Start-Sleep 5
$perf = @()
for ($s = 0; $s -lt 5; $s++) {
    $v = (Get-Counter '\Processor Information(_Total)\% Processor Performance' -ErrorAction SilentlyContinue).CounterSamples.CookedValue
    if ($v) { $perf += $v }
    Start-Sleep 4
}
$jobs | Wait-Job -Timeout 20 | Out-Null; $jobs | Remove-Job -Force
if ($perf.Count) {
    $avgPerf = [math]::Round(($perf | Measure-Object -Average).Average)
    $effMHz = [math]::Round($cpu.MaxClockSpeed * $avgPerf / 100)
    Write-Host "Under load: $avgPerf% of rated speed (~$effMHz MHz)"
    Add-Result 'Speed under load' "$avgPerf% (~$effMHz MHz)" ($(if ($avgPerf -ge 85) {'PASS'} elseif ($avgPerf -ge 60) {'WARN'} else {'FAIL'})) 'below 60% = throttled (NYC dropped to ~25% = 800 MHz and lagged)'
} else { Add-Result 'Speed under load' 'counter not available' 'WARN' 'check the single-core score instead' }

# ---- Disk --------------------------------------------------------------------------------
Line "Disk test (512 MB write + read)..."
$tmp = Join-Path $env:TEMP 'rv-hostcheck.bin'
$data = New-Object byte[] (8MB); (New-Object Random 3).NextBytes($data)
$sw = [Diagnostics.Stopwatch]::StartNew()
$fs = [IO.File]::Create($tmp, 1MB, [IO.FileOptions]::WriteThrough)
for ($i = 0; $i -lt 64; $i++) { $fs.Write($data, 0, $data.Length) }
$fs.Close(); $w = [math]::Round(512 / $sw.Elapsed.TotalSeconds)
$sw = [Diagnostics.Stopwatch]::StartNew()
$rb = New-Object byte[] (8MB); $fs = [IO.File]::OpenRead($tmp); while ($fs.Read($rb, 0, $rb.Length) -gt 0) {}; $fs.Close()
$rd = [math]::Round(512 / $sw.Elapsed.TotalSeconds); Remove-Item $tmp -Force
Write-Host "Disk: write $w MB/s, read $rd MB/s"
Add-Result 'Disk speed' "write $w / read $rd MB/s" ($(if ($w -ge 150) {'PASS'} elseif ($w -ge 60) {'WARN'} else {'FAIL'})) 'under 60 MB/s = HDD-like, slow boots'

# ---- Network -----------------------------------------------------------------------------
Line "Network (ping NYC + internet, download test)..."
foreach ($t in @(@{n='NYC game servers'; h='185.150.190.30'}, @{n='Internet (1.1.1.1)'; h='1.1.1.1'})) {
    $p = Test-Connection -ComputerName $t.h -Count 10 -ErrorAction SilentlyContinue
    if ($p) {
        $ms = $p | ForEach-Object { if ($_.ResponseTime -ne $null) { $_.ResponseTime } else { $_.Latency } }
        $avg = [math]::Round(($ms | Measure-Object -Average).Average); $jit = [math]::Round((($ms | Measure-Object -Maximum).Maximum - ($ms | Measure-Object -Minimum).Minimum))
        Write-Host "$($t.n): avg $avg ms, jitter $jit ms"
        Add-Result "Ping $($t.n)" "avg $avg ms, jitter $jit ms" ($(if ($jit -le 15) {'PASS'} elseif ($jit -le 40) {'WARN'} else {'FAIL'})) 'high jitter = rubber-banding for players'
    } else { Add-Result "Ping $($t.n)" 'no reply' 'WARN' 'ICMP may be blocked by the host' }
}
try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $wc = New-Object Net.WebClient; $bytes = $wc.DownloadData('https://speed.cloudflare.com/__down?bytes=50000000')
    $mbps = [math]::Round($bytes.Length * 8 / 1MB / $sw.Elapsed.TotalSeconds)
    Write-Host "Download: $mbps Mbps"
    Add-Result 'Download speed' "$mbps Mbps" ($(if ($mbps -ge 100) {'PASS'} elseif ($mbps -ge 40) {'WARN'} else {'FAIL'})) 'upload is what players use - check the plan says 100+ Mbps'
} catch { Add-Result 'Download speed' 'test failed' 'WARN' $_.Exception.Message }

# ---- Summary -----------------------------------------------------------------------------
Write-Host ""
Line "== Summary =="
$results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
# @(...) - with exactly one match PowerShell 5.1 returns a single object whose .Count is empty,
# which made one FAIL read as zero ("good" verdict under a FAIL row).
$fails = @($results | Where-Object Status -eq 'FAIL').Count; $warns = @($results | Where-Object Status -eq 'WARN').Count
if ($fails) { Write-Host "Verdict: NOT suitable ($fails fail)" -ForegroundColor Red }
elseif ($warns) { Write-Host "Verdict: usable for a small test, watch the WARN items ($warns)" -ForegroundColor Yellow }
else { Write-Host "Verdict: good for a community server" -ForegroundColor Green }
$out = Join-Path $PSScriptRoot ("host-check-" + (Get-Date -Format 'yyyyMMdd_HHmm') + ".txt")
$results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Set-Content $out
Write-Host "Saved: $out"
