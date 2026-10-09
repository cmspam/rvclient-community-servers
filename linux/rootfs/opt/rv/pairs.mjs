// Server pairs: an instant next match for the chosen modes (web page "Pair" switch, `rv swap on <mode>`;
// RV_SWAP=solo,duos sets the first choice when a server starts for the first time).
//
// Each chosen mode that is switched on runs as two servers instead of one, both inside this container,
// each in its own network namespace with its own copy of the server folder (data/swap/<mode>-a and -b).
// Only one of the two is connected: the public game port of the mode (UDP) is forwarded to it, and only it
// can reach the internet. The other one starts, waits in its lobby without any network (it never talks to
// the backend) and takes over a few seconds after the active server's round is over, so the next match
// starts at once; the old one restarts and becomes the waiting one. The forwarding rewrites each packet's
// address without connection tracking, so a swap applies to the very next packet. Both copies keep the
// server's identity, so to the backend each mode is still one server.
//
// Backend: only the main supervisor's node agent talks to the backend. The pair servers' agents are answered
// inside their own process; the main one reports the paired modes as running (with the active server's
// state) and carries out the backend's commands for them (linux-shim.mjs). Server kit updates go into the
// main server folder and reach each pair server while it is the waiting one.
//
// Health: a server that starts with parts of the map missing is not used (it is restarted while it
// waits; the active one is swapped out), and so is a start that froze, stalled or takes too long, or a
// server that hangs once it is up. The supervisors' own health checks are off in the pair servers (they
// judge by the backend's row, which both servers of a pair share); this controller watches each server's
// own trace instead: a crash ("[FATAL]", or the process ending), a match running longer than any match
// (30 min), a flood of caught faults.
// If the waiting server is not ready when a match ends, nothing swaps and the server restarts as usual.
//
// Modes: modes.json stays the owner's choice of modes. Where pairs can run, the main supervisor reads
// modes.main.json instead: the same, without the modes running as pairs. Pairs are switched on and off while
// the container runs: a mode that becomes a pair closes in the main supervisor after its current match and
// starts as a pair once its server is gone; a pair that is switched off stops and the main supervisor runs
// the mode again.
//
// The container needs the host network and the rights to set up network namespaces and nftables:
// Network=host, AddCapability=NET_ADMIN SYS_ADMIN (Podman also SecurityLabelDisable=true); SYS_RESOURCE for the
// waiting servers' low CPU priority. Settings:
//   RV_SWAP                   modes to run as pairs on a server's first start: solo,duos,... or all
//   RV_SWAP_ROUND_END_DELAY_SEC  seconds after Server.dll's "round over" before the swap (default 5)
//   RV_SWAP_BOOT_LIMIT_SEC    a start not joinable after this long is restarted (default 360)
// A mode that cannot run as a pair (e.g. missing rights) runs as a single server, as without RV_SWAP.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import { DATA, SERVER, MODES, GAME_EXE, readJson, writeJson, readState, updateState } from './lib.mjs';

const SWAP_DIR = join(DATA, 'swap');
const STATE = join(SWAP_DIR, 'active.json');
const STATUS = join(SWAP_DIR, 'status.json');   // the controller's view, for `rv swap status`
const RV = new URL('./rv.mjs', import.meta.url).pathname;
const env = process.env;
const ROUND_END_DELAY_MS = (Number(env.RV_SWAP_ROUND_END_DELAY_SEC) || 5) * 1000;
const BOOT_LIMIT_MS = (Number(env.RV_SWAP_BOOT_LIMIT_SEC) || 360) * 1000;
const STUCK_MATCH_MS = 30 * 60 * 1000;   // like the supervisor's stuckMatchMin
const FAULTS_PER_MIN = 300;              // like the supervisor's faultsPerMin, for 3 minutes
const STUCK = new Set(['match running longer than any match', 'fault flood']);
const SIDES = ['a', 'b'];
const other = s => (s === 'a' ? 'b' : 'a');

// Modes listed in RV_SWAP (or all), by key.
export function listedModes(value = env.RV_SWAP) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || /^(0|off|no|false)$/.test(v)) return [];
    if (v === 'all') return MODES.map(m => m.key);
    return v.split(/[\s,]+/).filter(k => MODES.some(m => m.key === k));
}

// ---- the owner's choice ----
const SUP = join(SERVER, 'Rumbleverse', 'Binaries', 'Win64', 'RVSupervisor');
export const USER_MODES = join(SUP, 'modes.json');      // the owner's choice of modes
const MAIN_MODES = join(SUP, 'modes.main.json');        // what the main supervisor runs (without the pairs)
function modesFile(root) { return join(root, 'server', 'Rumbleverse', 'Binaries', 'Win64', 'RVSupervisor', 'modes.json'); }

