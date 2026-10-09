// rv swap: two servers of one mode (A and B), only one of them connected, for an instant next match.
//
// Runs in its own container on the host network (CAP_NET_ADMIN, the host's process list, both servers'
// data folders read-only). The active server gets the public game port, forwarded statelessly: each
// packet's address is rewritten, so a swap applies to the very next packet and leaves no connection
// state behind. Only the active server can reach the internet. The standby has no connectivity: it
// boots into its lobby and waits there without talking to the backend. A few seconds after the active
// server's round is over (once the players have their results: they queue for the next match from the
// end-of-match screen, still connected to the old server), or when it stops for any other reason (a crash, a restart by the supervisor, the backend or an update:
// its process ends or a new boot starts), and the standby is in its lobby, they swap: the
// standby becomes active and takes the next match at once, and the old one restarts as the new standby.
// When the standby is not ready, nothing changes and the active server restarts the normal way. A server
// that comes up with parts of the map missing is restarted (the standby while it waits, the active one by
// swapping it out, or restarting it when the standby is not ready), and so is a start that froze, stalled
// or takes far too long.
//
//   rv swap run            the controller
//   rv swap status         which side is active, and whether the standby is ready
//   rv swap now            swap now (only when the standby is ready)
//   rv swap apply a|b      make a side active now, whatever the state
//
// Settings (environment):
//   RV_PUBLIC_IP           public address players connect to (required)
//   RV_SWAP_PORT           game port (UDP), default 7777
//   RV_SWAP_A_IP/_B_IP     the servers' addresses on their own network, default 10.90.0.10 / 10.90.0.11
//   RV_SWAP_A_DIR/_B_DIR   their data folders as mounted here, default /swap/a and /swap/b
//   RV_SWAP_A_HOST/_B_HOST their data folders on the host (to find their processes), default
//                          /var/srv/rvsolo-a and /var/srv/rvsolo-b
//   RV_SWAP_INSTANCE       server instance to watch, default solo-01
//   RV_SWAP_ROUND_END_DELAY_SEC  seconds after Server.dll's "round over" before the swap, default 5 (the
//                          players must get their results first)
//   RV_SWAP_STATE          state folder, default /swap/state
// For a box with memory for only one running server (needs swap, ideally zram, and the host's cgroup
// tree mounted at RV_SWAP_CGROUP, default /host/cgroup):
//   RV_SWAP_FREEZE=on      once the standby is in its lobby (+RV_SWAP_FREEZE_AFTER_SEC, default 20), its
//                          whole container is frozen (cgroup freezer) and its memory pushed out to swap;
//                          it is thawed right before it becomes active. A frozen server touches no memory
//                          and uses no CPU; a running one, even idle, keeps using all of its memory.
//   RV_SWAP_STANDBY_MEMORY  memory.high of the standby while it starts (e.g. 1200M): beyond that it
//                          pushes its own memory out, so the active server keeps its memory
//   RV_SWAP_STANDBY_CPU=idle  the standby only gets CPU time the active server does not use (cpu.idle)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

const env = process.env;
const PUB = env.RV_PUBLIC_IP || '';
const PORT = Number(env.RV_SWAP_PORT) || 7777;
const INSTANCE = env.RV_SWAP_INSTANCE || 'solo-01';
const ROUND_END_DELAY_MS = (Number(env.RV_SWAP_ROUND_END_DELAY_SEC) || 5) * 1000;
const SIDE = {
    a: { ip: env.RV_SWAP_A_IP || '10.90.0.10', dir: env.RV_SWAP_A_DIR || '/swap/a', host: env.RV_SWAP_A_HOST || '/var/srv/rvsolo-a' },
    b: { ip: env.RV_SWAP_B_IP || '10.90.0.11', dir: env.RV_SWAP_B_DIR || '/swap/b', host: env.RV_SWAP_B_HOST || '/var/srv/rvsolo-b' },
};
const STATE = join(env.RV_SWAP_STATE || '/swap/state', 'active');
const CGROOT = env.RV_SWAP_CGROUP || '/host/cgroup';
const on = v => /^(1|on|yes|true)$/i.test(v || '');
const FREEZE = on(env.RV_SWAP_FREEZE);
const FREEZE_AFTER_MS = (Number(env.RV_SWAP_FREEZE_AFTER_SEC) || 20) * 1000;
const STANDBY_MEMORY = env.RV_SWAP_STANDBY_MEMORY || '';
const STANDBY_IDLE_CPU = (env.RV_SWAP_STANDBY_CPU || '') === 'idle';
const LIMITS = FREEZE || STANDBY_MEMORY || STANDBY_IDLE_CPU;
const other = s => (s === 'a' ? 'b' : 'a');
const log = msg => console.log(`${new Date().toISOString()} [swap] ${msg}`);
const trace = s => join(SIDE[s].dir, 'server/Rumbleverse/Binaries/Win64', `crash_trace_${INSTANCE}.log`);

