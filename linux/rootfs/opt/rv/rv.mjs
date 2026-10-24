#!/usr/bin/env node
// Container entrypoint and terminal admin tool.
//
//   rv run              (default) game servers + web UI; first-time setup from environment
//                       variables, the web UI's setup wizard, or `rv setup`
//   rv menu | status | mode | start | stop | restart | set | ...   see cli.mjs (rv help)
//   rv setup            first-time setup on the terminal
//   rv reset-password   print a new random web UI password (must be changed at next login)
import net from 'node:net';
import { rmSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { ensureDirs, isConfigured, readState, updateState, MODES, setKitWarmSpare, applyPortOverrideFromEnv } from './lib.mjs';
import { runSetup, optionsFromEnv, detectPublicIp, REGIONS } from './setup.mjs';
import { createManager } from './manager.mjs';
import { CONTROL_SOCK, applySettingDefaults, admin, control } from './ops.mjs';
import { runCommand, menu, HELP } from './cli.mjs';
import { startKitAutoUpdate } from './kit-update.mjs';
import { startImageAutoUpdate, playersNow } from './image-update.mjs';
import { prepareModes, releaseModes, createPairs, restartActive, pairsCli } from './pairs.mjs';
import { kitHasWarmSpare, prepareWarmSpare, applySpareModeSelection, selectedSpareModes, spareCli } from './warmspare.mjs';
import { plan as zeroWaitPlan, activePlan, activeKind, recordActive, requestedMethod, setMethod, methodLabel, kindLabel } from './zerowait.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const cmd = process.argv[2] || 'run';
const webUiEnabled = !/^(0|false|no|off)$/i.test(process.env.RV_WEBUI || 'on');

// Lets `rv` commands in other processes (podman exec) start, stop and restart the supervisor
// that this process owns. Unix socket in the data folder; only root in the container can use it.
// start/stop/restart also cover the server pairs, which are not the supervisor's children.
function startControlSocket(manager, setupJob, hooks) {
    rmSync(CONTROL_SOCK, { force: true });
    // allowHalfOpen: the client ends its side after sending; we still need ours to reply.
    const srv = net.createServer({ allowHalfOpen: true }, sock => {
        let data = '';
        sock.on('data', d => { data += d; });
        sock.on('end', async () => {
            const reply = obj => { try { sock.end(JSON.stringify(obj)); } catch { /* client gone */ } };
            try {
                const { command, method } = JSON.parse(data || '{}');
                if (command === 'state') return reply({ success: true, state: manager.state(), setup: { running: setupJob.running, error: setupJob.error } });
                if (command === 'zero-wait-method') return reply({ success: true, message: setMethod(method) });
                if (!['start', 'stop', 'restart', 'restart-all'].includes(command)) return reply({ success: false, error: 'unknown command' });
                if (!isConfigured()) return reply({ success: false, error: 'The server is not set up yet.' });
                if (command === 'restart-all') return reply({ success: true, restarted: await hooks.restartAll() });
                await hooks[command]();
                reply({ success: true, state: manager.state() });
            } catch (e) { reply({ success: false, error: e.message }); }
        });
    });
    srv.listen(CONTROL_SOCK, () => { try { chmodSync(CONTROL_SOCK, 0o600); } catch { /* ignore */ } });
    return srv;
}

async function run() {
    ensureDirs();
    const manager = createManager({ log });
    const setupJob = { running: false, error: '', done: false, log: [] };

    // Zero Wait: one method for the whole server, chosen by the owner (zerowait.mjs). "pairs" is the
    // old one-port method (pairs.mjs), "spare" is the server kit's warm spare (warmspare.mjs).
    let pairs = null;           // the pair controller while the pairs method runs
    let switchTimer = null;     // asked for spares: switch when the kit brings them
    let watchTimer = null;      // the requested method changed
    let pendingSince = 0;
    let switching = false;
    let spareGoneLogged = false;
    let stopping = false;

    // Every game server the container owns: the pair servers first (they are not the supervisor's
    // children), then the supervisor and its own servers.
    async function shutdown(sig) {
        if (stopping) return;
        stopping = true;
        log(`[rv] ${sig} - stopping the game servers`);
        try { if (pairs) await pairs.stop(); } catch (e) { log(`[rv] stop error: ${e.message}`); }
        pairs = null;
        try { await manager.stop(); } catch (e) { log(`[rv] stop error: ${e.message}`); }
        rmSync(CONTROL_SOCK, { force: true });
        process.exit(0);
    }

    function reportPlan(p) {
        if (p.warned) log(`[zerowait] ${p.warned}`);
        else if (p.reason) log(`[zerowait] ${p.reason}`);
    }

    // The per-mode Zero Wait choice follows a method switch. Only a real transition writes the other
    // method's store, so an operator's spare-era ini edits survive container restarts.
    function seedTransition(kind) {
        const st = readState(), prev = st.zeroWaitActive?.kind;
        if (prev === undefined) {
            // First start of this image: a box that ran spares keeps the modes chosen in its inis.
            if (st.warmSpareSet) updateState({ swapModes: selectedSpareModes() });
        } else if (prev === 'spare' && kind !== 'spare') {
            updateState({ swapModes: selectedSpareModes() });
        } else if (prev !== 'spare' && kind === 'spare') {
            applySpareModeSelection(log);
        }
    }

    async function ensurePairs() {
        if (pairs) return true;
        try { pairs = createPairs({ log }); return true; }
        catch (e) { log(`[pairs] could not start: ${e.message}`); return false; }
    }

    async function stopPairs() {
        if (!pairs) return;
        const p = pairs; pairs = null;
        try { await p.stop(); } catch (e) { log(`[pairs] stop error: ${e.message}`); }
    }

    // createPairs failed after the supervisor started: use the kit's spares if it has them.
    async function fallbackFromPairs(p) {
        await stopPairs();
        if (kitHasWarmSpare()) {
            log('[zerowait] server pairs failed to start - using the server kit warm spare');
            releaseModes(log, 'server pairs failed');
            prepareWarmSpare(log);
            recordActive({ ...p, kind: 'spare', warned: 'Server pairs failed to start. Zero Wait uses the server kit warm spare instead.' });
            await manager.restart();
            return;
        }
        setKitWarmSpare(false);
        releaseModes(log, 'server pairs failed and the kit has no warm spare');
        recordActive({ ...p, kind: 'none', reason: 'Server pairs failed to start and the server kit has no warm spare.' });
        await manager.restart();
    }

    async function startServers() {
        const ports = applyPortOverrideFromEnv(msg => log(`[ports] ${msg}`));
        if (ports) log(`[ports] ${ports.servers.map(x => `${x.id} ${x.port}${x.sparePort !== undefined ? ` (spare ${x.sparePort})` : ''}`).join(', ')}`);
        const p = zeroWaitPlan();
        seedTransition(p.kind);
        reportPlan(p);
        log(`[zerowait] method ${p.requested} - ${kindLabel(p.kind)}`);
        if (p.kind === 'spare') {
            releaseModes(log, "Zero Wait runs on the server kit's warm spares");
            prepareWarmSpare(log);   // writes warmSpare:true before the supervisor starts
            recordActive(p);
            await manager.start();
            startKitGainTimer();
            return;
        }
        if (p.kind === 'pairs') {
            if (!prepareModes(log)) {   // writes warmSpare:false and modes.main.json
                log('[pairs] the server is not set up yet - running single servers');
                setKitWarmSpare(false);
                recordActive({ ...p, kind: 'none', reason: 'The server is not set up yet.' });
                await manager.start();
                return;
            }
            recordActive(p);
            await manager.start();
            if (!await ensurePairs()) { await fallbackFromPairs(p); return; }
            startKitGainTimer();
            return;
        }
        releaseModes(log, 'Zero Wait is off');
        setKitWarmSpare(p.requested === 'spare');
        recordActive(p);
        await manager.start();
        startKitGainTimer();
    }

    // Asked for spares but running without them: switch once the kit brings them, when empty.
    function startKitGainTimer() {
        if (switchTimer) return;
        let since = 0;
        switchTimer = setInterval(async () => {
            if (switching) return;
            if (requestedMethod() !== 'spare' || (kitHasWarmSpare() && activeKind() === 'spare')) {
                clearInterval(switchTimer); switchTimer = null; return;
            }
            if (!kitHasWarmSpare()) return;
            since ||= Date.now();
            const n = await playersNow().catch(() => null);
            const empty = n === 0 || (n === null && manager.state().state === 'stopped');
            const maxH = Number(process.env.RV_IMAGE_UPDATE_MAX_HOURS) > 0 ? Number(process.env.RV_IMAGE_UPDATE_MAX_HOURS) : 6;
            if (!empty && Date.now() - since < maxH * 3600 * 1000) return;
            clearInterval(switchTimer); switchTimer = null;
            switching = true;
            log('[spare] the server kit now has the warm spare - restarting to run Zero Wait on it instead of server pairs');
            shutdown('switch to warm spares');
        }, 60000);
        switchTimer.unref();
    }

    // The owner changed the method: apply it when every server is empty, at most 30 minutes.
    function startMethodWatcher() {
        watchTimer = setInterval(async () => {
            if (switching || setupJob.running || !isConfigured()) return;
            const active = readState().zeroWaitActive;
            if (!active || !active.kind) return;
            const req = requestedMethod();
            if (req === active.requested) {
                pendingSince = 0;
                if (active.kind === 'spare' && !kitHasWarmSpare() && !spareGoneLogged) {
                    spareGoneLogged = true;
                    log('[spare] the server kit no longer has the warm spare - spares stop until the container restarts');
                }
                return;
            }
            const p = zeroWaitPlan();
            if (p.kind === active.kind) {
                // Same behavior, only the request changed (for example both fall back): no restart.
                if (p.warned) log(`[zerowait] ${p.warned}`);
                recordActive({ ...active, requested: req, reason: p.reason || '', warned: p.warned || '' });
                pendingSince = 0;
                return;
            }
            pendingSince ||= Date.now();
            const players = await playersNow().catch(() => null);
            const empty = players === 0 || (players === null && manager.state().state === 'stopped');
            const maxMs = (Number(process.env.RV_ZEROWAIT_APPLY_MAX_MIN) || 30) * 60000;
            if (empty || Date.now() - pendingSince >= maxMs) {
                switching = true;
                log(`[zerowait] method change to ${req} (${kindLabel(p.kind)}) - restarting the container`);
                shutdown('Zero Wait method change');
            }
        }, 60000);
        watchTimer.unref();
    }

    // Supervisor commands from the web page and the control socket, with the pair servers included.
    const hooks = {
        async start() {
            await manager.start();
            if (activeKind() === 'pairs') await ensurePairs();
        },
        async stop() {
            await stopPairs();
            await manager.stop();
        },
        async restart() {
            await manager.restart();
            if (activeKind() === 'pairs') await ensurePairs();
        },
        async restartAll() {
            const done = [];
            for (const m of (readState().pairedModes || [])) if (restartActive(m)) done.push(m);
            try {
                const list = (await admin('/instances')).instances || [];
                for (const i of list) if (i.want === 'running' && !i.modeOff) { await admin(`/instances/${i.id}/restart`, 'POST'); done.push(i.id); }
            } catch { /* supervisor stopped: the pair restarts above still happened */ }
            return done;
        },
    };

    function startSetup(opts) {
        if (setupJob.running) return;
        Object.assign(setupJob, { running: true, error: '', done: false, log: [] });
        const say = msg => { setupJob.log.push(msg); log(`[setup] ${msg}`); };
        runSetup(opts, say)
            .then(() => { setupJob.done = true; applySettingDefaults(log); return startServers(); })
            .catch(e => { setupJob.error = e.message; say(`SETUP STOPPED: ${e.message}`); })
            .finally(() => { setupJob.running = false; });
    }

    startControlSocket(manager, setupJob, hooks);
    startKitAutoUpdate(log);
    if (webUiEnabled) {
        const { ensureAuth } = await import('./webui/auth.mjs');
        const { startWebUi } = await import('./webui/server.mjs');
        ensureAuth();
        startWebUi({ manager, setupJob, startSetup, log, actions: hooks,
            port: Number(process.env.RV_WEBUI_PORT || 8080), host: process.env.RV_WEBUI_BIND || '0.0.0.0' });
    } else {
        log('[rv] web UI disabled (RV_WEBUI=off) - manage the server with: podman exec -it <container> rv menu');
    }

    if (isConfigured()) {
        log(`[rv] server ${readState().nodeId} is set up - starting`);
        applySettingDefaults(log);
        await startServers();
    } else {
        const opts = optionsFromEnv();
        if (opts) { log('[rv] first-time setup from environment variables'); startSetup(opts); }
        else log(`[rv] not set up yet - ${webUiEnabled ? 'open the web UI and follow the setup wizard, or run' : 'run'}: podman exec -it <container> rv setup`);
    }
    startMethodWatcher();

    // A newer image: stop everything cleanly and exit; the service manager starts the container again,
    // pulling the new image (Quadlet Pull=newer).
    startImageAutoUpdate(log, () => shutdown('image update'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

async function interactiveSetup() {
    if (!process.stdin.isTTY) throw new Error('Setup needs a terminal: podman exec -it <container> rv setup');
    if (isConfigured()) console.log('\n  Note: this server is already set up. Running setup again keeps its registration and secrets.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, def = '') => (await rl.question(`  ${q}${def ? ` [${def}]` : ''}: `)).trim() || def;
    console.log('\n  Rumbleverse server setup\n');
    const env = optionsFromEnv() || {};
    const edition = (await ask('Private (you + friends) or community (public, needs approval)? private/community', env.edition || 'community')).toLowerCase();
    const o = { edition, zip: process.env.RV_GAME_ZIP || '/game.zip' };
    if (edition === 'private') o.setupCode = await ask('Setup code from your launcher (Server Status > My private servers)', env.setupCode);
    else o.contact = await ask('Your Discord name (so the admins can reach you about approval)', env.contact);
    o.name = await ask('Server name', env.name || readState().name || (edition === 'private' ? 'Linux private server' : ''));
    o.publicIp = await ask('Public IP players connect to', env.publicIp || await detectPublicIp());
    o.publicIps = await ask('Additional public IPs (comma separated, optional)', env.publicIps || '');
    if (edition !== 'private') o.region = await ask(`Region (${Object.keys(REGIONS).join(', ')}; empty = measure)`, env.region || '');
    const modes = await ask(`Modes (${MODES.map(m => m.key).join(', ')} or all)`, env.modes?.join(',') || (edition === 'private' ? 'playground' : 'solo,playground'));
    o.modes = modes === 'all' ? MODES.map(m => m.key) : modes.split(',').map(s => s.trim()).filter(Boolean);
    rl.close();
    await runSetup(o, msg => console.log(`  ${msg}`));
    try {
        const { control } = await import('./ops.mjs');
        await control('restart');
        console.log('\n  Servers started.\n');
    } catch { console.log('\n  Restart the container to start the servers: podman restart <container>\n'); }
}

try {
    if (cmd === 'run') await run();
    else if (cmd === 'setup') await interactiveSetup();
    else if (cmd === 'menu') await menu();
    else if (cmd === 'swap') {
        const args = process.argv.slice(3);
        if (args[0] === 'method') {
            if (!args[1]) {
                const a = activePlan(), req = requestedMethod();
                console.log(`Zero Wait method: ${req} - ${methodLabel(req)}`);
                console.log(`Running: ${kindLabel(a.kind)}${a.started ? '' : ' (not started yet)'}${a.pending ? ` - a change to ${methodLabel(req)} waits for the servers to empty` : ''}`);
                if (a.reason) console.log(`Note: ${a.reason}`);
                if (a.warned) console.log(`Note: ${a.warned}`);
            } else {
                try { const r = await control('zero-wait-method', { method: args[1] }); console.log(r.message || `Zero Wait method set to ${args[1]}.`); }
                catch { console.log(setMethod(args[1])); }   // main process not reachable: write it and let the next start use it
            }
        } else {
            const a = activePlan(), req = requestedMethod();
            console.log(`Zero Wait method: ${req} - ${methodLabel(req)}${a.pending ? ' (change pending, applies when empty)' : ''}`);
            if (a.kind === 'spare') await spareCli(args);
            else if (a.kind === 'pairs') await pairsCli(args);
            else console.log(`${a.reason || 'Zero Wait is off (single servers).'}${a.warned ? ` ${a.warned}` : ''}`);
        }
    }
    else if (cmd === 'reset-password') {
        ensureDirs();
        const { resetPassword } = await import('./webui/auth.mjs');
        resetPassword('reset');
        console.log('Log in with the new password (no restart needed).');
    }
    else if (cmd === 'ports') await import('./ports.mjs');   // the installer: servers and ports, nothing written
    else if (cmd === 'help' || cmd === '--help') console.log(HELP);
    else await runCommand(process.argv.slice(2));
} catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
}