// Modes chosen to run as pairs (when they are switched on). RV_SWAP gives the first value.
export function swapModes() {
    const st = readState();
    if (Array.isArray(st.swapModes)) return st.swapModes.filter(k => MODES.some(m => m.key === k));
    return listedModes();
}
export function setSwapMode(key, on) {
    const m = MODES.find(x => x.key === key);
    if (!m) throw new Error(`Unknown mode "${key}" (solo, playground, duos, trios, squads).`);
    const cur = new Set(swapModes());
    if (on) cur.add(m.key); else cur.delete(m.key);
    updateState({ swapModes: MODES.map(x => x.key).filter(k => cur.has(k)) });
    return `${m.label} ${on ? 'runs as a server pair' : 'runs as a single server'} (applies within a few seconds; a mode becoming a pair finishes its current match first).`;
}

// ---- checks ----
function sh(cmd, args, opts = {}) { return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString(); }
// Can this container run pairs? { ok, reason }
export function pairsAvailable() {
    if (env.RV_PAIR) return { ok: false, reason: 'this is a server of a pair' };
    try { sh('ip', ['netns', 'list']); } catch { return { ok: false, reason: 'the image has no "ip netns" (update the image)' }; }
    try { sh('nft', ['list', 'tables']); } catch { return { ok: false, reason: 'the container needs the rights for it (AddCapability=NET_ADMIN SYS_ADMIN, see the README)' }; }
    let fwd = '0'; try { fwd = fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim(); } catch { /* */ }
    if (fwd !== '1') return { ok: false, reason: 'IP forwarding is off on this host (net.ipv4.ip_forward=1)' };
    return { ok: true, reason: '' };
}

function uplink() {
    const r = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map(l => l.split('\t'));
    const d = r.find(f => f[1] === '00000000');
    if (!d) throw new Error('no default route');
    return d[0];
}

// ---- one server of a pair ----
function server(mode, side) {
    const k = MODES.findIndex(m => m.key === mode.key), n = k * 2 + (side === 'b' ? 1 : 0) + 1;
    const dir = join(SWAP_DIR, `${mode.key}-${side}`);
    return {
        mode, side, name: `${mode.key}-${side}`, dir, ns: `rv-${mode.key}-${side}`,
        hostIf: `rvh${k}${side}`, peerIf: `rvp${k}${side}`, hostIp: `10.91.${n}.1`, ip: `10.91.${n}.2`,
        win64: join(dir, 'server', 'Rumbleverse', 'Binaries', 'Win64'),
        trace: join(dir, 'server', 'Rumbleverse', 'Binaries', 'Win64', `crash_trace_${mode.id}.log`),
    };
}

