// Server pairs (RV_SWAP=solo,duos): an instant next match for the listed modes.
//
// Each listed mode that is switched on runs as two servers instead of one, both inside this container,
// each in its own network namespace with its own copy of the server folder (data/swap/<mode>-a and -b).
// Only one of the two is connected: the public game port of the mode (UDP) is forwarded to it, and only it
// can reach the internet. The other one starts, waits in its lobby without any network (it never talks to
// the backend) and takes over a few seconds after the active server's round is over, so the next match
// starts at once; the old one restarts and becomes the waiting one. The forwarding rewrites each packet's
// address without connection tracking, so a swap applies to the very next packet. Both copies keep the
// server's identity, so to the backend each mode is still one server.
//
// Registration: every server's node agent registers the box with the backend; only the main supervisor's
// registration is sent, with the paired modes marked as running (linux-shim.mjs).
//
// Health: a server that starts with parts of the map missing is not used (it is restarted while it
// waits; the active one is swapped out), and so is a start that froze, stalled or takes too long.
// If the waiting server is not ready when a match ends, nothing swaps and the server restarts as usual.
//
// The container needs the host network and the rights to set up network namespaces and nftables:
// Network=host, AddCapability=NET_ADMIN SYS_ADMIN (Podman also SecurityLabelDisable=true). Settings:
//   RV_SWAP                   modes to run as pairs: solo,duos,... or all
//   RV_SWAP_ROUND_END_DELAY_SEC  seconds after Server.dll's "round over" before the swap (default 5)
//   RV_SWAP_BOOT_LIMIT_SEC    a start not joinable after this long is restarted (default 360)
// A mode that cannot run as a pair (e.g. missing rights) runs as a single server, as without RV_SWAP.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DATA, SERVER, MODES, GAME_EXE, readJson, writeJson, readState, updateState } from './lib.mjs';

const SWAP_DIR = join(DATA, 'swap');
const STATE = join(SWAP_DIR, 'active.json');
const STATUS = join(SWAP_DIR, 'status.json');   // the controller's view, for `rv swap status`
const RV = new URL('./rv.mjs', import.meta.url).pathname;
const env = process.env;
const ROUND_END_DELAY_MS = (Number(env.RV_SWAP_ROUND_END_DELAY_SEC) || 5) * 1000;
const BOOT_LIMIT_MS = (Number(env.RV_SWAP_BOOT_LIMIT_SEC) || 360) * 1000;
const SIDES = ['a', 'b'];
const other = s => (s === 'a' ? 'b' : 'a');

// Modes listed in RV_SWAP (or all), by key.
export function listedModes(value = env.RV_SWAP) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || /^(0|off|no|false)$/.test(v)) return [];
    if (v === 'all') return MODES.map(m => m.key);
    return v.split(/[\s,]+/).filter(k => MODES.some(m => m.key === k));
}

// ---- the main server's modes ----
// The main supervisor must not run a paired mode itself: the mode is switched off in its modes file and
// remembered in the state, so it is switched on again when RV_SWAP no longer lists it.
function modesFile(root) { return join(root, 'server', 'Rumbleverse', 'Binaries', 'Win64', 'RVSupervisor', 'modes.json'); }
export function takeModesFromMain(paired, log) {
    if (env.RV_PAIR) return [];   // a pair's own server: its modes file is set by the main one
    const file = modesFile(DATA), modes = readJson(file, null);
    if (!modes) return [];
    const st = readState(), before = new Set(st.pairedModes || []);
    const enabled = MODES.map(m => m.key).filter(k => modes[k] || before.has(k));
    const take = paired.filter(k => enabled.includes(k));
    let changed = false;
    for (const k of before) if (!take.includes(k) && !modes[k]) { modes[k] = true; changed = true; log(`[pairs] ${k}: runs as a single server again`); }
    for (const k of take) if (modes[k]) { modes[k] = false; changed = true; }
    if (changed) writeJson(file, modes, 0o644);
    updateState({ pairedModes: take });
    return take;
}

