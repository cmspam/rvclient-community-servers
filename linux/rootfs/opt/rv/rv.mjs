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
import { ensureDirs, isConfigured, readState, MODES } from './lib.mjs';
import { runSetup, optionsFromEnv, detectPublicIp, REGIONS } from './setup.mjs';
import { createManager } from './manager.mjs';
import { CONTROL_SOCK, applySettingDefaults } from './ops.mjs';
import { runCommand, menu, HELP } from './cli.mjs';
import { startKitAutoUpdate } from './kit-update.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const cmd = process.argv[2] || 'run';
const webUiEnabled = !/^(0|false|no|off)$/i.test(process.env.RV_WEBUI || 'on');

// Lets `rv` commands in other processes (podman exec) start, stop and restart the supervisor
// that this process owns. Unix socket in the data folder; only root in the container can use it.
function startControlSocket(manager, setupJob) {
    rmSync(CONTROL_SOCK, { force: true });
    // allowHalfOpen: the client ends its side after sending; we still need ours to reply.
    const srv = net.createServer({ allowHalfOpen: true }, sock => {
        let data = '';
        sock.on('data', d => { data += d; });
        sock.on('end', async () => {
            const reply = obj => { try { sock.end(JSON.stringify(obj)); } catch { /* client gone */ } };
            try {
                const { command } = JSON.parse(data || '{}');
                if (command === 'state') return reply({ success: true, state: manager.state(), setup: { running: setupJob.running, error: setupJob.error } });
                if (!['start', 'stop', 'restart'].includes(command)) return reply({ success: false, error: 'unknown command' });
                if (!isConfigured()) return reply({ success: false, error: 'The server is not set up yet.' });
                await manager[command]();
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

    function startSetup(opts) {
        if (setupJob.running) return;
        Object.assign(setupJob, { running: true, error: '', done: false, log: [] });
        const say = msg => { setupJob.log.push(msg); log(`[setup] ${msg}`); };
        runSetup(opts, say)
            .then(() => { setupJob.done = true; applySettingDefaults(log); return manager.start(); })
            .catch(e => { setupJob.error = e.message; say(`SETUP STOPPED: ${e.message}`); })
            .finally(() => { setupJob.running = false; });
    }

    startControlSocket(manager, setupJob);
    startKitAutoUpdate(log);
    if (webUiEnabled) {
        const { ensureAuth } = await import('./webui/auth.mjs');
        const { startWebUi } = await import('./webui/server.mjs');
        ensureAuth();
        startWebUi({ manager, setupJob, startSetup, log,
            port: Number(process.env.RV_WEBUI_PORT || 8080), host: process.env.RV_WEBUI_BIND || '0.0.0.0' });
    } else {
        log('[rv] web UI disabled (RV_WEBUI=off) - manage the server with: podman exec -it <container> rv menu');
    }

    if (isConfigured()) {
        log(`[rv] server ${readState().nodeId} is set up - starting`);
        applySettingDefaults(log);
        await manager.start();
    } else {
        const opts = optionsFromEnv();
        if (opts) { log('[rv] first-time setup from environment variables'); startSetup(opts); }
        else log(`[rv] not set up yet - ${webUiEnabled ? 'open the web UI and follow the setup wizard, or run' : 'run'}: podman exec -it <container> rv setup`);
    }

    let stopping = false;
    const shutdown = async sig => {
        if (stopping) return;
        stopping = true;
        log(`[rv] ${sig} - stopping the game servers`);
        try { await manager.stop(); } catch (e) { log(`[rv] stop error: ${e.message}`); }
        rmSync(CONTROL_SOCK, { force: true });
        process.exit(0);
    };
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
    else if (cmd === 'swap') await (await import('./swap.mjs')).main(process.argv.slice(3));
    else if (cmd === 'reset-password') {
        ensureDirs();
        const { resetPassword } = await import('./webui/auth.mjs');
        resetPassword('reset');
        console.log('Log in with the new password (no restart needed).');
    }
    else if (cmd === 'help' || cmd === '--help') console.log(HELP);
    else await runCommand(process.argv.slice(2));
} catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
}