// A copy of the main server folder: reflinked where the filesystem can, otherwise the game content
// (large, never written) hard-linked and everything else copied.
function copyTree(src, dest, log) {
    try { sh('cp', ['-a', '--reflink=always', src, dest]); return 'reflink'; } catch { fs.rmSync(dest, { recursive: true, force: true }); }
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
        const s = join(src, e), d = join(dest, e);
        if (e === 'Content' && src.endsWith('Rumbleverse')) sh('cp', ['-al', s, d]);
        else if (e === 'Rumbleverse' && fs.statSync(s).isDirectory()) copyTree(s, d, log);
        else sh('cp', ['-a', s, d]);
    }
    return 'hard links';
}
// Server kit updates install into the main server folder; a pair server gets them while it is the waiting
// one (pairs.mjs stops it, brings its folder up to the main one's files and starts it again). Per-server
// files (settings, modes, traces, logs) are not touched; a file counts as changed by size and time.
const OWN_FILES = /^(_updates|Rumbleverse\/Saved)(\/|$)|(^|\/)crash_trace_[^/]*$|\.log$|\/Config\.[a-z]+\.ini$|\/RVSupervisor\/(ds-instances\.json|modes[^/]*\.json)[^/]*$|\.rv-new-\d+$/;
const kitOf = dir => { try { return fs.readFileSync(join(dir, 'rv-server.version'), 'utf8').trim(); } catch { return ''; } };
function syncKit(sv) {
    const dest = join(sv.dir, 'server');
    let n = 0;
    const walk = rel => {
        for (const e of fs.readdirSync(join(SERVER, rel), { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (OWN_FILES.test(r) || r === 'rv-server.version') continue;
            if (e.isDirectory()) { fs.mkdirSync(join(dest, r), { recursive: true }); walk(r); continue; }
            if (!e.isFile()) continue;
            const a = fs.statSync(join(SERVER, r));
            let b = null; try { b = fs.statSync(join(dest, r)); } catch { /* new file */ }
            if (b && b.size === a.size && Math.trunc(b.mtimeMs) === Math.trunc(a.mtimeMs)) continue;
            const tmp = join(dest, `${r}.rv-new-${process.pid}`);
            sh('cp', ['-p', '--reflink=auto', join(SERVER, r), tmp]);
            fs.renameSync(tmp, join(dest, r));
            n++;
        }
    };
    walk('');
    fs.copyFileSync(join(SERVER, 'rv-server.version'), join(dest, 'rv-server.version'));
    return n;
}

function prepareCopy(sv, log) {
    if (!fs.existsSync(join(sv.win64, GAME_EXE))) {
        fs.rmSync(sv.dir, { recursive: true, force: true });
        fs.mkdirSync(sv.dir, { recursive: true });
        const how = copyTree(SERVER, join(sv.dir, 'server'), log);
        for (const d of ['wine', 'state', 'addons']) if (fs.existsSync(join(DATA, d))) sh('cp', ['-a', '--reflink=auto', join(DATA, d), join(sv.dir, d)]);
        fs.rmSync(join(sv.dir, 'state', 'control.sock'), { force: true });
        const st = join(sv.dir, 'state', 'rv.json'), j = readJson(st, null);
        if (j) { delete j.pairedModes; delete j.swapModes; writeJson(st, j); }
        for (const f of fs.readdirSync(sv.win64)) if (/^crash_trace_.*\.log$/.test(f)) fs.rmSync(join(sv.win64, f), { force: true });   // its own history only
        log(`[pairs] ${sv.name}: server folder copied (${how})`);
    }
    // Settings and add-ons follow the main server at every container start.
    const main = join(SERVER, 'Rumbleverse', 'Binaries', 'Win64');
    for (const f of [`Config.${sv.mode.key}.ini`]) if (fs.existsSync(join(main, f))) fs.copyFileSync(join(main, f), join(sv.win64, f));
    if (fs.existsSync(join(DATA, 'addons'))) { fs.rmSync(join(sv.dir, 'addons'), { recursive: true, force: true }); sh('cp', ['-a', join(DATA, 'addons'), join(sv.dir, 'addons')]); }
    const modes = Object.fromEntries(MODES.map(m => [m.key, m.key === sv.mode.key]));
    writeJson(modesFile(sv.dir), modes, 0o644);
    const instFile = join(sv.win64, 'RVSupervisor', 'ds-instances.json'), inst = readJson(instFile, null);
    if (inst && (inst.matchEndRelaunchSec !== 0 || inst.launchGapSec !== 0 || inst.modesFile !== 'modes.json' || inst.healer !== false)) {
        inst.matchEndRelaunchSec = 0; inst.launchGapSec = 0;   // only one server per copy: no waits
        inst.modesFile = 'modes.json';
        // Its health checks judge a server by the backend's row for its address and port, which both servers
        // of a pair share, and keep their state across the hours a waiting server is offline (a server that
        // had just taken over was restarted as "stuck ending the match for 12 min"). This controller checks
        // the pair servers itself, from each one's own trace.
        inst.healer = false;
        writeJson(instFile, inst, 0o644);
    }
    fs.mkdirSync(join(sv.dir, 'logs'), { recursive: true });
}

// Network namespace with a veth link to this one; DNS from the host's real resolvers.
function nameservers() {
    let list = [];
    try { list = fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n').map(l => /^nameserver\s+(\S+)/.exec(l)?.[1]).filter(Boolean); } catch { /* */ }
    list = list.filter(ip => !/^127\.|^::1$/.test(ip));
    return list.length ? list : ['1.1.1.1', '8.8.8.8'];
}
function prepareNet(sv) {
    try { sh('ip', ['netns', 'del', sv.ns]); } catch { /* not there */ }
    try { sh('ip', ['link', 'del', sv.hostIf]); } catch { /* not there */ }
    sh('ip', ['netns', 'add', sv.ns]);
    sh('ip', ['link', 'add', sv.hostIf, 'type', 'veth', 'peer', 'name', sv.peerIf]);
    sh('ip', ['link', 'set', sv.peerIf, 'netns', sv.ns]);
    sh('ip', ['-n', sv.ns, 'link', 'set', sv.peerIf, 'name', 'eth0']);
    sh('ip', ['addr', 'add', `${sv.hostIp}/30`, 'dev', sv.hostIf]);
    sh('ip', ['link', 'set', sv.hostIf, 'up']);
    sh('ip', ['-n', sv.ns, 'addr', 'add', `${sv.ip}/30`, 'dev', 'eth0']);
    sh('ip', ['-n', sv.ns, 'link', 'set', 'lo', 'up']);
    sh('ip', ['-n', sv.ns, 'link', 'set', 'eth0', 'up']);
    sh('ip', ['-n', sv.ns, 'route', 'add', 'default', 'via', sv.hostIp]);
    fs.mkdirSync(`/etc/netns/${sv.ns}`, { recursive: true });
    fs.writeFileSync(`/etc/netns/${sv.ns}/resolv.conf`, nameservers().map(n => `nameserver ${n}\n`).join(''));
}

// All pairs' forwarding in one table: outbound NAT for the active servers, the game ports forwarded
// statelessly to them, the waiting servers cut off.
export function rules(pairs, active, pub, dev) {
    const all = pairs.flatMap(p => SIDES.map(s => p[s].ip));
    const lines = [];
    for (const p of pairs) {
        const on = p[active[p.mode.key]], off = p[other(active[p.mode.key])], port = p.mode.port;
        lines.push({ raw: `iifname "${dev}" ip daddr ${pub} udp dport ${port} notrack`, raw2: `ip saddr { ${p.a.ip}, ${p.b.ip} } udp sport ${port} notrack`,
            dnat: `iifname "${dev}" ip daddr ${pub} udp dport ${port} ip daddr set ${on.ip}`,
            snat: `oifname "${dev}" ip saddr ${on.ip} udp sport ${port} ip saddr set ${pub}`, off: off.ip });
    }
    return `table ip rvpairs
delete table ip rvpairs
table ip rvpairs {
    chain rv_raw {
        type filter hook prerouting priority raw; policy accept;
${lines.map(l => `        ${l.raw}\n        ${l.raw2}`).join('\n')}
    }
    chain rv_dnat {
        type filter hook prerouting priority mangle; policy accept;
${lines.map(l => `        ${l.dnat}`).join('\n')}
    }
    chain rv_forward {
        type filter hook forward priority -10; policy accept;
${lines.map(l => `        ip saddr ${l.off} drop\n        ip daddr ${l.off} drop`).join('\n')}
        ip saddr { ${all.join(', ')} } accept
        ip daddr { ${all.join(', ')} } ct state established,related accept
    }
    chain rv_snat {
        type filter hook postrouting priority srcnat; policy accept;
${lines.map(l => `        ${l.snat}`).join('\n')}
    }
    chain rv_nat {
        type nat hook postrouting priority srcnat + 1; policy accept;
        oifname "${dev}" ip saddr { ${all.join(', ')} } masquerade
    }
}
`;
}

// ---- watching a server ----
const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };
function readRange(f, from, to) {
    try {
        const fd = fs.openSync(f, 'r');
        try { const b = Buffer.alloc(Math.max(0, to - from)); fs.readSync(fd, b, 0, b.length, from); return b.toString('latin1'); }
        finally { fs.closeSync(fd); }
    } catch { return ''; }
}
// The game server process of a server: its instance, running in its own folder.
function gamePid(sv) {
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(`RVInstance=${sv.mode.id}`)) continue;
            if (fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(sv.dir + '/')) return Number(pid);
        } catch { /* gone */ }
    }
    return 0;
}
// A process that is going away. Server.dll's "*** CRASH ***" lines are often caught faults the server
// survives ("[CRASHGUARD] ... skipping"); only "[FATAL]" means it is dying.
const ENDED = /terminating for restart|\[FATAL\]|boot attempts exhausted/;
function missingSubLevels(boot) {
    const m = /forced sub-levels settled[^\n]*?(\d+) not loaded/.exec(boot);
    return m ? Number(m[1]) : 0;
}
// Process details for the web page / rv status: memory, uptime, connected players (Server.dll's KEEPALIVE).
function details(sv) {
    const pid = gamePid(sv);
    if (!pid) return { running: false };
    const d = { running: true };
    try {
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        d.rssMb = Math.round(Number(/^VmRSS:\s+(\d+)/m.exec(st)?.[1] || 0) / 1024);
        d.swapMb = Math.round(Number(/^VmSwap:\s+(\d+)/m.exec(st)?.[1] || 0) / 1024);
        const start = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]) / 100;
        d.uptimeSec = Math.round(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) - start);
    } catch { /* gone */ }
    const s = size(sv.trace), tail = readRange(sv.trace, Math.max(0, s - 200000), s);
    const m = [...tail.matchAll(/\[KEEPALIVE\][^\n]*conns=(\d+)/g)].pop();
    d.players = m ? Number(m[1]) : 0;
    return d;
}
// CPU priority: the waiting server of a pair runs at the lowest priority (nice 19), so that its starts never
// slow down a match on the box; the active one at the normal priority (0). Every thread of the game process
// is set (Linux priorities are per thread). Going back to 0 needs no extra rights: the pair servers are
// started with a nice limit (RLIMIT_NICE) that allows it. Setting that limit needs CAP_SYS_RESOURCE; without
// it, every server keeps the normal priority.
const PRLIMIT = (() => {
    const f = ['/usr/bin/prlimit', '/bin/prlimit'].find(x => fs.existsSync(x));
    try { if (f) { execFileSync(f, ['--nice=20:20', 'true'], { stdio: 'ignore' }); return f; } } catch { /* not allowed */ }
    return '';
})();
function setNice(pid, nice) {
    if (!pid) return;
    let tids = [];
    try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { return; }
    for (const t of tids) { try { if (os.getPriority(Number(t)) !== nice) os.setPriority(Number(t), nice); } catch { /* gone, or no rights */ } }
}
function procState(pid) { try { return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || ''; } catch { return ''; } }

