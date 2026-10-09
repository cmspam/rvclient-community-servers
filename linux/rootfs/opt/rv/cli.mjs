// Terminal admin tool: the same controls as the web UI, for use over SSH.
//
//   podman exec -it rvserver rv menu        interactive menu
//   podman exec rvserver rv <command> ...   single commands (see HELP)
import { createInterface } from 'node:readline/promises';
import { MODES, isConfigured } from './lib.mjs';
import * as ops from './ops.mjs';

export const HELP = `Rumbleverse server - terminal admin

  rv menu                              interactive menu
  rv status                            modes, players, memory, supervisor
  rv node                              your server as the backend sees it (review status, versions)
  rv mode <mode> on|off                switch a mode on or off
  rv start|stop|restart <mode>         control one mode's server
  rv restart-all                       restart every running mode
  rv settings <mode>                   show a mode's settings
  rv set <mode> <setting> <value> [--restart]
                                       change a setting (e.g. rv set solo SpawnBot 40)
  rv update | rv rollback              install the latest server kit / go back one version
  rv supervisor start|stop|restart     all game servers at once (stop keeps them down)
  rv logs <supervisor|setup|mode> [lines]
  rv leave                             remove this server from the rVclient server list (before deleting it)
  rv setup                             first-time setup on the terminal
  rv reset-password                    new random web UI password
  rv swap status | restart <mode>      server pairs (RV_SWAP): which one is active, which one waits

  Modes: ${MODES.map(m => m.key).join(', ')}`;

const gb = mb => mb == null ? '-' : `${(mb / 1024).toFixed(2)} GB`;
const up = s => !s ? '-' : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;

async function printStatus() {
    const n = ops.nodeInfo();
    console.log(`Server ${n.name || '-'}  (${n.nodeId || 'not registered'}, ${n.edition || '-'}, ${n.region || '-'}, ${n.publicIp || '-'})`);
    console.log(`Server kit ${n.kitVersion || '-'}`);
    try {
        const sup = await ops.control('state');
        console.log(`Supervisor ${sup.state.state}${sup.state.upSec ? ` for ${up(sup.state.upSec)}` : ''}` +
            (sup.state.pendingRestart ? '  (restart pending after a supervisor update)' : ''));
    } catch (e) { console.log(`Supervisor: ${e.message}`); }
    let list = [];
    try { list = await ops.instances(); } catch (e) { console.log(e.message); return; }
    console.log('');
    console.log(`  ${'Mode'.padEnd(11)} ${'Port'.padEnd(5)} ${'On'.padEnd(4)} ${'State'.padEnd(18)} ${'Players'.padEnd(8)} ${'Uptime'.padEnd(8)} ${'Memory'.padEnd(9)} Restarts/crashes`);
    for (const i of list) {
        console.log(`  ${i.label.padEnd(11)} ${String(i.port).padEnd(5)} ${(i.modeOn ? 'yes' : 'no').padEnd(4)} ${i.state.padEnd(18)} ${String(i.players ?? 0).padEnd(8)} ${up(i.uptimeSec).padEnd(8)} ${gb(i.rssMb).padEnd(9)} ${i.restarts}/${i.crashes}`);
    }
    const y = ops.system();
    console.log(`\nMemory available ${gb(y.memAvailMb)} of ${gb(y.memTotalMb)}   load ${y.load.join(' / ')} (${y.cpus} CPUs)` +
        (y.disk ? `   disk free ${y.disk.freeGb} GB` : ''));
}

async function printNode() {
    const r = await ops.node();
    const nd = r.node || {};
    console.log(`Review status:  ${nd.status || 'unknown'}${nd.reason || nd.statusReason ? `  (${nd.reason || nd.statusReason})` : ''}`);
    console.log(`Server kit:     ${r.localVersion || '-'}${r.latestServerVersion && r.latestServerVersion !== r.localVersion ? `  (newer available: ${r.latestServerVersion})` : ''}`);
    if (r.update?.state) console.log(`Update:         ${r.update.state}${r.update.message ? ` - ${r.update.message}` : ''}`);
}

const hint = x => x.type === 'int' ? ` (${x.min}-${x.max})` : x.type === 'bool' ? ' (true/false)' : '';

function printSettings(mode) {
    const s = ops.getSettings(mode);
    console.log(`${s.label} settings:`);
    for (const x of s.settings) console.log(`  ${x.name.padEnd(22)} ${(x.unset ? '(default)' : String(x.value)).padEnd(10)} ${x.label !== x.name ? x.label : ''}${hint(x)}`);
}

