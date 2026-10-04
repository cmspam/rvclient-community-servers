// Runs the upstream supervisor (ds-supervisor.js from the server kit) and keeps it running.
//
// The supervisor starts its game servers as detached children and does not take them over after
// its own restart: a new supervisor launches fresh servers (Server.dll ends a leftover holding its
// port). So whenever the supervisor stops, its game servers are stopped as well before it starts
// again - nothing is left running unmanaged.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIN64, SUP_DIR, INSTANCES, LOGS, gameProcesses, killGameProcesses } from './lib.mjs';
import { ensureWinePrefix } from './setup.mjs';
import { admin } from './ops.mjs';

// After a kit update that changes the supervisor's own files (the upstream updater logs "supervisor
// files changed - they take effect when the supervisor restarts"), restart it once every game server
// is empty; forced after this many hours, like the updater's own rule for game servers.
const SUP_RESTART_MAX_H = Number(process.env.RV_SUP_RESTART_MAX_HOURS || 3);

const SHIM = new URL('./linux-shim.mjs', import.meta.url).pathname;

export function createManager({ log = console.log } = {}) {
    let child = null, want = 'stopped', since = 0, starts = 0, crashes = 0, timer = null, lastExit = null;
    let ownerShutdown = false;
    let pending = null;  // { since, reason }: supervisor restart waiting for empty servers
    let pendingTimer = null;
    const recent = [];   // last supervisor console lines, for the web UI

    function note(line) {
        recent.push(line);
        if (recent.length > 300) recent.shift();
    }

    function cleanupGames() {
        const n = killGameProcesses('SIGKILL');
        spawnSync('wineserver', ['-k'], { stdio: 'ignore', timeout: 15000 });
        if (n) log(`[rv] stopped ${n} game server process(es) left by the supervisor`);
    }

    async function start() {
        clearTimeout(timer); timer = null;
        want = 'running'; ownerShutdown = false;
        if (child) return;
        await ensureWinePrefix(msg => log(`[rv] ${msg}`));
        if (gameProcesses().length) cleanupGames();
        const args = ['--import', SHIM, join(SUP_DIR, 'ds-supervisor.js'), INSTANCES,
            '--log-file', join(LOGS, 'supervisor.log'), '--stop-on-exit'];
        log('[rv] starting the server supervisor');
        child = spawn(process.execPath, args, { cwd: WIN64, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        since = Date.now(); starts++;
        const pipe = stream => {
            let buf = '';
            stream.on('data', d => {
                buf += d;
                let k;
                while ((k = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, k).replace(/\r$/, ''); buf = buf.slice(k + 1);
                    if (!line) continue;
                    note(line);
                    console.log(line);
                    if (/\[shutdown\] requested/.test(line)) ownerShutdown = true;
                    if (/supervisor files changed/.test(line)) schedulePendingRestart(line);
                }
            });
        };
        pipe(child.stdout); pipe(child.stderr);
        const me = child;
        child.on('exit', (code, signal) => {
            if (child !== me) return;
            child = null;
            lastExit = { code, signal, at: new Date().toISOString() };
            if (ownerShutdown && code === 0) {
                // "Stop all servers" from the admin API: everything stays down until started again.
                want = 'stopped';
                log('[rv] supervisor stopped by the owner (Stop all) - start it again from the web UI');
                return;
            }
            if (want !== 'running') return;
            crashes++;
            cleanupGames();
            const delay = Math.min(60, 5 * crashes);
            log(`[rv] supervisor exited (${code ?? signal}) - restarting in ${delay}s`);
            appendFileSync(join(LOGS, 'supervisor.log'), `${new Date().toISOString()} [rv] supervisor exited (${code ?? signal}) - restarting in ${delay}s\n`);
            timer = setTimeout(() => start().catch(e => log(`[rv] supervisor start failed: ${e.message}`)), delay * 1000);
        });
    }

    // SIGINT makes the supervisor stop its servers (it runs with --stop-on-exit) and exit.
    async function stop() {
        clearTimeout(timer); timer = null; clearPending();
        want = 'stopped';
        const c = child;
        if (c) {
            log('[rv] stopping the supervisor and its game servers');
            c.kill('SIGINT');
            const done = await new Promise(res => {
                const t = setTimeout(() => res(false), 30000);
                c.once('exit', () => { clearTimeout(t); res(true); });
            });
            if (!done) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
        }
        cleanupGames();
    }

    async function restart() { clearPending(); await stop(); crashes = 0; await start(); }

    function clearPending() { pending = null; clearInterval(pendingTimer); pendingTimer = null; }

    function schedulePendingRestart(line) {
        if (pending) return;
        pending = { since: Date.now(), reason: line.replace(/^\S+\s+/, '') };
        log(`[rv] supervisor files were updated - restarting the supervisor once all servers are empty (at most ${SUP_RESTART_MAX_H} h)`);
        // Checked at once as well: right after an update the servers are usually empty, and
        // restarting the supervisor before the updater's own restart round (15 s) restarts each
        // game server once instead of twice.
        const check = async () => {
            if (!child || !pending) return;
            let busy = 0;
            try { busy = ((await admin('/instances')).instances || []).filter(i => i.running && i.players > 0).length; }
            catch { return; }   // supervisor busy or restarting: try again next round
            const overdue = Date.now() - pending.since >= SUP_RESTART_MAX_H * 3600 * 1000;
            if (busy && !overdue) return;
            log(busy ? `[rv] supervisor update: still ${busy} server(s) with players after ${SUP_RESTART_MAX_H} h - restarting anyway`
                : '[rv] supervisor update: all servers empty - restarting the supervisor');
            restart().catch(e => log(`[rv] supervisor restart failed: ${e.message}`));
        };
        pendingTimer = setInterval(check, 30000);
        setImmediate(check);
    }

    function state() {
        return {
            state: child ? 'running' : timer ? 'restarting' : want === 'running' ? 'starting' : 'stopped',
            pid: child?.pid || null, upSec: child ? Math.round((Date.now() - since) / 1000) : 0,
            starts, crashes, lastExit,
            pendingRestart: pending ? { sinceSec: Math.round((Date.now() - pending.since) / 1000), reason: pending.reason } : null,
        };
    }

    return { start, stop, restart, state, recent: () => recent.slice() };
}
