// Server pairs: an instant next match for the chosen modes (web page "Pair" switch, `rv swap on <mode>`;
// RV_SWAP=solo,duos sets the first choice when a server starts for the first time).
//
// Each chosen mode that is switched on runs as two servers instead of one. This controller starts their game
// processes itself, from the one server folder every mode uses, each in its own network namespace: both
// listen on the mode's game port at their own address, and only one of the two is connected - the public
// game port (UDP) is forwarded to it. The other one starts, waits in its lobby with no route out (it never
// talks to the backend) and takes over a few seconds after the active server's round is over, so the next
// match starts at once; the old one restarts and becomes the waiting one. The forwarding rewrites each
// packet's address without connection tracking, so a swap applies to the very next packet. Both servers
// read the mode's Config.<mode>.ini and announce the same address and port, so to the backend each mode is
// still one server. Each has its own instance id (solo-01a / solo-01b: its log files) and its own Wine
// prefix (data/swap/<mode>-<side>/wine); the game files and settings are shared.
//
// Backend: only the main supervisor's node agent talks to the backend. It reports the paired modes as
// running (with the active server's state) and carries out the backend's commands for them
// (linux-shim.mjs). A server kit update installs into the server folder as usual; a running server keeps the
// files it has open, and each pair server uses the new ones from its next start - the waiting one is
// restarted for it (one at a time on the box).
//
// Health, from each server's own state (Server.dll's status file where it writes one, otherwise its trace):
// a start that comes up with parts of the map missing is not used (it is restarted while it waits; the
// active one is swapped out), and so is a start that froze, stalled or takes too long, or a server that hangs
// once it is up; the active server is swapped out when it crashes ("[FATAL]", or the process ending), when a
// match runs longer than any match (30 min) or on a flood of caught faults. If the waiting server is not
// ready at that moment, the active one restarts instead.
//
// Modes: modes.json stays the owner's choice of modes. Where pairs can run, the main supervisor reads
// modes.main.json instead: the same, without the modes running as pairs. Pairs are switched on and off while
// the container runs: a mode that becomes a pair closes in the main supervisor after its current match and
// starts as a pair once its server is gone; a pair that is switched off stops and the main supervisor runs
// the mode again.
//
// The container needs the rights to set up network namespaces and nftables: AddCapability=NET_ADMIN SYS_ADMIN
// (Podman also SecurityLabelDisable=true); SYS_RESOURCE for the waiting servers' low CPU priority. Its network
// (the host's, or its own) needs IP forwarding on; the game ports are forwarded from the address they arrive
// at (the default route's interface). Settings:
//   RV_SWAP                   modes to run as pairs on a server's first start: solo,duos,... or all
//   RV_SWAP_ROUND_END_DELAY_SEC  seconds after Server.dll's "round over" before the swap (default 5)
//   RV_SWAP_BOOT_LIMIT_SEC    a start not joinable after this long is restarted (default 360)
// A mode that cannot run as a pair (e.g. missing rights) runs as a single server, as without RV_SWAP.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import { DATA, SERVER, WIN64, SUP_DIR, INSTANCES, MODES, GAME_EXE, readJson, writeJson, readState, updateState, isPairInstance } from './lib.mjs';
import { applySlim } from './slim.mjs';
import { applyBots } from './bots.mjs';
import { applyAddons } from './addons.mjs';