function createWatch(sv, log) {
    // Where the trace ended when the current game process appeared: a boot counts only when its
    // "DllMain: begin" comes after that, so a new process is never judged by the previous one's lines.
    // A process that is already there when the watch begins is judged from where the trace ended then.
    const start = size(sv.trace);
    let seen = { pid: 0, offset: start }, watching = false, boot = {}, up = {}, restartedPid = 0;
    const w = {
        sv,
        observe() {
            const pid = gamePid(sv);
            if (pid && pid !== seen.pid) seen = { pid, offset: watching ? size(sv.trace) : start };
            watching = true;
            return pid;
        },
        // the old process's lines no longer count (after a swap, the old active server restarts)
        forget() { seen = { pid: -1, offset: size(sv.trace) }; },
        currentBoot() {
            const s = size(sv.trace), from = Math.max(0, s - 4000000), text = readRange(sv.trace, from, s);
            const i = text.lastIndexOf('DllMain: begin');
            if (i < 0 || from + Buffer.byteLength(text.slice(0, i), 'latin1') < seen.offset) return '';
            return text.slice(i);
        },
        ready() {
            if (!gamePid(sv)) return false;
            const b = w.currentBoot();
            return b.includes('reporting joinable') && !ENDED.test(b) && !missingSubLevels(b);
        },
        kill(why) {
            const pid = gamePid(sv);
            if (!pid) return;
            log(`[pairs] ${sv.name}: ${why} - restarting it`);
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        },
        // A start that came up with parts of the map missing, froze, stalled or takes too long.
        checkHealth() {
            const pid = gamePid(sv), b = w.currentBoot(), now = Date.now();
            if (!pid) { boot = {}; return; }
            if (b.includes('reporting joinable')) {
                boot = {};
                // up: it writes a KEEPALIVE line every 30 s, in a match or waiting
                if (up.pid !== pid) up = { pid, size: size(sv.trace), changed: now, stopped: 0 };
                const usz = size(sv.trace);
                if (usz !== up.size) { up.size = usz; up.changed = now; }
                up.stopped = procState(pid) === 'T' ? (up.stopped || now) : 0;
                const hung = up.stopped && now - up.stopped >= 15000 ? 'it froze (process stopped)'
                    : now - up.changed >= 120000 ? `its trace has been silent for ${Math.round((now - up.changed) / 1000)}s (hung)` : '';
                if (hung) { up = {}; w.kill(hung); return; }
                const n = missingSubLevels(b);
                if (n && !ENDED.test(b) && restartedPid !== pid) { restartedPid = pid; w.kill(`came up with ${n} part(s) of the map missing`); }
                return;
            }
            if (boot.pid !== pid) boot = { pid, since: now, size: size(sv.trace), changed: now, stopped: 0 };
            const sz = size(sv.trace);
            if (sz !== boot.size) { boot.size = sz; boot.changed = now; }
            boot.stopped = procState(pid) === 'T' ? (boot.stopped || now) : 0;
            let why = '';
            if (boot.stopped && now - boot.stopped >= 15000) why = 'its start froze (process stopped)';
            else if (now - boot.changed >= 150000) why = `its start made no progress for ${Math.round((now - boot.changed) / 1000)}s`;
            else if (now - boot.since >= BOOT_LIMIT_MS) why = `not joinable ${Math.round(BOOT_LIMIT_MS / 60000)} minutes after it started`;
            if (why) { boot = {}; w.kill(why); }
        },
    };
    return w;
}