export async function runCommand(args) {
    const [cmd, a, b, c] = args;
    const needSetup = () => { if (!isConfigured()) throw new Error('The server is not set up yet (web UI wizard, or: rv setup).'); };
    switch (cmd) {
        case 'status': return printStatus();
        case 'node': needSetup(); return printNode();
        case 'mode':
            needSetup();
            if (!['on', 'off'].includes(b)) throw new Error('usage: rv mode <mode> on|off');
            return console.log(ops.setMode(a, b === 'on'));
        case 'start': case 'stop': case 'restart':
            needSetup();
            if (!a) throw new Error(`usage: rv ${cmd} <mode>`);
            await ops.instanceAction(a, cmd);
            return console.log(`${cmd} sent to ${a}.`);
        case 'restart-all': needSetup(); return console.log(`Restarting: ${(await ops.restartAll()).join(', ') || 'nothing running'}`);
        case 'settings': needSetup(); if (!a) throw new Error('usage: rv settings <mode>'); return printSettings(a);
        case 'set':
            needSetup();
            if (!a || !b || c === undefined) throw new Error('usage: rv set <mode> <setting> <value> [--restart]');
            return console.log(await ops.saveSettings(a, { [b]: c }, { restart: args.includes('--restart') }));
        case 'update': needSetup(); return console.log((await ops.update()).message || 'Update started.');
        case 'rollback': needSetup(); return console.log((await ops.rollback()).message || 'Rollback started.');
        case 'supervisor':
            needSetup();
            if (!['start', 'stop', 'restart'].includes(a)) throw new Error('usage: rv supervisor start|stop|restart');
            await ops.control(a);
            return console.log(`Supervisor ${a} done.`);
        case 'leave': needSetup(); return console.log(await ops.leave());
        case 'logs': return console.log(ops.tail(ops.logFile(a || 'supervisor'), Number(b) || 100) || '(empty)');
        case 'help': case '--help': case '-h': return console.log(HELP);
        default: throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
    }
}

// ---- interactive menu ----
export async function menu() {
    if (!process.stdin.isTTY) throw new Error('The menu needs a terminal: podman exec -it <container> rv menu');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async q => (await rl.question(q)).trim();
    const pickMode = async () => {
        MODES.forEach((m, k) => console.log(`  ${k + 1}) ${m.label}`));
        const n = Number(await ask('Mode number: '));
        return MODES[n - 1]?.key || null;
    };
    const safely = async fn => { try { await fn(); } catch (e) { console.log(`\n  ${e.message}`); } };
    for (;;) {
        console.log('\n================ Rumbleverse server ================');
        await safely(printStatus);
        console.log(`
  1) Refresh status          6) Restart all modes
  2) Switch a mode on/off    7) Server kit: update / roll back / review status
  3) Restart a mode          8) Stop / start / restart all servers (supervisor)
  4) Stop or start a mode    9) Show a log
  5) Change mode settings    0) Quit`);
        const choice = await ask('\nChoice: ');
        if (choice === '0' || choice === 'q') break;
        await safely(async () => {
            switch (choice) {
                case '1': return;
                case '2': {
                    const m = await pickMode(); if (!m) return;
                    const on = (await ask('On or off? (on/off): ')).toLowerCase();
                    if (!['on', 'off'].includes(on)) return console.log('  Nothing changed.');
                    return console.log('  ' + ops.setMode(m, on === 'on'));
                }
                case '3': {
                    const m = await pickMode(); if (!m) return;
                    if ((await ask(`Restart ${m}? Players on it are disconnected. (y/N): `)).toLowerCase() !== 'y') return;
                    await ops.instanceAction(m, 'restart'); return console.log('  Restart sent.');
                }
                case '4': {
                    const m = await pickMode(); if (!m) return;
                    const what = (await ask('stop or start?: ')).toLowerCase();
                    if (!['stop', 'start'].includes(what)) return console.log('  Nothing changed.');
                    await ops.instanceAction(m, what); return console.log(`  ${what} sent.`);
                }
                case '5': {
                    const m = await pickMode(); if (!m) return;
                    const s = ops.getSettings(m);
                    s.settings.forEach((x, k) => console.log(`  ${k + 1}) ${x.label.padEnd(40)} ${x.unset ? '(default)' : x.value}`));
                    const n = Number(await ask('Setting number (empty = back): '));
                    const x = s.settings[n - 1]; if (!x) return;
                    const v = await ask(`New value for "${x.label}"${hint(x)} [${x.unset ? 'default' : x.value}]: `);
                    if (v === '') return console.log('  Nothing changed.');
                    const now = (await ask('Restart this server now to apply it? A match in progress ends. (y/N): ')).toLowerCase() === 'y';
                    return console.log('  ' + await ops.saveSettings(m, { [x.key]: v }, { restart: now }));
                }
                case '6':
                    if ((await ask('Restart every running mode? Players are disconnected. (y/N): ')).toLowerCase() !== 'y') return;
                    return console.log(`  Restarting: ${(await ops.restartAll()).join(', ') || 'nothing running'}`);
                case '7': {
                    await printNode();
                    const w = (await ask('u) update   r) roll back   empty) back: ')).toLowerCase();
                    if (w === 'u') return console.log('  ' + ((await ops.update()).message || 'Update started.'));
                    if (w === 'r' && (await ask('Roll back to the previous kit? (y/N): ')).toLowerCase() === 'y')
                        return console.log('  ' + ((await ops.rollback()).message || 'Rollback started.'));
                    return;
                }
                case '8': {
                    const w = (await ask('stop / start / restart (empty = back): ')).toLowerCase();
                    if (!['stop', 'start', 'restart'].includes(w)) return;
                    if (w !== 'start' && (await ask(`${w} ALL game servers? (y/N): `)).toLowerCase() !== 'y') return;
                    await ops.control(w); return console.log(`  Supervisor ${w} done.`);
                }
                case '9': {
                    const which = (await ask(`Which log? (supervisor, setup, ${MODES.map(m => m.key).join(', ')}) [supervisor]: `)) || 'supervisor';
                    return console.log(ops.tail(ops.logFile(which), 60) || '(empty)');
                }
                default: return console.log('  Unknown choice.');
            }
        });
    }
    rl.close();
}