// ---- checks ----
function sh(cmd, args, opts = {}) { return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString(); }
export function canRun(log) {
    try { sh('ip', ['netns', 'list']); } catch { log('[pairs] no iproute2 "ip netns" - pairs need the current image'); return false; }
    try { sh('nft', ['list', 'tables']); } catch { log('[pairs] nftables not allowed - the container needs AddCapability=NET_ADMIN SYS_ADMIN'); return false; }
    let fwd = '0'; try { fwd = fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim(); } catch { /* */ }
    if (fwd !== '1') { log('[pairs] IP forwarding is off on this host - set net.ipv4.ip_forward=1 (Podman and Docker normally do)'); return false; }
    return true;
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
function prepareCopy(sv, log) {
    if (!fs.existsSync(join(sv.win64, GAME_EXE))) {
        fs.rmSync(sv.dir, { recursive: true, force: true });
        fs.mkdirSync(sv.dir, { recursive: true });
        const how = copyTree(SERVER, join(sv.dir, 'server'), log);
        for (const d of ['wine', 'state', 'addons']) if (fs.existsSync(join(DATA, d))) sh('cp', ['-a', '--reflink=auto', join(DATA, d), join(sv.dir, d)]);
        fs.rmSync(join(sv.dir, 'state', 'control.sock'), { force: true });
        const st = join(sv.dir, 'state', 'rv.json'), j = readJson(st, null);
        if (j) { delete j.pairedModes; writeJson(st, j); }
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
    if (inst && (inst.matchEndRelaunchSec !== 0 || inst.launchGapSec !== 0)) {
        inst.matchEndRelaunchSec = 0; inst.launchGapSec = 0;   // only one server per copy: no waits
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
const ENDED = /terminating for restart|\*\*\* CRASH|boot attempts exhausted/;
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
function procState(pid) { try { return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || ''; } catch { return ''; } }

function createWatch(sv, log) {
    // Where the trace ended when the current game process appeared: a boot counts only when its
    // "DllMain: begin" comes after that, so a new process is never judged by the previous one's lines.
    let seen = { pid: 0, offset: 0 }, watching = false, boot = {}, restartedPid = 0;
    const w = {
        sv,
        observe() {
            const pid = gamePid(sv);
            if (pid && pid !== seen.pid) seen = { pid, offset: watching ? size(sv.trace) : 0 };
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
        const child = spawn('ip', ['netns', 'exec', sv.ns, process.execPath, RV, 'run'], {
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

// Sets everything up and runs the pairs; returns { modes, stop } (modes: the ones running as pairs).
export async function startPairs(paired, { log = console.log, publicIp } = {}) {
    if (!paired.length) return { modes: [], stop: async () => {} };
    if (!canRun(log)) return { modes: [], stop: async () => {}, failed: true };
    const pub = publicIp || readState().publicIp || env.RV_PUBLIC_IP;
    if (!pub) { log('[pairs] no public IP known - pairs need it'); return { modes: [], stop: async () => {}, failed: true }; }
    const dev = uplink();
    fs.mkdirSync(SWAP_DIR, { recursive: true });
    const pairs = [];
    for (const key of paired) {
        const mode = MODES.find(m => m.key === key);
        const p = { mode, a: server(mode, 'a'), b: server(mode, 'b') };
        for (const s of SIDES) { prepareCopy(p[s], log); prepareNet(p[s]); }
        pairs.push(p);
    }
    const active = Object.assign(Object.fromEntries(pairs.map(p => [p.mode.key, 'a'])), readJson(STATE, {}));
    const apply = () => {
        execFileSync('nft', ['-f', '-'], { input: rules(pairs, active, pub, dev) });
        writeJson(STATE, active, 0o644);
    };
    apply();
    log(`[pairs] running ${pairs.map(p => `${p.mode.label} (active ${active[p.mode.key]})`).join(', ')} as pairs: one connected, one waiting`);

    // the active side of each mode starts first; the waiting side a minute and a half later
    const procs = [];
    pairs.forEach((p, i) => {
        procs.push(runServer(p[active[p.mode.key]], log, i * 20000));
        procs.push(runServer(p[other(active[p.mode.key])], log, 90000 + i * 20000));
    });

    // the swap controller
    const ctl = pairs.map(p => ({ p, w: { a: createWatch(p.a, log), b: createWatch(p.b, log) }, off: size(p[active[p.mode.key]].trace), waiting: '', roundOverAt: 0, goneSince: 0, wasUp: false }));
    let stopped = false, tick = 0;
    const describe = (w, isActive) => w.ready() ? (isActive ? 'up' : 'in its lobby') : gamePid(w.sv) ? (isActive ? 'up' : 'starting') : 'not running';
    const loop = async () => {
        while (!stopped) {
            await new Promise(r => setTimeout(r, 1000));
            tick++;
            if (tick % 5 === 0) {
                try {
                    writeJson(STATUS, { at: new Date().toISOString(), modes: Object.fromEntries(ctl.map(c => {
                        const act = active[c.p.mode.key], sb = other(act);
                        return [c.p.mode.key, { label: c.p.mode.label, active: act, activeState: describe(c.w[act], true), waiting: sb, waitingState: describe(c.w[sb], false),
                            activeDetails: details(c.p[act]), waitingDetails: details(c.p[sb]), restarts: c.restarts || 0 }];
                    })) }, 0o644);
                } catch { /* */ }
            }
            for (const c of ctl) {
                const key = c.p.mode.key, act = active[key], sb = other(act), A = c.w[act], B = c.w[sb];
                A.observe(); B.observe();
                const f = c.p[act].trace, s = size(f);
                if (s < c.off) c.off = 0;
                if (s > c.off) {
                    const text = readRange(f, c.off, s); c.off = s;
                    if (!c.waiting && /\[ROUNDEND\] round over/.test(text) && !c.roundOverAt) c.roundOverAt = Date.now();
                    if (!c.waiting && /terminating for restart/.test(text)) c.waiting = 'match over';
                    else if (!c.waiting && /\*\*\* CRASH|boot attempts exhausted/.test(text)) c.waiting = 'crashed';
                    else if (!c.waiting && c.wasUp && /DllMain: begin/.test(text)) c.waiting = 'restarted';
                }
                if (!c.wasUp && A.ready()) c.wasUp = true;
                if (!c.waiting && c.roundOverAt && Date.now() - c.roundOverAt >= ROUND_END_DELAY_MS) c.waiting = 'round over';
                if (!c.waiting && c.wasUp) {
                    c.goneSince = gamePid(c.p[act]) ? 0 : (c.goneSince || Date.now());
                    if (c.goneSince && Date.now() - c.goneSince > 3000) c.waiting = 'process ended';
                }
                if (!c.waiting && missingSubLevels(A.currentBoot()) && A.currentBoot().includes('reporting joinable')) c.waiting = 'map incomplete';
                if (tick % 5 === 0) { B.checkHealth(); if (!c.waiting) A.checkHealth(); }
                if (!c.waiting) continue;
                if (B.ready()) {
                    const prev = active[key];
                    active[key] = sb;
                    try { apply(); } catch (e) { active[key] = prev; log(`[pairs] ${c.p.mode.label}: could not swap: ${e.message}`); continue; }
                    A.forget();
                    log(`[pairs] ${c.p.mode.label}: ${c.waiting} on ${act} - swapped: ${sb} is active, ${act} restarts and waits`);
                    c.off = size(c.p[sb].trace); c.waiting = ''; c.roundOverAt = 0; c.goneSince = 0; c.wasUp = true; c.restarts = (c.restarts || 0) + 1;
                } else if (c.waiting === 'map incomplete') {
                    A.checkHealth(); c.waiting = ''; c.roundOverAt = 0;
                } else if (A.ready()) {
                    log(`[pairs] ${c.p.mode.label}: ${c.waiting} on ${act} - ${sb} was not ready; ${act} restarted and stays active`);
                    c.waiting = ''; c.roundOverAt = 0; c.goneSince = 0; c.wasUp = true;
                }
            }
        }
    };
    loop().catch(e => log(`[pairs] controller stopped: ${e.message}`));

    return {
        modes: pairs.map(p => p.mode.key),
        stop: async () => {
            stopped = true;
            await Promise.all(procs.map(p => p.stop()));
            try { execFileSync('nft', ['delete', 'table', 'ip', 'rvpairs']); } catch { /* */ }
            for (const p of pairs) for (const s of SIDES) {
                try { sh('ip', ['netns', 'del', p[s].ns]); } catch { /* */ }
                try { sh('ip', ['link', 'del', p[s].hostIf]); } catch { /* */ }
            }
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

// `rv swap status` / `rv swap restart <mode>` (restart the active server: the waiting one takes over)
export function pairsCli(args) {
    const paired = readState().pairedModes || [];
    if (!paired.length) return console.log('No modes run as pairs (RV_SWAP).');
    const [cmd, key] = args;
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