// ---- running the pairs ----
function runServer(sv, log, delayMs) {
    const proc = { child: null, stopping: false, timer: null };
    const start = () => {
        if (proc.stopping) return;
        const cmd = ['ip', 'netns', 'exec', sv.ns, process.execPath, RV, 'run'];
        const child = spawn(PRLIMIT || cmd[0], PRLIMIT ? ['--nice=20:20', ...cmd] : cmd.slice(1), {
            env: { ...env, RV_DATA: sv.dir, WINEPREFIX: join(sv.dir, 'wine'), RV_WEBUI: 'off', RV_SWAP: '', RV_PAIR: sv.name },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.child = child;
        const pipe = stream => {
            let buf = '';
            stream.on('data', d => {
                buf += d; let k;
                while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line) console.log(`[${sv.name}] ${line}`); }
            });
        };
        pipe(child.stdout); pipe(child.stderr);
        child.on('exit', (code, sig) => {
            proc.child = null;
            if (proc.stopping) return;
            log(`[pairs] ${sv.name}: exited (${code ?? sig}) - starting again in 10s`);
            proc.timer = setTimeout(start, 10000);
        });
    };
    proc.timer = setTimeout(start, delayMs);
    proc.stop = () => new Promise(res => {
        proc.stopping = true; clearTimeout(proc.timer);
        const c = proc.child;
        if (!c) return res();
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } res(); }, 60000);
        c.once('exit', () => { clearTimeout(t); res(); });
        c.kill('SIGTERM');
    });
    return proc;
}