const SWAP_DIR = join(DATA, 'swap');
const STATE = join(SWAP_DIR, 'active.json');
const STATUS = join(SWAP_DIR, 'status.json');   // the controller's view, for `rv swap status`
const EXE = join(WIN64, GAME_EXE);
const env = process.env;
const KSM = /^(1|on|yes|true)$/i.test(env.RV_KSM || '');
const ROUND_END_DELAY_MS = (Number(env.RV_SWAP_ROUND_END_DELAY_SEC) || 5) * 1000;
const BOOT_LIMIT_MS = (Number(env.RV_SWAP_BOOT_LIMIT_SEC) || 360) * 1000;
const STATS_SETTLE_MS = 3000, ROUND_END_MAX_MS = 15000;
const STUCK_MATCH_MS = 30 * 60 * 1000;   // like the supervisor's stuckMatchMin
const FAULTS_PER_MIN = 300;              // like the supervisor's faultsPerMin, for 3 minutes
const STUCK = new Set(['match running longer than any match', 'fault flood']);
const CRASH_BACKOFF_SEC = [10, 30, 60, 120];   // like the supervisor's crashBackoffSec
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
export const USER_MODES = join(SUP_DIR, 'modes.json');      // the owner's choice of modes
const MAIN_MODES = join(SUP_DIR, 'modes.main.json');        // what the main supervisor runs (without the pairs)

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
    try { sh('ip', ['netns', 'list']); } catch { return { ok: false, reason: 'the image has no "ip netns" (update the image)' }; }
    try { sh('nft', ['list', 'tables']); } catch { return { ok: false, reason: 'the container needs the rights for it (AddCapability=NET_ADMIN SYS_ADMIN, see the README)' }; }
    let fwd = '0'; try { fwd = fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim(); } catch { /* */ }
    if (fwd !== '1') return { ok: false, reason: 'IP forwarding is off in the network of the container (net.ipv4.ip_forward=1, see the README)' };
    return { ok: true, reason: '' };
}

// The uplink's own IPv4 address: where the game ports arrive. On a host network it is the public address;
// behind a router, a container network or a tunnel (whose far end forwards the public address here) it is
// this side's address.
function addrOf(dev) {
    const m = /inet (\d+\.\d+\.\d+\.\d+)/.exec(sh('ip', ['-4', '-o', 'addr', 'show', 'dev', dev]));
    if (!m) throw new Error(`no IPv4 address on ${dev}`);
    return m[1];
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
    const id = `${mode.id}${side}`, dir = join(SWAP_DIR, `${mode.key}-${side}`);
    return {
        mode, side, id, name: `${mode.key}-${side}`, dir, wine: join(dir, 'wine'), ns: `rv-${mode.key}-${side}`,
        hostIf: `rvh${k}${side}`, peerIf: `rvp${k}${side}`, hostIp: `10.91.${n}.1`, ip: `10.91.${n}.2`,
        trace: join(WIN64, `crash_trace_${id}.log`),
        status: join(WIN64, `rv_status_${id}.json`),   // Server.dll's own state, where it writes one
    };
}

// Its own Wine prefix (one Wine server per game server, as one per container before): a copy of the main
// one, reflinked where the filesystem can. Kept across restarts.
function preparePrefix(sv, log) {
    fs.mkdirSync(sv.dir, { recursive: true });
    if (fs.existsSync(join(sv.wine, 'system.reg'))) return;
    fs.rmSync(sv.wine, { recursive: true, force: true });
    sh('cp', ['-a', '--reflink=auto', join(DATA, 'wine'), sv.wine]);
    log(`[pairs] ${sv.name}: Wine prefix copied`);
}

// Network namespace with a veth link to this one; DNS from the host's real resolvers. Its default route is
// set by setRoutes: only the active server of a pair has one.
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
    fs.mkdirSync(`/etc/netns/${sv.ns}`, { recursive: true });
    fs.writeFileSync(`/etc/netns/${sv.ns}/resolv.conf`, nameservers().map(n => `nameserver ${n}\n`).join(''));
}
// The active server has a default route, the waiting one none: its connections fail at once ("network
// unreachable"), as with no network at all. (Dropped packets made the game's REST library, cpprest, wait for
// its connections to time out early in the start and then end the process with a fatal error.)
function setRoutes(p, act) {
    sh('ip', ['-n', p[act].ns, 'route', 'replace', 'default', 'via', p[act].hostIp]);
    try { sh('ip', ['-n', p[other(act)].ns, 'route', 'del', 'default']); } catch { /* none */ }
}