function uplink() {
    const r = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map(l => l.split('\t'));
    const d = r.find(f => f[1] === '00000000');
    if (!d) throw new Error('no default route');
    return d[0];
}

export function rules(on, off, dev) {
    const a = SIDE.a.ip, b = SIDE.b.ip;
    return `table ip rvswap
delete table ip rvswap
table ip rvswap {
    chain rv_raw {
        type filter hook prerouting priority raw; policy accept;
        iifname "${dev}" ip daddr ${PUB} udp dport ${PORT} notrack
        ip saddr { ${a}, ${b} } udp sport ${PORT} notrack
    }
    chain rv_dnat {
        type filter hook prerouting priority mangle; policy accept;
        iifname "${dev}" ip daddr ${PUB} udp dport ${PORT} ip daddr set ${on}
    }
    chain rv_forward {
        type filter hook forward priority -10; policy accept;
        ip saddr ${off} drop
        ip daddr ${off} drop
    }
    chain rv_snat {
        type filter hook postrouting priority srcnat; policy accept;
        oifname "${dev}" ip saddr ${on} udp sport ${PORT} ip saddr set ${PUB}
    }
}
`;
}

function apply(side) {
    execFileSync('nft', ['-f', '-'], { input: rules(SIDE[side].ip, SIDE[other(side)].ip, uplink()) });
    fs.mkdirSync(join(STATE, '..'), { recursive: true });
    fs.writeFileSync(STATE, side + '\n');
}
const active = () => { try { return fs.readFileSync(STATE, 'utf8').trim() === 'b' ? 'b' : 'a'; } catch { return 'a'; } };

// The game server process of a side: a process of this instance whose /data is that side's folder.
const running = side => gamePid(side) > 0;
function gamePid(side) {
    const host = basename(SIDE[side].host);
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(`RVInstance=${INSTANCE}`)) continue;
            const mounts = fs.readFileSync(`/proc/${pid}/mountinfo`, 'latin1');
            if (mounts.split('\n').some(l => { const f = l.split(' '); return f[4] === '/data' && basename(f[3]) === host; })) return Number(pid);
        } catch { /* gone */ }
    }
    return 0;
}

// The container's cgroup (on the host) of a side: from any process whose /data is that side's folder.
function scope(side) {
    const host = basename(SIDE[side].host);
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            const mounts = fs.readFileSync(`/proc/${pid}/mountinfo`, 'latin1');
            if (!mounts.split('\n').some(l => { const f = l.split(' '); return f[4] === '/data' && basename(f[3]) === host; })) continue;
            const path = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').find(l => l.startsWith('0::'))?.slice(3);
            if (!path) continue;
            const dir = join(CGROOT, path);
            return basename(dir) === 'container' ? join(dir, '..') : dir;
        } catch { /* gone */ }
    }
    return '';
}
const cgWarned = new Set();
function cg(dir, file, value) {
    if (!dir) return false;
    try { fs.writeFileSync(join(dir, file), String(value)); return true; }
    catch (e) {
        if (e.code !== 'EAGAIN' && !cgWarned.has(file)) { cgWarned.add(file); log(`could not set ${file}: ${e.message}`); }
        return false;
    }
}
const frozen = { a: false, b: false };
// Full resources: thawed, no memory cap, normal CPU share.
function asActive(side) {
    if (!LIMITS) return;
    const d = scope(side);
    cg(d, 'cgroup.freeze', 0); frozen[side] = false;
    if (STANDBY_MEMORY) cg(d, 'memory.high', 'max');
    if (STANDBY_IDLE_CPU) cg(d, 'cpu.idle', 0);
}
function asStandby(side) {
    if (!LIMITS) return;
    const d = scope(side);
    if (STANDBY_MEMORY) cg(d, 'memory.high', STANDBY_MEMORY);
    if (STANDBY_IDLE_CPU) cg(d, 'cpu.idle', 1);
}
function freeze(side) {
    const d = scope(side);
    if (!cg(d, 'cgroup.freeze', 1)) return;
    frozen[side] = true;
    cg(d, 'memory.reclaim', '8G');   // usually ends early (EAGAIN) once nothing more can go
    let mb = '?'; try { mb = Math.round(Number(fs.readFileSync(join(d, 'memory.current'), 'utf8')) / 1048576); } catch { /* */ }
    log(`standby ${side} frozen in its lobby, ${mb} MB left in memory`);
}

