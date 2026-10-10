// Preloaded into the upstream supervisor (node --import linux-shim.mjs ds-supervisor.js ...).
//
// The supervisor starts each game server with spawn('<...>/RumbleverseClient-Win64-Shipping.exe',
// args). Linux cannot execute a Windows binary directly, so any *.exe passed to spawn/execFile is
// run through Wine instead. The upstream files stay exactly as the server kit delivers them, so
// kit updates keep applying unchanged.
//
// The kit's updater installs a file by copying it over the old one (copyFileSync). On Windows a
// loaded DLL is locked, so it is moved aside and running servers keep the old image. Linux has no
// such lock: the copy would rewrite the file a running server has mapped (Server.dll), which freezes
// it mid-match. So an existing file is replaced the Linux way instead: the copy goes to a temporary
// file in the same folder, which is then renamed over the old one. Running servers keep the old
// file they have open; the next start loads the new one.
//
// Game servers start at the lowest CPU priority until they are joinable (bootnice.mjs).
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { readState, readJson, MODES, DATA, INSTANCES, SUP_DIR } from './lib.mjs';
import { applySlim } from './slim.mjs';
import { applyBots } from './bots.mjs';
import { applyAddons } from './addons.mjs';
import { lowPriorityPrefix, normalPriorityWhenJoinable } from './bootnice.mjs';

const WINE = process.env.RV_WINE || 'wine';
// RV_KSM=on: start through rv-ksm, which marks the game server's memory as mergeable, so the
// kernel's KSM keeps identical pages of several servers only once (needs CAP_SYS_RESOURCE and
// KSM switched on on the host: /sys/kernel/mm/ksm/run = 1).
const KSM = /^(1|on|yes|true)$/i.test(process.env.RV_KSM || '');
const originalSpawn = childProcess.spawn;
const isExe = cmd => typeof cmd === 'string' && /\.exe$/i.test(cmd);

function viaWine(fn) {
    return function (cmd, args, ...rest) {
        if (!isExe(cmd)) return fn.call(this, cmd, args, ...rest);
        if (!Array.isArray(args)) { rest.unshift(args); args = []; }
        applySlim(cmd);
        applyBots(cmd);
        applyAddons(cmd);
        // nice 19 until joinable (bootnice.mjs), then rv-ksm (RV_KSM), then Wine.
        const run = [...lowPriorityPrefix(), ...(KSM ? ['rv-ksm'] : []), WINE, cmd, ...args];
        const child = fn.call(this, run[0], run.slice(1), ...rest);
        if (fn === originalSpawn) normalPriorityWhenJoinable(cmd, args, child);
        return child;
    };
}

for (const name of ['spawn', 'execFile', 'spawnSync', 'execFileSync']) {
    childProcess[name] = viaWine(childProcess[name]);
}

const copyFileSync = fs.copyFileSync;
export function replacingCopyFileSync(src, dest, mode = 0) {
    // COPYFILE_EXCL must fail on an existing file, and a missing file has nothing to protect.
    if (mode & fs.constants.COPYFILE_EXCL || typeof dest !== 'string' || !fs.existsSync(dest)) return copyFileSync(src, dest, mode);
    const tmp = join(dirname(dest), `.${basename(dest)}.rv-new-${process.pid}`);
    try {
        copyFileSync(src, tmp, mode);
        fs.renameSync(tmp, dest);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* not created */ }
        throw e;
    }
}
fs.copyFileSync = replacingCopyFileSync;

// RV_SHARE_STATS=off: the node agent's reports to the backend leave out its "box" section (this
// machine's CPU and RAM use). Everything else in the reports is sent unchanged. Default: sent.
export const SHARE_STATS = !/^(0|off|no|false)$/i.test(process.env.RV_SHARE_STATS || 'on');
export function withoutBoxStats(body) {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    if (typeof text !== 'string' || !text.includes('"box"')) return body;
    let obj;
    try { obj = JSON.parse(text); } catch { return body; }
    if (!obj || typeof obj !== 'object') return body;
    let changed = false;
    if ('box' in obj) { delete obj.box; changed = true; }
    if (obj.health && typeof obj.health === 'object' && 'box' in obj.health) { delete obj.health.box; changed = true; }
    return changed ? Buffer.from(JSON.stringify(obj)) : body;
}
function withoutStatsRequest(request) {
    return function (...args) {
        const req = request.apply(this, args);
        const end = req.end;
        req.end = function (data, ...rest) {
            if (data != null && typeof data !== 'function' && /^\/nodes\//.test(req.path || '')) {
                const out = withoutBoxStats(data);
                if (out !== data && !req.headersSent) { req.setHeader('content-length', out.length); data = out; }
            }
            return end.call(this, data, ...rest);
        };
        return req;
    };
}
if (!SHARE_STATS) {
    http.request = withoutStatsRequest(http.request);
    https.request = withoutStatsRequest(https.request);
}

