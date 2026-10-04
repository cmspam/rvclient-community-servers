// Web admin UI: the browser counterpart of the Windows "rV Modes (server)" app.
// All server operations come from ../ops.mjs, shared with the terminal tool (rv).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { MODES, readState, isConfigured } from '../lib.mjs';
import { REGIONS, detectPublicIp, measureRegions } from '../setup.mjs';
import * as ops from '../ops.mjs';
import * as auth from './auth.mjs';

const PAGE = new URL('./index.html', import.meta.url).pathname;
const COOKIE = 'rvsess';
const cookieAttrs = 'HttpOnly; SameSite=Strict; Path=/';

function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
        const k = part.indexOf('=');
        if (k > 0) out[part.slice(0, k).trim()] = decodeURIComponent(part.slice(k + 1).trim());
    }
    return out;
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', d => { data += d; if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); } });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    });
}

export function startWebUi({ manager, setupJob, startSetup, port = 8080, host = '0.0.0.0', log = console.log }) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const ip = req.socket.remoteAddress || '';
        const send = (code, obj, extra = {}) => {
            res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
            res.end(JSON.stringify(obj));
        };
        const fail = (code, msg) => send(code, { success: false, error: msg });
        try {
            if (url.pathname === '/healthz') return send(200, { ok: true });
            if (url.pathname === '/' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
                    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
                    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
                return res.end(readFileSync(PAGE));
            }
            if (!url.pathname.startsWith('/api/')) return fail(404, 'not found');
            // State-changing calls must come from our page: JSON body plus a custom header
            // (a cross-site form cannot send either).
            if (req.method !== 'GET' && req.headers['x-rv-ui'] !== '1') return fail(403, 'missing UI header');

            if (url.pathname === '/api/login' && req.method === 'POST') {
                if (auth.rateLimited(ip)) return fail(429, 'Too many tries - wait 10 minutes.');
                const { password } = await readBody(req);
                if (!auth.checkPassword(password)) { auth.noteFailure(ip); return fail(401, 'Wrong password.'); }
                return send(200, { success: true, mustChange: auth.mustChange() },
                    { 'set-cookie': `${COOKIE}=${auth.createSession()}; ${cookieAttrs}; Max-Age=43200` });
            }
            const token = cookies(req)[COOKIE];
            if (!auth.validSession(token)) return fail(401, 'Please log in.');
            if (url.pathname === '/api/logout' && req.method === 'POST') {
                auth.endSession(token);
                return send(200, { success: true }, { 'set-cookie': `${COOKIE}=; ${cookieAttrs}; Max-Age=0` });
            }
            if (url.pathname === '/api/password' && req.method === 'POST') {
                const { current, next } = await readBody(req);
                if (!auth.checkPassword(current)) return fail(400, 'The current password is wrong.');
                if (typeof next !== 'string' || next.length < 10) return fail(400, 'Use at least 10 characters.');
                if (next === current) return fail(400, 'Choose a password different from the current one.');
                auth.setPassword(next);
                auth.endAllSessions();
                return send(200, { success: true }, { 'set-cookie': `${COOKIE}=${auth.createSession()}; ${cookieAttrs}; Max-Age=43200` });
            }
            // Until the generated password is replaced, nothing else is allowed.
            if (auth.mustChange()) return fail(403, 'Choose a new password first.');

            const route = `${req.method} ${url.pathname}`;
            if (route === 'GET /api/status') {
                const configured = isConfigured();
                let instances = [], supError = '';
                if (configured) { try { instances = await ops.instances(); } catch (e) { supError = e.message; } }
                const n = ops.nodeInfo();
                return send(200, {
                    success: true, configured, supervisor: manager.state(), supError, instances, system: ops.system(),
                    setup: { running: setupJob.running, error: setupJob.error, done: setupJob.done },
                    node: { ...n, regionName: REGIONS[n.region] || '' },
                });
            }
            if (route === 'GET /api/node') return send(200, await ops.node());
            if (route === 'POST /api/node/update') return send(200, await ops.update());
            if (route === 'POST /api/node/rollback') return send(200, await ops.rollback());
            const im = url.pathname.match(/^\/api\/instances\/([A-Za-z0-9_-]+)\/(start|stop|restart)$/);
            if (im && req.method === 'POST') return send(200, await ops.instanceAction(im[1], im[2]));
            if (route === 'POST /api/restart-all') return send(200, { success: true, restarted: await ops.restartAll() });
            if (route === 'POST /api/modes') {
                const { mode, on } = await readBody(req);
                return send(200, { success: true, message: ops.setMode(mode, on === true) });
            }
            const sm = url.pathname.match(/^\/api\/settings\/([a-z]+)$/);
            if (sm && req.method === 'GET') return send(200, { success: true, ...ops.getSettings(sm[1]) });
            if (sm && req.method === 'POST') {
                const { values = {}, restart = false } = await readBody(req);
                return send(200, { success: true, message: await ops.saveSettings(sm[1], values, { restart }) });
            }
            const pm = url.pathname.match(/^\/api\/supervisor\/(start|stop|restart)$/);
            if (pm && req.method === 'POST') {
                if (!isConfigured()) return fail(400, 'Finish the setup first.');
                manager[pm[1]]().catch(e => log(`[rv] supervisor ${pm[1]} failed: ${e.message}`));
                return send(200, { success: true });
            }
            if (route === 'GET /api/logs') {
                const lines = Math.min(2000, Number(url.searchParams.get('lines') || 200));
                return send(200, { success: true, text: ops.tail(ops.logFile(url.searchParams.get('which') || 'supervisor'), lines) });
            }
            if (route === 'GET /api/setup') {
                const s = readState();
                return send(200, { success: true, configured: isConfigured(), running: setupJob.running, error: setupJob.error,
                    done: setupJob.done, log: setupJob.log.slice(-400), state: { nodeId: s.nodeId, edition: s.edition, name: s.name } });
            }
            if (route === 'GET /api/setup/detect') {
                const [ip, pings] = await Promise.all([detectPublicIp(), measureRegions()]);
                // How many modes fit: about 3.8 GB for the first, about 1.7 GB for each further one with
                // memory sharing (RV_KSM=on), 3.8 GB each without; about 0.9 GB kept for everything else.
                const memMb = ops.system().memTotalMb || 0, usable = memMb - 900;
                const ksm = /^(1|on|yes|true)$/i.test(process.env.RV_KSM || '');
                const fit = Math.max(1, Math.min(5, ksm ? 1 + Math.floor((usable - 3900 - 1800) / 1800) : Math.floor(usable / 3900)));
                return send(200, { success: true, publicIp: ip, pings, regions: REGIONS, modes: MODES, memMb, ksm, fit });
            }
            if (route === 'POST /api/setup') {
                if (setupJob.running) return fail(409, 'Setup is already running.');
                const b = await readBody(req);
                const modes = Array.isArray(b.modes) ? b.modes.filter(m => MODES.some(x => x.key === m)) : [];
                startSetup({ edition: b.edition, setupCode: String(b.setupCode || '').trim(), contact: String(b.contact || '').trim(),
                    name: String(b.name || '').trim().slice(0, 60), modes, publicIp: String(b.publicIp || '').trim(), region: String(b.region || '').trim(),
                    nodeId: String(b.nodeId || '').trim(), nodeKey: String(b.nodeKey || '').trim() });
                return send(200, { success: true });
            }
            return fail(404, 'not found');
        } catch (e) {
            return fail(500, e.message);
        }
    });
    server.listen(port, host, () => log(`[rv] web UI on http://${host}:${port}`));
    return server;
}