// All pairs' forwarding in one table: outbound NAT for the active servers, the game ports forwarded
// statelessly to them.
export function rules(pairs, active, addr, dev) {
    const all = pairs.flatMap(p => SIDES.map(s => p[s].ip));
    const lines = [];
    for (const p of pairs) {
        const on = p[active[p.mode.key]], off = p[other(active[p.mode.key])], port = p.mode.port;
        lines.push({ raw: `iifname "${dev}" ip daddr ${addr} udp dport ${port} notrack`, raw2: `ip saddr { ${p.a.ip}, ${p.b.ip} } udp sport ${port} notrack`,
            dnat: `iifname "${dev}" ip daddr ${addr} udp dport ${port} ip daddr set ${on.ip}`,
            snat: `oifname "${dev}" ip saddr ${on.ip} udp sport ${port} ip saddr set ${addr}`, off: off.ip });
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
${lines.map(l => `        ip daddr ${l.off} drop`).join('\n')}
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
// Game process of an instance (its -RVInstance= argument, exactly).
function pidOfInstance(id) {
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0');
            if (args.includes(`-RVInstance=${id}`) && args.some(a => a.endsWith(GAME_EXE))) return Number(pid);
        } catch { /* gone */ }
    }
    return 0;
}
const gamePid = sv => pidOfInstance(sv.id);
// Server.dll's status file (rv_status_<instance>.json, rewritten every second) when this server writes one:
// { flow, joinable, conns, roundOver, statsQueued, statsPosted }. null = none, or stale (> 5 s).
function liveStatus(sv) {
    try {
        if (Date.now() - fs.statSync(sv.status).mtimeMs > 5000) return null;
        return JSON.parse(fs.readFileSync(sv.status, 'utf8'));
    } catch { return null; }
}
// A process that is going away. Server.dll's "*** CRASH ***" lines are often caught faults the server
// survives ("[CRASHGUARD] ... skipping"); only "[FATAL]" means it is dying.
const ENDED = /terminating for restart|\[FATAL\]|boot attempts exhausted/;
function missingSubLevels(boot) {
    const m = /forced sub-levels settled[^\n]*?(\d+) not loaded/.exec(boot);
    return m ? Number(m[1]) : 0;
}
// Process details for the web page / rv status: memory, uptime, connected players.
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
    const ls = liveStatus(sv);
    if (ls && Number.isInteger(ls.conns)) d.players = ls.conns;
    else {
        const s = size(sv.trace), tail = readRange(sv.trace, Math.max(0, s - 200000), s);
        const m = [...tail.matchAll(/\[KEEPALIVE\][^\n]*conns=(\d+)/g)].pop();
        d.players = m ? Number(m[1]) : 0;
    }
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
            const joinable = liveStatus(sv)?.joinable ?? b.includes('reporting joinable');
            return !!joinable && b.length > 0 && !ENDED.test(b) && !missingSubLevels(b);
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

// ---- running a game server ----
// The mode's instance from the main supervisor's ds-instances.json: arguments, port, game mode, config.
function instanceArgs(sv) {
    const cfg = readJson(INSTANCES, {}) || {};
    const d = (cfg.instances || []).find(x => x.id === sv.mode.id) || { port: sv.mode.port, gameMode: MODES.findIndex(m => m.key === sv.mode.key), config: `Config.${sv.mode.key}.ini` };
    // Like the supervisor's argsFor(), with this server's own instance id (its log files).
    return [...(d.args || cfg.args || ['-log', '-nullrhi', '-nosound']), `-LOG=server-${sv.id}.log`, `-RVInstance=${sv.id}`,
        `-RVPort=${d.port}`, `-RVGameMode=${d.gameMode}`, ...(d.config ? [`-RVConfig=${d.config}`] : [])];
}
const kitVersion = () => { try { return fs.readFileSync(join(SERVER, 'rv-server.version'), 'utf8').trim(); } catch { return ''; } };

