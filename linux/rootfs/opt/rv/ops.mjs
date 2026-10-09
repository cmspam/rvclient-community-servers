// Server operations shared by the web UI and the terminal tool (rv), so both always do the same.
//
// Everything goes through the places the Windows "rV Modes (server)" app uses: the supervisor's
// local admin API, modes.json (modes on/off) and Config.<mode>.ini (game settings).
import { pairStatus, restartActive } from './pairs.mjs';
import { existsSync, statSync, openSync, readSync, closeSync, writeFileSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { INSTANCES, SUP_DIR, WIN64, LOGS, SETUP_LOG, STATE_DIR, MODES, readJson, readState, updateState, isConfigured, kitVersion,
    readIni, setIniValues, gameProcesses } from './lib.mjs';

export const CONTROL_SOCK = join(STATE_DIR, 'control.sock');

// Settings shown per mode. Other keys found in these sections are listed too, with their raw name.
export const SETTING_INFO = {
    'Game Settings/SpawnBot': { label: 'Bots per match', type: 'int', min: 0, max: 60 },
    'Game Settings/WaitingCountdown': { label: 'Barge countdown (seconds)', type: 'int', min: 0, max: 600 },
    'Game Settings/EmptyMatchRestartSec': { label: 'Restart an empty match after (seconds)', type: 'int', min: 0, max: 3600 },
    'Game Settings/PlaygroundTeamSize': { label: 'Playground team size (0 = default)', type: 'int', min: 0, max: 4 },
    'Player Settings/StartingCoreValue': { label: 'Starting Core stat', type: 'int', min: 0, max: 100 },
    'Player Settings/StartingArmsValue': { label: 'Starting Arms stat', type: 'int', min: 0, max: 100 },
    'Player Settings/StartingLegsValue': { label: 'Starting Legs stat', type: 'int', min: 0, max: 100 },
    // The same switches the Windows rV Modes app offers. Server.dll reads them from [Game Settings];
    // a key that is not in the file yet uses the server's built-in default until it is set here.
    'Game Settings/BotNavigation': { label: 'Bot navigation (bots find real paths; small extra CPU)', type: 'bool' },
    'Game Settings/OutfitCheck': { label: 'Remove invisible players', type: 'bool' },
    'Game Settings/OutfitGraceSec': { label: 'Invisible player grace (seconds)', type: 'int', min: 0, max: 600 },
    'Game Settings/KickNoClothing': { label: 'Remove players with no clothing', type: 'bool' },
    'Game Settings/HeldItemFix': { label: 'Held item fix (clears items stuck in a player\'s hand)', type: 'bool' },
};

// Settings this image turns on for every mode. Written only where the key is not in the file yet, so
// a value an operator set (also false) is kept.
export const SETTING_DEFAULTS = {
    'Game Settings/BotNavigation': 'true',
    'Game Settings/HeldItemFix': 'true',
};

export function applySettingDefaults(log = () => {}) {
    for (const m of MODES) {
        const file = join(WIN64, `Config.${m.key}.ini`);
        if (!existsSync(file)) continue;
        const ini = readIni(file);
        const bySection = {};
        for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
            if (!(k in ini)) (bySection[k.split('/')[0]] ||= {})[k.split('/')[1]] = v;
        }
        for (const [sec, vals] of Object.entries(bySection)) {
            setIniValues(file, sec, vals);
            log(`[rv] ${m.key}: default settings added: ${Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
    }
}
const BOOL_VALUES = { true: 'true', on: 'true', yes: 'true', 1: 'true', false: 'false', off: 'false', no: 'false', 0: 'false' };
const EDITABLE_SECTIONS = ['Game Settings', 'Player Settings'];
const LOCKED = new Set(['Game Settings/GameMode', 'Game Settings/RequireMatchmadeJoin']);   // written by setup

// ---- supervisor admin API (127.0.0.1, token from ds-instances.json) ----
export async function admin(path, method = 'GET') {
    const cfg = readJson(INSTANCES);
    if (!cfg) throw new Error('The server is not set up yet.');
    let r;
    try {
        r = await fetch(`http://127.0.0.1:${cfg.adminPort || 9988}${path}`, {
            method, headers: { 'x-admin-token': cfg.adminToken || '' }, signal: AbortSignal.timeout(path.startsWith('/node') ? 20000 : 8000),
        });
    } catch { throw new Error('The supervisor is not running.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || `supervisor answered HTTP ${r.status}`);
    return j;
}

// ---- control socket of the main process (supervisor start/stop/restart and its state) ----
export function control(command) {
    return new Promise((resolve, reject) => {
        const s = net.connect(CONTROL_SOCK);
        let data = '';
        s.setTimeout(60000, () => { s.destroy(); reject(new Error('no answer from the main process')); });
        s.on('connect', () => s.end(JSON.stringify({ command })));
        s.on('data', d => { data += d; });
        s.on('end', () => { try { const j = JSON.parse(data); j.success === false ? reject(new Error(j.error)) : resolve(j); } catch { reject(new Error('bad answer from the main process')); } });
        s.on('error', () => reject(new Error('The container\'s main process is not reachable (is the container running?).')));
    });
}

// ---- status ----
function modesFile() {
    const cfg = readJson(INSTANCES);
    return join(SUP_DIR, cfg?.modesFile || 'modes.json');
}

export function stateLabel(i) {
    if (!i.running) return i.modeOff ? 'OFF' : i.relaunchPending ? 'RESTARTING' : i.want === 'stopped' ? 'STOPPED' : 'DOWN';
    if (i.closeAfterMatch) return 'CLOSING';
    return i.heartbeat ? (i.joinable === false ? 'UP (not joinable)' : 'UP') : 'BOOTING';
}

export async function instances() {
    const list = (await admin('/instances')).instances || [];
    const procs = gameProcesses();
    const modes = readJson(modesFile(), {});
    for (const i of list) {
        const p = procs.find(x => x.instance === i.id);
        i.rssMb = p?.rssMb ?? null; i.swapMb = p?.swapMb ?? null;
        i.label = MODES.find(m => m.key === i.mode)?.label || i.mode;
        i.modeOn = modes[i.mode] !== false;
        i.state = stateLabel(i);
    }
    // Modes running as server pairs (RV_SWAP): the main supervisor does not run them itself; show the
    // active server of the pair instead.
    const pairs = pairStatus();
    if (pairs) for (const i of list) {
        if (!(readState().pairedModes || []).includes(i.mode)) continue;
        const p = pairs[i.mode], a = p?.activeDetails || {};
        Object.assign(i, { modeOff: false, modeOn: true, want: 'running', running: !!a.running, heartbeat: p?.activeState === 'up',
            joinable: p?.activeState === 'up', closeAfterMatch: false, relaunchPending: !a.running, players: a.players ?? 0,
            uptimeSec: a.uptimeSec || 0, rssMb: a.rssMb ?? null, swapMb: a.swapMb ?? null, restarts: p?.restarts ?? 0, crashes: 0,
            pair: p ? { active: p.active, waiting: p.waiting, waitingState: p.waitingState } : { active: '?', waiting: '?', waitingState: 'starting' } });
        i.state = stateLabel(i);
    }
    return list;
}

export function nodeInfo() {
    const s = readState();
    return { nodeId: s.nodeId || '', edition: s.edition || '', name: s.name || '', region: s.region || '',
        publicIp: s.publicIp || '', kitVersion: kitVersion() };
}

export function system() {
    const mem = {};
    try {
        for (const l of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
            const m = l.match(/^(\w+):\s+(\d+)/);
            if (m) mem[m[1]] = Math.round(Number(m[2]) / 1024);
        }
    } catch { /* not Linux */ }
    let disk = null;
    try { const s = statfsSync(SUP_DIR); disk = { totalGb: +(s.blocks * s.bsize / 2 ** 30).toFixed(1), freeGb: +(s.bavail * s.bsize / 2 ** 30).toFixed(1) }; } catch { /* not set up */ }
    return { memTotalMb: mem.MemTotal, memAvailMb: mem.MemAvailable, swapTotalMb: mem.SwapTotal, swapFreeMb: mem.SwapFree,
        load: os.loadavg().map(x => +x.toFixed(2)), cpus: os.cpus().length, disk };
}

// ---- actions ----
const resolveId = target => {
    const m = MODES.find(x => x.key === target || x.id === target);
    if (!m) throw new Error(`Unknown mode "${target}" (solo, playground, duos, trios, squads).`);
    return m;
};

export async function instanceAction(target, action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('action must be start, stop or restart');
    if ((readState().pairedModes || []).includes(resolveId(target).key)) {
        if (action === 'restart' && restartActive(resolveId(target).key)) return { success: true, message: 'restarting the active server of the pair (the waiting one takes over)' };
        throw new Error(`${resolveId(target).label} runs as a server pair (RV_SWAP): it can only be restarted here.`);
    }
    return admin(`/instances/${resolveId(target).id}/${action}`, 'POST');
}

export async function restartAll() {
    const list = (await admin('/instances')).instances || [];
    const done = [];
    for (const i of list) if (i.want === 'running' && !i.modeOff) { await admin(`/instances/${i.id}/restart`, 'POST'); done.push(i.id); }
    return done;
}

// Same as the supervisor's own setMode(): change modes.json, which it re-reads every 5 seconds.
// Off: an empty server stops at once; one with players closes after its current match.
export function setMode(mode, on) {
    const m = resolveId(mode);
    if ((readState().pairedModes || []).includes(m.key)) throw new Error(`${m.label} runs as a server pair (RV_SWAP); change RV_SWAP in the container settings to switch it off.`);
    const f = modesFile();
    const obj = readJson(f, {});
    obj[m.key] = on === true;
    writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
    return `Mode ${m.key} switched ${on ? 'on' : 'off'}.`;
}

function configFile(mode) {
    const m = resolveId(mode);
    const file = join(WIN64, `Config.${m.key}.ini`);
    if (!existsSync(file)) throw new Error(`Config.${m.key}.ini not found (is the server set up?)`);
    return { m, file };
}

export function getSettings(mode) {
    const { m, file } = configFile(mode);
    const ini = readIni(file);
    const settings = Object.entries(ini)
        .filter(([k]) => EDITABLE_SECTIONS.includes(k.split('/')[0]) && !LOCKED.has(k))
        .map(([k, v]) => ({ key: k, name: k.split('/')[1], value: v, ...(SETTING_INFO[k] || { label: k.split('/')[1], type: 'text' }) }));
    // Known settings that this Config.<mode>.ini does not contain yet: shown as unset (server default).
    for (const [k, info] of Object.entries(SETTING_INFO)) {
        if (!(k in ini) && EDITABLE_SECTIONS.includes(k.split('/')[0])) settings.push({ key: k, name: k.split('/')[1], value: '', unset: true, ...info });
    }
    return { mode: m.key, id: m.id, label: m.label, settings };
}

// values: { 'Game Settings/SpawnBot': '30', ... } - the short key name ('SpawnBot') works too.
export async function saveSettings(mode, values, { restart = false } = {}) {
    const { m, file } = configFile(mode);
    const ini = readIni(file);
    const bySection = {};
    for (const [rawKey, v] of Object.entries(values)) {
        const byName = keys => keys.find(x => x.toLowerCase().split('/')[1] === rawKey.toLowerCase() && EDITABLE_SECTIONS.includes(x.split('/')[0]));
        const k = rawKey.includes('/') ? rawKey : byName(Object.keys(ini)) || byName(Object.keys(SETTING_INFO)) || rawKey;
        const known = k in ini || k in SETTING_INFO;
        if (!known || LOCKED.has(k) || !EDITABLE_SECTIONS.includes(k.split('/')[0])) throw new Error(`${rawKey} cannot be changed here`);
        const info = SETTING_INFO[k];
        let val = String(v).trim();
        if (val === '' && !(k in ini)) continue;   // still unset: keep the server default
        if (info?.type === 'int') {
            if (!/^-?\d+$/.test(val) || Number(val) < info.min || Number(val) > info.max) throw new Error(`${info.label}: ${info.min} to ${info.max}`);
        } else if (info?.type === 'bool') {
            val = BOOL_VALUES[val.toLowerCase()];
            if (!val) throw new Error(`${info.label}: true or false`);
        } else if (!/^[\w .,:+-]{0,100}$/.test(val)) throw new Error(`${k}: invalid value`);
        const [sec, key] = k.split('/');
        (bySection[sec] ||= {})[key] = val;
    }
    for (const [sec, vals] of Object.entries(bySection)) setIniValues(file, sec, vals);
    if (restart) await admin(`/instances/${m.id}/restart`, 'POST');
    return restart ? 'Saved - the server is restarting with the new settings.'
        : 'Saved - takes effect when the server next restarts (BR modes restart after every match).';
}

export const node = () => admin('/node');

// Remove this server from the rVclient backend (what the Windows Uninstall-RVServer does), stop
// the game servers and forget the registration, so setup can register the folder again later.
export async function leave() {
    const st = readState();
    if (!st.nodeId || !st.nodeKey) throw new Error('This server is not registered.');
    const backend = (st.backend || 'http://185.150.190.30:9977').replace(/\/$/, '');
    const r = await fetch(`${backend}/nodes/leave`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: st.nodeId, key: st.nodeKey }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Backend: ${j.error || 'HTTP ' + r.status}`);
    try { await control('stop'); } catch { /* main process not running */ }
    updateState({ nodeId: '', nodeKey: '', leftNode: st.nodeId, leftAt: new Date().toISOString() });
    return `Removed ${st.nodeId} from the server list and stopped the game servers.`;
}
export const update = () => admin('/node/update', 'POST');
export const rollback = () => admin('/node/rollback', 'POST');

// ---- logs ----
export function logFile(which) {
    if (which === 'supervisor') return join(LOGS, 'supervisor.log');
    if (which === 'setup') return SETUP_LOG;
    const m = MODES.find(x => x.key === which || x.id === which);
    if (m) return join(LOGS, 'game', `server-${m.id}.log`);
    throw new Error('Unknown log (supervisor, setup, or a mode name).');
}

export function tail(file, maxLines = 200) {
    if (!existsSync(file)) return '';
    const size = statSync(file).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    return buf.toString('utf8').split(/\r?\n/).slice(-maxLines).join('\n');
}

export { isConfigured };