// The main supervisor reads modes.main.json where pairs can run. Called before it starts. Earlier versions
// switched paired modes off in modes.json itself; those are switched on again there (the owner's choice).
export function prepareModes(log) {
    const inst = readJson(join(SUP, 'ds-instances.json'), null), user = readJson(USER_MODES, null);
    if (!inst || !user) return false;
    const st = readState();
    if (!st.modesSplit) {
        for (const k of st.pairedModes || []) user[k] = true;
        writeJson(USER_MODES, user, 0o644);
        updateState({ modesSplit: true });
    }
    if (!fs.existsSync(MAIN_MODES)) writeJson(MAIN_MODES, Object.fromEntries(MODES.map(m => [m.key, !!user[m.key] && !swapModes().includes(m.key)])), 0o644);
    if (inst.modesFile !== 'modes.main.json') {
        inst.modesFile = 'modes.main.json';
        writeJson(join(SUP, 'ds-instances.json'), inst, 0o644);
        log('[pairs] the main supervisor now reads modes.main.json (modes.json without the server pairs)');
    }
    return true;
}
// Where pairs cannot run: the main supervisor reads the owner's modes.json again.
export function releaseModes(log) {
    const inst = readJson(join(SUP, 'ds-instances.json'), null);
    if (inst && inst.modesFile === 'modes.main.json') {
        inst.modesFile = 'modes.json';
        writeJson(join(SUP, 'ds-instances.json'), inst, 0o644);
        log('[pairs] pairs cannot run here - the main supervisor reads modes.json');
    }
    updateState({ pairedModes: [] });
}

// The main supervisor's own game server of a mode (Wine process of that instance in the main folder).
function mainRuns(mode) {
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(`RVInstance=${mode.id}`)) continue;
            if (fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(SERVER + '/')) return true;
        } catch { /* gone */ }
    }
    return false;
}