// Starts the game process of one pair server in its namespace and starts it again whenever it ends: at once
// after a clean exit (a match end), after a crash with the supervisor's back-off. Returns
// { stop(), kit (the server kit version of the running process) }.
function runServer(sv, log, delayMs) {
    const proc = { child: null, stopping: false, timer: null, crashes: 0, kit: '' };
    const start = () => {
        if (proc.stopping) return;
        // the same preparations the main supervisor's game servers get (linux-shim.mjs)
        applySlim(EXE); applyBots(EXE); applyAddons(EXE);
        const cmd = ['ip', 'netns', 'exec', sv.ns, ...(PRLIMIT ? [PRLIMIT, '--nice=20:20'] : []), ...(KSM ? ['rv-ksm'] : []), 'wine', EXE, ...instanceArgs(sv)];
        proc.kit = kitVersion();
        const child = spawn(cmd[0], cmd.slice(1), { cwd: WIN64, stdio: 'ignore', env: { ...env, WINEPREFIX: sv.wine } });
        proc.child = child; proc.startedAt = Date.now();
        log(`[pairs] ${sv.name}: starting (${sv.id}, kit ${proc.kit || 'unknown'})`);
        child.on('error', e => log(`[pairs] ${sv.name}: could not start: ${e.message}`));
        child.on('exit', (code, sig) => {
            proc.child = null;
            if (proc.stopping) return;
            if (Date.now() - proc.startedAt > 5 * 60 * 1000) proc.crashes = 0;   // it ran a while: a fresh count
            const delay = code === 0 ? 0 : CRASH_BACKOFF_SEC[Math.min(proc.crashes++, CRASH_BACKOFF_SEC.length - 1)];
            log(`[pairs] ${sv.name}: ${code === 0 ? 'exited (match end)' : `ended (${code ?? sig})`} - starting again${delay ? ` in ${delay}s` : ''}`);
            proc.timer = setTimeout(start, delay * 1000);
        });
    };
    proc.timer = setTimeout(start, delayMs);
    // Stopping a pair server ends its game process (as the supervisor's stop does).
    proc.stop = () => new Promise(res => {
        proc.stopping = true; clearTimeout(proc.timer);
        const c = proc.child, pid = gamePid(sv);
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        if (!c) return res();
        const t = setTimeout(res, 10000);
        c.once('exit', () => { clearTimeout(t); res(); });
    });
    return proc;
}

// The main supervisor reads modes.main.json where pairs can run. Called before it starts. Earlier versions
// switched paired modes off in modes.json itself; those are switched on again there (the owner's choice).
export function prepareModes(log) {
    const inst = readJson(INSTANCES, null), user = readJson(USER_MODES, null);
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
        writeJson(INSTANCES, inst, 0o644);
        log('[pairs] the main supervisor now reads modes.main.json (modes.json without the server pairs)');
    }
    return true;
}
// Where pairs cannot run: the main supervisor reads the owner's modes.json again.
export function releaseModes(log) {
    const inst = readJson(INSTANCES, null);
    if (inst && inst.modesFile === 'modes.main.json') {
        inst.modesFile = 'modes.json';
        writeJson(INSTANCES, inst, 0o644);
        log('[pairs] pairs cannot run here - the main supervisor reads modes.json');
    }
    updateState({ pairedModes: [] });
}