// Server pairs (pairs.mjs): the pair controller runs the paired modes' game servers itself; the main
// supervisor's node agent still speaks for the whole box. It reports the paired modes as running, with the
// pair's active server's state, and backend commands for them go to the pair: restart restarts the active
// server (the waiting one takes over), mode switches go into modes.json (the owner's choice, which pairs.mjs
// splits up).
const STATUS_FILE = join(DATA, 'swap', 'status.json');
function pathOf(args) {
    const a = args[0];
    try {
        if (a instanceof URL) return a.pathname;
        if (typeof a === 'string') return new URL(a).pathname;
        if (a && typeof a === 'object') return String(a.path || '').split('?')[0];
    } catch { /* not a URL */ }
    return '';
}
const parse = data => { try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return null; } };
const pairedModes = () => MODES.filter(m => (readState().pairedModes || []).includes(m.key));
const mainUsesSplitModes = () => String(readJson(INSTANCES, {})?.modesFile || '').endsWith('modes.main.json');
export function pairedOn(body, ids) {
    const obj = parse(body);
    let changed = false;
    for (const s of obj?.servers || []) if (ids.has(s.instance) && s.off) { s.off = false; changed = true; }
    return changed ? Buffer.from(JSON.stringify(obj)) : body;
}
// The node agent's health report: paired modes as their active server is.
export function pairedHealth(body, paired, status) {
    const obj = parse(body);
    if (!obj?.health?.servers) return body;
    for (const s of obj.health.servers) {
        const m = paired.find(x => x.id === s.id), st = m && status?.modes?.[m.key];
        if (!st) continue;
        const d = st.activeDetails || {};
        Object.assign(s, { running: !!d.running, heartbeat: st.activeState === 'up', players: d.players ?? 0,
            uptimeSec: d.uptimeSec ?? 0, restarts: st.restarts ?? s.restarts, modeOff: false });
    }
    return Buffer.from(JSON.stringify(obj));
}
// Backend commands this process carries out itself (they would go to the wrong place in the supervisor).
async function takeCommand(cmd, paired) {
    const m = paired.find(x => x.id === cmd.instance) || MODES.find(x => x.id === cmd.instance);
    if (cmd.type === 'restart' && m && paired.includes(m)) {
        const { restartActive } = await import('./pairs.mjs');
        return restartActive(m.key) ? `restarting the active server of the ${m.label} pair (the waiting one takes over)` : `${m.label}: no server to restart`;
    }
    if (cmd.type === 'mode' && m && mainUsesSplitModes()) {
        const f = join(SUP_DIR, 'modes.json'), obj = readJson(f, {});
        obj[m.key] = cmd.on === true;
        fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
        return `mode "${m.key}" switched ${cmd.on ? 'ON' : 'OFF'} in the modes file`;
    }
    return null;
}
function forMain(request, path, args) {
    const paired = pairedModes();
    if (path !== '/nodes/register' && path !== '/nodes/poll') return request.apply(this, args);
    let auth = {};
    const i = args.findIndex(a => typeof a === 'function');
    if (path === '/nodes/poll' && i >= 0) {
        const cb = args[i];
        args = [...args];
        args[i] = res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', async () => {
                const raw = Buffer.concat(chunks), obj = parse(raw);
                const keep = [];
                for (const cmd of obj?.commands || []) {
                    let message = null, ok = true;
                    try { message = await takeCommand(cmd, paired); } catch (e) { ok = false; message = e.message; }
                    if (message === null) { keep.push(cmd); continue; }
                    console.log(`${new Date().toISOString()} [node] command ${cmd.id} ${cmd.type} ${cmd.instance || ''}: ${ok ? 'done' : 'FAILED'} - ${message}`);
                    const ack = request.call(http, new URL('/nodes/ack', args[0] instanceof URL || typeof args[0] === 'string' ? args[0] : `http://${args[0].host || args[0].hostname}`), { method: 'POST',
                        agent: false, headers: { 'content-type': 'application/json' } }, r => r.resume());
                    ack.on('error', () => {});
                    ack.end(JSON.stringify({ ...auth, commandId: cmd.id, ok, message }));
                }
                // restart-all: the agent restarts the main supervisor's servers, the pairs' active servers restart here
                if (keep.some(c => c.type === 'restart-all') && paired.length) {
                    const { restartActive } = await import('./pairs.mjs');
                    for (const m of paired) restartActive(m.key);
                }
                const out = obj && keep.length !== (obj.commands || []).length ? Buffer.from(JSON.stringify({ ...obj, commands: keep })) : raw;
                const fake = new PassThrough();
                Object.assign(fake, { statusCode: res.statusCode, headers: res.headers });
                cb(fake);
                fake.end(out);
            });
        };
    }
    const req = request.apply(this, args);
    const end = req.end;
    req.end = function (data, ...rest) {
        if (data != null && typeof data !== 'function') {
            const body = parse(data);
            if (body) auth = { nodeId: body.nodeId, key: body.key };
            let out = data;
            if (paired.length && path === '/nodes/register') out = pairedOn(data, new Set(paired.map(m => m.id)));
            if (paired.length && path === '/nodes/poll') out = pairedHealth(data, paired, readJson(STATUS_FILE, null));
            if (out !== data && !req.headersSent) { req.setHeader('content-length', out.length); data = out; }
        }
        return end.call(this, data, ...rest);
    };
    return req;
}
function forPairs(request) {
    return function (...args) {
        const path = pathOf(args);
        if (!path.startsWith('/nodes/')) return request.apply(this, args);
        return forMain.call(this, request, path, args);
    };
}
http.request = forPairs(http.request);
https.request = forPairs(https.request);

// Make `import { spawn } from 'node:child_process'` (and copyFileSync from 'node:fs', request
// from 'node:http') in the upstream modules see the wrappers.
syncBuiltinESMExports();