// Runs the pairs the owner chose and keeps them in line with modes.json and the "Pair" setting.
// Returns { stop }.
export function createPairs({ log = console.log, publicIp } = {}) {
    const pub = publicIp || readState().publicIp || env.RV_PUBLIC_IP;
    const dev = uplink();
    fs.mkdirSync(SWAP_DIR, { recursive: true });
    const active = readJson(STATE, {});
    const running = new Map();   // mode key -> { p, procs, ctl }
    let stopped = false, tick = 0, waitingLogged = new Set(), syncBusy = false;   // one kit update at a time

    const apply = () => {
        const pairs = [...running.values()].map(r => r.p);
        if (pairs.length) execFileSync('nft', ['-f', '-'], { input: rules(pairs, active, pub, dev) });
        else { try { execFileSync('nft', ['delete', 'table', 'ip', 'rvpairs'], { stdio: 'ignore' }); } catch { /* none */ } }
        writeJson(STATE, active, 0o644);
        updateState({ pairedModes: [...running.keys()] });
    };
    const startPair = mode => {
        const p = { mode, a: server(mode, 'a'), b: server(mode, 'b') };
        for (const sd of SIDES) {
            prepareCopy(p[sd], log);
            // nothing of the pair runs yet: both servers start on the main server's kit
            const from = kitOf(join(p[sd].dir, 'server')), to = kitOf(SERVER);
            if (to && from !== to) log(`[pairs] ${p[sd].name}: server kit ${from || 'unknown'} -> ${to} (${syncKit(p[sd])} file(s))`);
            prepareNet(p[sd]);
        }
        if (!active[mode.key]) active[mode.key] = 'a';
        const ctl = { p, w: { a: createWatch(p.a, log), b: createWatch(p.b, log) }, off: size(p[active[mode.key]].trace), waiting: '', roundOverAt: 0, goneSince: 0, wasUp: false };
        running.set(mode.key, { p, ctl, procs: {} });
        apply();
        // the active server starts first; the waiting one a minute and a half later
        running.get(mode.key).procs = { [active[mode.key]]: runServer(p[active[mode.key]], log, 0), [other(active[mode.key])]: runServer(p[other(active[mode.key])], log, 90000) };
        log(`[pairs] ${mode.label}: runs as a pair (active ${active[mode.key]}, the other one waits)`);
    };
    const stopPair = async key => {
        const r = running.get(key);
        if (!r) return;
        running.delete(key);
        apply();
        await Promise.all(Object.values(r.procs).map(x => x.stop()));
        for (const sd of SIDES) {
            try { sh('ip', ['netns', 'del', r.p[sd].ns]); } catch { /* */ }
            try { sh('ip', ['link', 'del', r.p[sd].hostIf]); } catch { /* */ }
        }
        log(`[pairs] ${r.p.mode.label}: pair stopped`);
    };

    // modes.json + the Pair setting -> what runs where
    let busy = false;
    const reconcile = async () => {
        if (busy) return;
        busy = true;
        try {
            const user = readJson(USER_MODES, {}), chosen = new Set(swapModes());
            const want = MODES.filter(m => user[m.key] && chosen.has(m.key));
            // pairs to stop first: the main supervisor may only run the mode once its pair is gone
            for (const key of [...running.keys()]) if (!want.some(m => m.key === key)) await stopPair(key);
            const mainWant = Object.fromEntries(MODES.map(m => [m.key, !!user[m.key] && !chosen.has(m.key) && !running.has(m.key)]));
            const cur = readJson(MAIN_MODES, {});
            if (MODES.some(m => !!cur[m.key] !== mainWant[m.key])) writeJson(MAIN_MODES, mainWant, 0o644);
            for (const m of want) {
                if (running.has(m.key)) continue;
                if (mainRuns(m)) {   // closes after its current match (switched off in modes.main.json)
                    if (!waitingLogged.has(m.key)) { waitingLogged.add(m.key); log(`[pairs] ${m.label}: becomes a pair once its current server has finished its match`); }
                    continue;
                }
                waitingLogged.delete(m.key);
                try { startPair(m); } catch (e) { log(`[pairs] ${m.label}: could not start the pair: ${e.message}`); await stopPair(m.key); }
            }
            updateState({ pairedModes: [...running.keys()] });
        } finally { busy = false; }
    };

    // Settings written into the main server's Config.<mode>.ini only (a backend "settings" command) reach
    // both servers of the pair; each uses them from its next start.
    const followSettings = p => {
        const f = `Config.${p.mode.key}.ini`, main = join(SERVER, 'Rumbleverse', 'Binaries', 'Win64', f);
        let m; try { m = fs.statSync(main).mtimeMs; } catch { return; }
        for (const sd of SIDES) {
            const dst = join(p[sd].win64, f);
            let d = 0; try { d = fs.statSync(dst).mtimeMs; } catch { /* */ }
            if (m > d) { const tmp = `${dst}.rv-new-${process.pid}`; fs.copyFileSync(main, tmp); fs.renameSync(tmp, dst); }
        }
    };
    // A kit update for the waiting server: stop it, bring its folder up to date, start it again.
    const updateWaiting = (c, sd) => {
        const r = running.get(c.p.mode.key), sv = c.p[sd];
        if (!r?.procs[sd]) return;
        syncBusy = true;
        (async () => {
            const from = kitOf(join(sv.dir, 'server')) || 'unknown', to = kitOf(SERVER);
            await r.procs[sd].stop();
            try {
                const n = syncKit(sv);
                prepareCopy(sv, log);
                log(`[pairs] ${sv.name}: server kit ${from} -> ${to} (${n} file(s)) while it was the waiting server`);
            } catch (e) { log(`[pairs] ${sv.name}: server kit update failed (${e.message}) - it keeps ${from}`); }
            if (running.get(c.p.mode.key) === r) r.procs[sd] = runServer(sv, log, 0);
        })().catch(e => log(`[pairs] ${e.message}`)).finally(() => { syncBusy = false; });
    };

    const describe = (w, isActive) => w.ready() ? (isActive ? 'up' : 'in its lobby') : gamePid(w.sv) ? (isActive && w.currentBoot().includes('reporting joinable') ? 'up' : 'starting') : 'not running';
    const loop = async () => {
        while (!stopped) {
            if (tick % 2 === 0) await reconcile().catch(e => log(`[pairs] ${e.message}`));
            await new Promise(r => setTimeout(r, 1000));
            tick++;
            const ctls = [...running.values()].map(r => r.ctl);
            if (tick % 5 === 0) {
                try {
                    writeJson(STATUS, { at: new Date().toISOString(), modes: Object.fromEntries(ctls.map(c => {
                        const act = active[c.p.mode.key], sb = other(act);
                        return [c.p.mode.key, { label: c.p.mode.label, active: act, activeState: describe(c.w[act], true), waiting: sb, waitingState: describe(c.w[sb], false),
                            activeDetails: details(c.p[act]), waitingDetails: details(c.p[sb]), restarts: c.restarts || 0 }];
                    })) }, 0o644);
                } catch { /* */ }
            }
            for (const c of ctls) {
                const key = c.p.mode.key, act = active[key], sb = other(act), A = c.w[act], B = c.w[sb];
                A.observe(); B.observe();
                const f = c.p[act].trace, s = size(f);
                if (s < c.off) c.off = 0;
                if (s > c.off) {
                    const text = readRange(f, c.off, s); c.off = s;
                    if (!c.waiting && /\[ROUNDEND\] round over/.test(text) && !c.roundOverAt) c.roundOverAt = Date.now();
                    if (!c.waiting && /terminating for restart/.test(text)) c.waiting = 'match over';
                    else if (!c.waiting && /\[FATAL\]|boot attempts exhausted/.test(text)) c.waiting = 'crashed';
                    else if (!c.waiting && c.wasUp && /DllMain: begin/.test(text)) c.waiting = 'restarted';
                    // the active server's own match state (the supervisors' health checks are off in pairs)
                    for (const m of text.matchAll(/\[FLOW\] game flow -?\d+ -> (-?\d+)/g)) { c.flow = Number(m[1]); c.flowSince = Date.now(); }
                    c.faults = (c.faults || 0) + (text.match(/\[CRASHGUARD\]/g) || []).length;
                }
                if (!c.wasUp && A.ready()) c.wasUp = true;
                if (!c.waiting && c.roundOverAt && Date.now() - c.roundOverAt >= ROUND_END_DELAY_MS) c.waiting = 'round over';
                if (!c.waiting && c.wasUp) {
                    c.goneSince = gamePid(c.p[act]) ? 0 : (c.goneSince || Date.now());
                    if (c.goneSince && Date.now() - c.goneSince > 3000) c.waiting = 'process ended';
                }
                if (!c.waiting && missingSubLevels(A.currentBoot()) && A.currentBoot().includes('reporting joinable')) c.waiting = 'map incomplete';
                if (!c.waiting && c.flow === 3 && Date.now() - c.flowSince >= STUCK_MATCH_MS) c.waiting = 'match running longer than any match';
                if (tick % 60 === 0) {   // caught faults per minute: a broken match faults every frame
                    c.floodMin = (c.faults || 0) >= FAULTS_PER_MIN ? (c.floodMin || 0) + 1 : 0;
                    c.faults = 0;
                    if (!c.waiting && c.floodMin >= 3) c.waiting = 'fault flood';
                }
                if (tick % 5 === 0) { B.checkHealth(); if (!c.waiting) A.checkHealth(); followSettings(c.p); setNice(gamePid(c.p[act]), 0); if (PRLIMIT) setNice(gamePid(c.p[sb]), 19); }
                if (tick % 30 === 0 && !syncBusy && kitOf(SERVER) && kitOf(SERVER) !== kitOf(join(c.p[sb].dir, 'server'))) updateWaiting(c, sb);
                if (!c.waiting) continue;
                if (B.ready()) {
                    setNice(gamePid(c.p[sb]), 0);
                    const prev = active[key];
                    active[key] = sb;
                    try { apply(); } catch (e) { active[key] = prev; log(`[pairs] ${c.p.mode.label}: could not swap: ${e.message}`); continue; }
                    A.forget();
                    log(`[pairs] ${c.p.mode.label}: ${c.waiting} on ${act} - swapped: ${sb} is active, ${act} restarts and waits`);
                    if (STUCK.has(c.waiting)) A.kill(c.waiting);
                    c.off = size(c.p[sb].trace); c.waiting = ''; c.roundOverAt = 0; c.goneSince = 0; c.wasUp = true; c.restarts = (c.restarts || 0) + 1; c.flow = null; c.faults = 0; c.floodMin = 0;
                } else if (c.waiting === 'map incomplete') {
                    A.checkHealth(); c.waiting = ''; c.roundOverAt = 0;
                } else if (STUCK.has(c.waiting)) {
                    A.kill(`${c.waiting} (${sb} was not ready)`); c.waiting = ''; c.roundOverAt = 0; c.flow = null; c.floodMin = 0;
                } else if (A.ready()) {
                    log(`[pairs] ${c.p.mode.label}: ${c.waiting} on ${act} - ${sb} was not ready; ${act} restarted and stays active`);
                    c.waiting = ''; c.roundOverAt = 0; c.goneSince = 0; c.wasUp = true;
                }
            }
        }
    };
    loop().catch(e => log(`[pairs] controller stopped: ${e.message}`));

    return {
        stop: async () => {
            stopped = true;
            for (const key of [...running.keys()]) await stopPair(key);
            updateState({ pairedModes: [] });
        },
    };
}