const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };
function readRange(f, from, to) {
    try {
        const fd = fs.openSync(f, 'r');
        try { const b = Buffer.alloc(Math.max(0, to - from)); fs.readSync(fd, b, 0, b.length, from); return b.toString('latin1'); }
        finally { fs.closeSync(fd); }
    } catch { return ''; }
}
// The trace of the current boot (since the last "DllMain: begin").
function currentBoot(side) {
    const f = trace(side), s = size(f), text = readRange(f, Math.max(0, s - 4000000), s);
    const i = text.lastIndexOf('DllMain: begin');
    return i < 0 ? '' : text.slice(i);
}
const ENDED = /terminating for restart|\*\*\* CRASH|boot attempts exhausted/;
// Sub-levels its current boot gave up on ("forced sub-levels settled ... N not loaded"): players would fall
// through the missing parts of the map.
function missingSubLevels(boot) {
    const m = /forced sub-levels settled[^\n]*?(\d+) not loaded/.exec(boot);
    return m ? Number(m[1]) : 0;
}
// In its lobby: running, and its current boot reported joinable with the whole map, and has not ended.
function ready(side) {
    if (!running(side)) return false;
    const boot = currentBoot(side);
    return boot.includes('reporting joinable') && !ENDED.test(boot) && !missingSubLevels(boot);
}
// Starts that went wrong: while a server's start has not reported joinable yet, its game process is ended (its
// supervisor starts it again) when it is stopped (state T) for 15 s, its trace gets no new lines for
// 150 s, or it is still not in its lobby 6 minutes after the process started.
const BOOT = { a: {}, b: {} };
function procState(pid) { try { return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || ''; } catch { return ''; } }
function checkBoot(side) {
    const b = BOOT[side], pid = gamePid(side), now = Date.now();
    // only before the start reports joinable (a joinable server with parts of the map missing is handled apart)
    if (!pid || frozen[side] || currentBoot(side).includes('reporting joinable')) { BOOT[side] = {}; return; }
    if (b.pid !== pid) Object.assign(b, { pid, since: now, size: size(trace(side)), changed: now, stopped: 0 });
    const sz = size(trace(side));
    if (sz !== b.size) { b.size = sz; b.changed = now; }
    b.stopped = procState(pid) === 'T' ? (b.stopped || now) : 0;
    let why = '';
    if (b.stopped && now - b.stopped >= 15000) why = 'its process is stopped (frozen)';
    else if (now - b.changed >= 150000) why = `no progress in its trace for ${Math.round((now - b.changed) / 1000)}s`;
    else if (now - b.since >= 360000) why = 'not in its lobby 6 minutes after it started';
    if (!why) return;
    log(`${side} start went wrong: ${why} - restarting it`);
    BOOT[side] = {};
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}
// A boot that came up with parts of the map missing: end that game server process so its supervisor
// starts it again. Returns true when it did.
const restarted = { a: 0, b: 0 };
function restartIfMapMissing(side) {
    const boot = currentBoot(side), n = missingSubLevels(boot);
    if (!n || !boot.includes('reporting joinable') || ENDED.test(boot)) return false;
    const pid = gamePid(side);
    if (!pid || restarted[side] === pid) return false;
    restarted[side] = pid;
    log(`${side} came up with ${n} part(s) of the map missing - restarting it`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    return true;
}

function status() {
    const a = active(), s = other(a);
    console.log(`active: ${a} (${running(a) ? 'running' : 'not running'})`);
    let fz = false; try { fz = /frozen 1/.test(fs.readFileSync(join(scope(s), 'cgroup.events'), 'utf8')); } catch { /* */ }
    console.log(`standby: ${s} (${ready(s) ? 'ready in its lobby' : running(s) ? 'starting' : 'not running'}${fz ? ', frozen' : ''})`);
}

async function run() {
    if (!PUB) throw new Error('RV_PUBLIC_IP is not set');
    let act = active();
    asActive(act); apply(act); asStandby(other(act));
    log(`active: ${act}, standby: ${other(act)} (public ${PUB} UDP ${PORT})${FREEZE ? ', standby frozen in its lobby' : ''}`);
    let standbyReadyAt = 0, tick = 0;
    let off = size(trace(act)), waiting = '', goneSince = 0, roundOverAt = 0;
    for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        const f = trace(act), s = size(f);
        if (s < off) off = 0;
        if (s > off) {
            const text = readRange(f, off, s); off = s;
            if (!waiting && /\[ROUNDEND\] round over/.test(text) && !roundOverAt) roundOverAt = Date.now();
            if (!waiting && /terminating for restart/.test(text)) waiting = 'match over';
            else if (!waiting && /\*\*\* CRASH|boot attempts exhausted/.test(text)) waiting = 'crashed';
            else if (!waiting && /DllMain: begin/.test(text)) waiting = 'restarted';
        }
        // The round is over: the players get their results (end-of-match screen) first, then the port moves.
        if (!waiting && roundOverAt && Date.now() - roundOverAt >= ROUND_END_DELAY_MS) waiting = 'round over';
        if (!waiting) {
            // its process ended without a word in the trace (killed: health check, backend, update, rv restart)
            goneSince = running(act) ? 0 : (goneSince || Date.now());
            if (goneSince && Date.now() - goneSince > 3000) waiting = 'process ended';
        }
        const sb = other(act);
        // Every 10 s: the active server is never frozen or limited, the standby keeps its limits (a
        // container that restarted on its own gets a new cgroup).
        tick++;
        if (LIMITS && tick % 10 === 0) {
            asActive(act);
            if (!frozen[sb]) asStandby(sb);
            else { try { if (!/frozen 1/.test(fs.readFileSync(join(scope(sb), 'cgroup.events'), 'utf8'))) { frozen[sb] = false; asStandby(sb); } } catch { /* */ } }
        }
        if (!frozen[sb] && tick % 5 === 0) { restartIfMapMissing(sb); checkBoot(sb); }
        if (tick % 5 === 0 && running(act)) checkBoot(act);
        if (!waiting && missingSubLevels(currentBoot(act)) && currentBoot(act).includes('reporting joinable')) waiting = 'map incomplete';
        if (FREEZE && !waiting && !frozen[sb]) {
            if (!ready(sb)) standbyReadyAt = 0;
            else if (!standbyReadyAt) standbyReadyAt = Date.now();
            else if (Date.now() - standbyReadyAt >= FREEZE_AFTER_MS) freeze(sb);
        }
        if (!waiting) continue;
        if (ready(sb)) {
            asActive(sb);
            try { apply(sb); } catch (e) { log(`could not swap: ${e.message}`); continue; }
            asStandby(act);
            log(`${waiting} on ${act} - swapped: ${sb} is active, ${act} restarts as standby`);
            act = sb; standbyReadyAt = 0; off = size(trace(act)); waiting = ''; goneSince = 0; roundOverAt = 0;
        } else if (waiting === 'map incomplete') {
            if (restartIfMapMissing(act)) log(`standby ${sb} was not ready; ${act} restarts and stays active`);
            waiting = ''; goneSince = 0; roundOverAt = 0;
        } else if (ready(act)) {
            log(`${waiting} on ${act} - standby ${sb} was not ready; ${act} restarted and stays active`);
            waiting = ''; goneSince = 0; roundOverAt = 0;
        }
    }
}

export async function main(args) {
    const [cmd, side] = args;
    if (cmd === 'run') return run();
    if (cmd === 'status') return status();
    if (cmd === 'now') { const a = active(), s = other(a); if (!ready(s)) return console.log(`standby ${s} is not ready`); asActive(s); apply(s); asStandby(a); return console.log(`swapped: ${s} is active`); }
    if (cmd === 'apply' && (side === 'a' || side === 'b')) { asActive(side); apply(side); asStandby(other(side)); return console.log(`${side} is active`); }
    console.log('usage: rv swap run | status | now | apply a|b');
    process.exitCode = 1;
}
