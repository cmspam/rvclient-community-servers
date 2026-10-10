// CPU priority of starting game servers.
//
// A game server's start keeps several CPU cores busy for a minute or more. With Zero Wait (the kit's warm
// spare) one of a mode's two servers starts while the other plays a match, and that start must not slow
// the match down. So every game server starts at the lowest priority (nice 19), and once it reports
// joinable (Server.dll's "reporting joinable" line in crash_trace_<instance>.log) every thread of it is
// given the normal priority (0). Going back to 0 is allowed by the nice limit (RLIMIT_NICE 20) it starts
// with; setting that limit needs CAP_SYS_RESOURCE. Without it, or with RV_BOOT_NICE=off, servers start at
// the normal priority as before.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { gameProcesses } from './lib.mjs';

const ON = !/^(0|off|no|false)$/i.test(process.env.RV_BOOT_NICE || 'on');
const PRLIMIT = (() => {
    if (!ON) return '';
    for (const f of ['/usr/bin/prlimit', '/bin/prlimit']) {
        try { if (fs.existsSync(f)) { execFileSync(f, ['--nice=20:20', 'true'], { stdio: 'ignore' }); return f; } } catch { /* not allowed */ }
    }
    return '';
})();

// The command prefix that starts a program at nice 19 with the limit to come back to 0.
export const lowPriorityPrefix = () => (PRLIMIT ? [PRLIMIT, '--nice=20:20', 'nice', '-n', '19'] : []);

function setNice(pid, nice) {
    let tids = [];
    try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { return; }
    for (const t of tids) { try { if (os.getPriority(Number(t)) !== nice) os.setPriority(Number(t), nice); } catch { /* gone */ } }
}

// child: the started `wine <exe> args` process. Watches the server's trace until it reports joinable, then
// gives its game process the normal priority. Never throws.
export function normalPriorityWhenJoinable(exe, args, child, { log = msg => console.log(`[priority] ${msg}`), every = 3000 } = {}) {
    try {
        if (!PRLIMIT || !child?.pid) return;
        const id = (args || []).map(String).find(a => a.startsWith('-RVInstance='))?.slice(12);
        if (!id) return;
        const trace = join(dirname(exe), `crash_trace_${id}.log`);
        let from = 0;
        try { from = fs.statSync(trace).size; } catch { /* not there yet */ }
        const timer = setInterval(() => {
            let text = '';
            try {
                const fd = fs.openSync(trace, 'r');
                try {
                    const size = fs.fstatSync(fd).size;
                    if (size < from) from = 0;   // a new file
                    const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
                    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
                    text = buf.toString('latin1');
                } finally { fs.closeSync(fd); }
            } catch { return; }
            if (!text.includes('reporting joinable')) return;
            clearInterval(timer);
            for (const p of gameProcesses()) if (p.instance === id) setNice(p.pid, 0);
            log(`[${id}] joinable - normal CPU priority`);
        }, every);
        timer.unref?.();
        child.once?.('exit', () => clearInterval(timer));
    } catch (e) { log(`not raising the priority: ${e.message}`); }
}