// For the web page and `rv status`: the controller's view of each paired mode (null when no pairs run).
export function pairStatus() {
    const paired = readState().pairedModes || [];
    if (!paired.length) return null;
    const st = readJson(STATUS, null);
    return st && Date.now() - Date.parse(st.at) < 60000 ? st.modes : {};
}
export function restartActive(key) {
    const paired = readState().pairedModes || [];
    const mode = MODES.find(m => m.key === key && paired.includes(m.key));
    if (!mode) return false;
    const act = readJson(STATE, {})[key] || 'a';
    createWatch(server(mode, act), () => {}).kill('restart requested');
    return true;
}

// `rv swap status` / `rv swap restart <mode>` (restart the active server: the waiting one takes over) /
// `rv swap on|off <mode>` (the Pair setting)
export function pairsCli(args) {
    const [cmd, key] = args;
    if (cmd === 'on' || cmd === 'off') return console.log(setSwapMode(key, cmd === 'on'));
    const paired = readState().pairedModes || [];
    if (!paired.length) return console.log(`No modes run as pairs right now (chosen: ${swapModes().join(', ') || 'none'}).`);
    const st = readJson(STATUS, { modes: {} }), active = readJson(STATE, {});
    if (cmd === 'restart') {
        const mode = MODES.find(m => m.key === key && paired.includes(m.key));
        if (!mode) return console.log(`usage: rv swap restart <${paired.join('|')}>`);
        createWatch(server(mode, active[key] || 'a'), () => {}).kill('restart requested');
        return console.log(`${mode.label}: active server ${active[key] || 'a'} restarted (the waiting one takes over if it is in its lobby)`);
    }
    for (const k of paired) {
        const m = st.modes[k];
        console.log(m ? `${m.label}: active ${m.active} (${m.activeState}), waiting ${m.waiting} (${m.waitingState})` : `${k}: no status yet`);
    }
    if (st.at) console.log(`(as of ${st.at})`);
}
