// Game server watchdog: ends a game server that froze or stopped making progress, so the
// supervisor starts it again.
//
// The supervisor treats a start as hung only when no heartbeat arrives for bootTimeoutSec after
// launch, and a running server as hung only when the backend's heartbeat goes stale. A crash that
// kills the engine thread but leaves the process alive gets past both: the Server.dll keepalive
// thread keeps writing crash_trace_<instance>.log and sending heartbeats with the last state
// (players, flow, joinable), so the backend and the supervisor go on seeing a healthy server.
// That is why the process itself is watched for its whole life:
//   - frozen: the process is stopped (state T) for RV_BOOT_FROZEN_SEC (default 15) seconds;
//   - starting: its crash trace gets no new lines for RV_BOOT_STALL_SEC (default 150) seconds;
//   - running: after the kit reports the server joinable, the engine's game thread (the process's
//     main thread) must keep using CPU. No CPU for RV_RUN_STALL_SEC (default 120) seconds means
//     the engine is gone - the keepalive thread's trace lines do not count as progress.
// Either way it is killed (SIGKILL works on a stopped process too); the supervisor sees a crash
// and starts it again. RV_BOOT_WATCHDOG=off turns this off; RV_RUN_STALL_SEC=0 turns off only the
// running check.
import fs from 'node:fs';
import { dirname, join } from 'node:path';

export const WATCHDOG = !/^(0|off|no|false)$/i.test(process.env.RV_BOOT_WATCHDOG || 'on');
const seconds = (v, d) => (Number(v) > 0 ? Number(v) : d);
const off = v => /^(0|off|no|false)$/i.test(String(v ?? ''));

const stateOf = pid => {
    try { return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || ''; } catch { return ''; }
};
// The engine's game thread is the process's main thread (TID = PID): its utime + stime, in ticks.
// Reading it needs no privileges and keeps working when the process is only a shell of itself.
const cpuOf = pid => {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return (Number(f[11]) || 0) + (Number(f[12]) || 0);
    } catch { return null; }
};
const sizeOf = file => { try { return fs.statSync(file).size; } catch { return 0; } };
function readFrom(file, from) {
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const len = Math.max(0, fs.fstatSync(fd).size - from), buf = Buffer.alloc(Math.min(len, 1 << 20));
            fs.readSync(fd, buf, 0, buf.length, Math.max(from, fs.fstatSync(fd).size - buf.length));
            return buf.toString('latin1');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }
}

// child: the ChildProcess of `exe args`. Never throws.
export function watchGameServer(exe, args, child, {
    log = msg => console.log(`[watchdog] ${msg}`), env = process.env, every = 5000,
    now = () => Date.now(), state = stateOf, cpu = cpuOf, kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
    try {
        if (!WATCHDOG || !child || !child.pid) return null;
        const id = (args || []).map(String).find(a => a.startsWith('-RVInstance='))?.slice(12);
        if (!id) return null;
        const trace = join(dirname(exe), `crash_trace_${id}.log`);
        const frozenMs = seconds(env.RV_BOOT_FROZEN_SEC, 15) * 1000, stallMs = seconds(env.RV_BOOT_STALL_SEC, 150) * 1000;
        const runMs = off(env.RV_RUN_STALL_SEC) ? 0 : seconds(env.RV_RUN_STALL_SEC, 120) * 1000;
        const start = sizeOf(trace);
        let size = start, changed = now(), stoppedSince = 0;
        let joined = false, lastCpu = null, cpuAt = 0;
        const timer = setInterval(() => {
            const t = now();
            if (!joined) {
                const s = sizeOf(trace);
                if (s !== size) {
                    size = s; changed = t;
                    if (readFrom(trace, start).includes('reporting joinable')) { joined = true; lastCpu = null; cpuAt = t; }
                }
            }
            const st = state(child.pid);
            stoppedSince = st === 'T' ? (stoppedSince || t) : 0;
            let why = '';
            if (stoppedSince && t - stoppedSince >= frozenMs) why = `process stopped (frozen) for ${Math.round((t - stoppedSince) / 1000)}s`;
            else if (!joined && t - changed >= stallMs) why = `no progress in its trace for ${Math.round((t - changed) / 1000)}s`;
            else if (joined && runMs) {
                const c = cpu(child.pid);
                if (c === null) return;   // the process is gone; its exit clears this timer
                if (lastCpu === null || c !== lastCpu) { lastCpu = c; cpuAt = t; }
                else if (t - cpuAt >= runMs)
                    why = `game thread has used no CPU for ${Math.round((t - cpuAt) / 1000)}s while the process stayed up`;
            }
            if (!why) return;
            clearInterval(timer);
            log(`[${id}] ${why} - ending it so it starts again`);
            try { kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }, every);
        timer.unref?.();
        child.once?.('exit', () => clearInterval(timer));
        return timer;
    } catch (e) { log(`not watching: ${e.message}`); return null; }
}
