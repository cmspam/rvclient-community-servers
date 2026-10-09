// rv swap: two servers of one mode (A and B), only one of them connected, for an instant next match.
//
// Runs in its own container on the host network (CAP_NET_ADMIN, the host's process list, both servers'
// data folders read-only). The active server gets the public game port, forwarded statelessly: each
// packet's address is rewritten, so a swap applies to the very next packet and leaves no connection
// state behind. Only the active server can reach the internet. The standby has no connectivity: it
// boots into its lobby and waits there without talking to the backend. When the active server's round is
// over (players queue for the next match from the end-of-match screen, still connected to the old
// server, which only keeps that connection alive until it restarts), or it stops for any other reason (a crash, a restart by the supervisor, the backend or an update:
// its process ends or a new boot starts), and the standby is in its lobby, they swap: the
// standby becomes active and takes the next match at once, and the old one restarts as the new standby.
// When the standby is not ready, nothing changes and the active server restarts the normal way.
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
//   RV_SWAP_STATE          state folder, default /swap/state
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

const env = process.env;
const PUB = env.RV_PUBLIC_IP || '';
const PORT = Number(env.RV_SWAP_PORT) || 7777;
const INSTANCE = env.RV_SWAP_INSTANCE || 'solo-01';
const SIDE = {
    a: { ip: env.RV_SWAP_A_IP || '10.90.0.10', dir: env.RV_SWAP_A_DIR || '/swap/a', host: env.RV_SWAP_A_HOST || '/var/srv/rvsolo-a' },
    b: { ip: env.RV_SWAP_B_IP || '10.90.0.11', dir: env.RV_SWAP_B_DIR || '/swap/b', host: env.RV_SWAP_B_HOST || '/var/srv/rvsolo-b' },
};
const STATE = join(env.RV_SWAP_STATE || '/swap/state', 'active');
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
function running(side) {
    const host = basename(SIDE[side].host);
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(`RVInstance=${INSTANCE}`)) continue;
            const mounts = fs.readFileSync(`/proc/${pid}/mountinfo`, 'latin1');
            if (mounts.split('\n').some(l => { const f = l.split(' '); return f[4] === '/data' && basename(f[3]) === host; })) return true;
        } catch { /* gone */ }
    }
    return false;
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
// In its lobby: running, and its current boot reported joinable and has not ended.
function ready(side) {
    if (!running(side)) return false;
    const boot = currentBoot(side);
    return boot.includes('reporting joinable') && !ENDED.test(boot);
}

function status() {
    const a = active(), s = other(a);
    console.log(`active: ${a} (${running(a) ? 'running' : 'not running'})`);
    console.log(`standby: ${s} (${ready(s) ? 'ready in its lobby' : running(s) ? 'starting' : 'not running'})`);
}

async function run() {
    if (!PUB) throw new Error('RV_PUBLIC_IP is not set');
    let act = active();
    apply(act);
    log(`active: ${act}, standby: ${other(act)} (public ${PUB} UDP ${PORT})`);
    let off = size(trace(act)), waiting = '', goneSince = 0;
    for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        const f = trace(act), s = size(f);
        if (s < off) off = 0;
        if (s > off) {
            const text = readRange(f, off, s); off = s;
            if (!waiting && /game flow 3 -> 4|terminating for restart/.test(text)) waiting = 'match over';
            else if (!waiting && /\*\*\* CRASH|boot attempts exhausted/.test(text)) waiting = 'crashed';
            else if (!waiting && /DllMain: begin/.test(text)) waiting = 'restarted';
        }
        if (!waiting) {
            // its process ended without a word in the trace (killed: health check, backend, update, rv restart)
            goneSince = running(act) ? 0 : (goneSince || Date.now());
            if (goneSince && Date.now() - goneSince > 3000) waiting = 'process ended';
        }
        if (!waiting) continue;
        const sb = other(act);
        if (ready(sb)) {
            try { apply(sb); } catch (e) { log(`could not swap: ${e.message}`); continue; }
            log(`${waiting} on ${act} - swapped: ${sb} is active, ${act} restarts as standby`);
            act = sb; off = size(trace(act)); waiting = ''; goneSince = 0;
        } else if (ready(act)) {
            log(`${waiting} on ${act} - standby ${sb} was not ready; ${act} restarted and stays active`);
            waiting = ''; goneSince = 0;
        }
    }
}

export async function main(args) {
    const [cmd, side] = args;
    if (cmd === 'run') return run();
    if (cmd === 'status') return status();
    if (cmd === 'now') { const s = other(active()); if (!ready(s)) return console.log(`standby ${s} is not ready`); apply(s); return console.log(`swapped: ${s} is active`); }
    if (cmd === 'apply' && (side === 'a' || side === 'b')) { apply(side); return console.log(`${side} is active`); }
    console.log('usage: rv swap run | status | now | apply a|b');
    process.exitCode = 1;
}