// Runs the pairs the owner chose and keeps them in line with modes.json and the "Pair" setting.
// Returns { stop }.
export function createPairs({ log = console.log } = {}) {
    const dev = uplink(), addr = addrOf(dev);
    fs.mkdirSync(SWAP_DIR, { recursive: true });
    const active = readJson(STATE, {});
    const running = new Map();   // mode key -> { p, procs, ctl }
    let stopped = false, tick = 0, waitingLogged = new Set();

    const apply = () => {
        const pairs = [...running.values()].map(r => r.p);
        for (const p of pairs) setRoutes(p, active[p.mode.key]);
        if (pairs.length) execFileSync('nft', ['-f', '-'], { input: rules(pairs, active, addr, dev) });
        else { try { execFileSync('nft', ['delete', 'table', 'ip', 'rvpairs'], { stdio: 'ignore' }); } catch { /* none */ } }
        writeJson(STATE, active, 0o644);
        updateState({ pairedModes: [...running.keys()] });
    };
    const startPair = mode => {
        const p = { mode, a: server(mode, 'a'), b: server(mode, 'b') };
        for (const sd of SIDES) { preparePrefix(p[sd], log); prepareNet(p[sd]); }
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
                if (pidOfInstance(m.id)) {   // the main supervisor's server: closes after its current match (off in modes.main.json)
                    if (!waitingLogged.has(m.key)) { waitingLogged.add(m.key); log(`[pairs] ${m.label}: becomes a pair once its current server has finished its match`); }
                    continue;
                }
                waitingLogged.delete(m.key);
                try { startPair(m); } catch (e) { log(`[pairs] ${m.label}: could not start the pair: ${e.message}`); await stopPair(m.key); }
            }
            updateState({ pairedModes: [...running.keys()] });
        } finally { busy = false; }
    };

    // A server kit update: the waiting server is restarted so it starts on the new files (one at a time on
    // the box, and only once it is up - a start in progress already loads them). The active one takes the
    // new files at its next start, after its match.
    let kitRestartAt = 0;
    const followKit = (c, sb) => {
        const kit = kitVersion(), proc = running.get(c.p.mode.key)?.procs[sb];
        if (!kit || !proc?.child || !proc.kit || proc.kit === kit || Date.now() - kitRestartAt < 120000 || !c.w[sb].ready()) return;
        kitRestartAt = Date.now();
        c.w[sb].kill(`server kit ${proc.kit} -> ${kit} (it is the waiting server)`);
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
                    for (const m of text.matchAll(/\[FLOW\] game flow -?\d+ -> (-?\d+)/g)) { c.flow = Number(m[1]); c.flowSince = Date.now(); }
                    c.faults = (c.faults || 0) + (text.match(/\[CRASHGUARD\]/g) || []).length;
                    if (/\[STATS\] .* sent to the backend/.test(text)) c.statsAt = Date.now();
                    if (/\[STATS\] match reports posted/.test(text)) c.postedAt = Date.now();
                }
                // Server.dll's status file, where it writes one: the same events, without reading the trace.
                const ls = liveStatus(c.p[act]);
                if (ls) {
                    if (Number.isInteger(ls.flow) && ls.flow !== c.flow) { c.flow = ls.flow; c.flowSince = Date.now(); }
                    if (!c.waiting && ls.roundOver && !c.roundOverAt) c.roundOverAt = Date.now();
                    if (ls.statsPosted > (c.statsPosted ?? ls.statsPosted)) c.postedAt = Date.now();
                    c.statsPosted = ls.statsPosted;
                }
                if (!c.wasUp && A.ready()) c.wasUp = true;
                // Round over: Server.dll sends every remaining player's match report (Game Records) then. The
                // swap cuts the old server off, so it waits until the reports were posted ("[STATS] match reports
                // posted", where Server.dll logs it) or, without that, until no report has been queued for
                // STATS_SETTLE_MS - at most ROUND_END_MAX_MS after the round.
                if (!c.waiting && c.roundOverAt) {
                    const since = Date.now() - c.roundOverAt;
                    const settled = c.postedAt > c.roundOverAt || (!c.postedAt && (!c.statsAt || Date.now() - c.statsAt >= STATS_SETTLE_MS));
                    if (since >= ROUND_END_MAX_MS || (since >= ROUND_END_DELAY_MS && settled)) c.waiting = 'round over';
                }
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
                if (tick % 5 === 0) { B.checkHealth(); if (!c.waiting) A.checkHealth(); setNice(gamePid(c.p[act]), 0); if (PRLIMIT) setNice(gamePid(c.p[sb]), 19); }
                if (tick % 30 === 0) followKit(c, sb);
                if (!c.waiting) continue;
                if (B.ready()) {
                    setNice(gamePid(c.p[sb]), 0);
                    const prev = active[key];
                    active[key] = sb;
                    try { apply(); } catch (e) { active[key] = prev; log(`[pairs] ${c.p.mode.label}: could not swap: ${e.message}`); continue; }
                    A.forget();
                    log(`[pairs] ${c.p.mode.label}: ${c.waiting} on ${act} - swapped: ${sb} is active, ${act} restarts and waits`);
                    if (STUCK.has(c.waiting)) A.kill(c.waiting);
                    c.off = size(c.p[sb].trace); c.waiting = ''; c.roundOverAt = 0; c.goneSince = 0; c.wasUp = true; c.restarts = (c.restarts || 0) + 1; c.flow = null; c.faults = 0; c.floodMin = 0; c.statsAt = 0; c.postedAt = 0; c.statsPosted = undefined;
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
