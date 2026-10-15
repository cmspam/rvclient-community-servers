// Boot watchdog: ends a game server start that froze or stalled, so the supervisor starts it again.
//
// The supervisor treats a start as hung only when no heartbeat arrives for bootTimeoutSec after launch.
// A start that sent its first heartbeat and then stopped making progress is caught only by
// heartbeatStaleSec, minutes later. While a server is starting (until Server.dll reports it joinable),
// this watches the process itself:
//   - frozen: the process is stopped (state T) for RV_BOOT_FROZEN_SEC (default 15) seconds;
//   - stalled: its crash trace (crash_trace_<instance>.log) gets no new lines for RV_BOOT_STALL_SEC
//     (default 150) seconds.
// Either way it is killed (SIGKILL works on a stopped process too); the supervisor sees a crash and
// starts it again. RV_BOOT_WATCHDOG=off turns this off.
import fs from 'node:fs';
import { dirname, join } from 'node:path';

export const WATCHDOG = !/^(0|off|no|false)$/i.test(process.env.RV_BOOT_WATCHDOG || 'on');
const seconds = (v, d) => (Number(v) > 0 ? Number(v) : d);

const stateOf = pid => {
    try { return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || ''; } catch { return ''; }
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
export function watchBoot(exe, args, child, { log = msg => console.log(`[watchdog] ${msg}`), env = process.env,
    every = 5000, now = () => Date.now(), state = stateOf } = {}) {
    try {
        if (!WATCHDOG || !child || !child.pid) return null;
        const id = (args || []).map(String).find(a => a.startsWith('-RVInstance='))?.slice(12);
        if (!id) return null;
        const trace = join(dirname(exe), `crash_trace_${id}.log`);
        const frozenMs = seconds(env.RV_BOOT_FROZEN_SEC, 15) * 1000, stallMs = seconds(env.RV_BOOT_STALL_SEC, 150) * 1000;
        const start = sizeOf(trace);
        let size = start, changed = now(), stoppedSince = 0;
        const timer = setInterval(() => {
            const t = now(), s = sizeOf(trace);
            if (s !== size) {
                size = s; changed = t;
                if (readFrom(trace, start).includes('reporting joinable')) { clearInterval(timer); return; }
            }
            const st = state(child.pid);
            stoppedSince = st === 'T' ? (stoppedSince || t) : 0;
            let why = '';
            if (stoppedSince && t - stoppedSince >= frozenMs) why = `process stopped (frozen) for ${Math.round((t - stoppedSince) / 1000)}s`;
            else if (t - changed >= stallMs) why = `no progress in its trace for ${Math.round((t - changed) / 1000)}s`;
            if (!why) return;
            clearInterval(timer);
            log(`[${id}] start did not finish: ${why} - ending it so it starts again`);
            try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }, every);
        timer.unref?.();
        child.once?.('exit', () => clearInterval(timer));
        return timer;
    } catch (e) { log(`not watching: ${e.message}`); return null; }
}
