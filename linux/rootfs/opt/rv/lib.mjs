// Shared paths and helpers for the entrypoint, setup and web UI.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBoxPorts } from './box-ports.mjs';

export const DATA = process.env.RV_DATA || '/data';
export const SERVER = join(DATA, 'server');                               // game files + server kit
export const WIN64 = join(SERVER, 'Rumbleverse', 'Binaries', 'Win64');
export const SUP_DIR = join(WIN64, 'RVSupervisor');
export const INSTANCES = join(SUP_DIR, 'ds-instances.json');
export const STATE_DIR = join(DATA, 'state');
export const STATE_FILE = join(STATE_DIR, 'rv.json');                     // registration, like setup-state.json
export const AUTH_FILE = join(STATE_DIR, 'webui.json');
export const LOGS = join(DATA, 'logs');
export const SETUP_LOG = join(LOGS, 'setup.log');
export const GAME_EXE = 'RumbleverseClient-Win64-Shipping.exe';
export const DEFAULT_BACKEND = 'http://185.150.190.30:9977';

export const MODES = [
    { key: 'solo', id: 'solo-01', port: 7777, label: 'Solos' },
    { key: 'playground', id: 'playground-01', port: 7778, label: 'Playground' },
    { key: 'duos', id: 'duos-01', port: 7779, label: 'Duos' },
    { key: 'trios', id: 'trios-01', port: 7780, label: 'Trios' },
    { key: 'squads', id: 'squads-01', port: 7781, label: 'Squads' },
];

export function ensureDirs() {
    for (const d of [DATA, STATE_DIR, LOGS]) mkdirSync(d, { recursive: true });
}

export function readJson(file, fallback = null) {
    try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

// Write via a temp file and rename, so a crash never leaves half a file behind.
export function writeJson(file, obj, mode = 0o600) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
    renameSync(tmp, file);
}

export const readState = () => readJson(STATE_FILE, {});
export function updateState(patch) {
    const s = { ...readState(), ...patch };
    writeJson(STATE_FILE, s);
    return s;
}

// The server kit's ds-instances.json, read-modify-written with its other keys kept.
export function updateInstances(patch) {
    const inst = readJson(INSTANCES, null);
    if (!inst) return null;
    const next = { ...inst, ...patch };
    writeJson(INSTANCES, next, 0o644);
    return next;
}
// The kit's box-wide warm spare switch. It is read once when the supervisor starts, so it must be
// written before the supervisor is started.
export function setKitWarmSpare(on) { return updateInstances({ warmSpare: !!on }); }

// ---- game ports ----
// The supervisor starts every mode from the kit's ds-instances.json, so that file is the source of
// truth for the ports. MODES holds the kit defaults, used when the file or an entry is absent.
export const SPARE_PORT_OFFSET = 100;   // older kits: a warm spare is the mode's port + this
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
export const SPARE_MODE_KEYS = ['solo', 'duos', 'trios', 'squads'];
const SPARE_MODES = new Set(SPARE_MODE_KEYS);
const validPort = p => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;
const isSpareId = id => /-spare$/.test(String(id || ''));

export function modeByKey(key) {
    const k = String(key ?? '').toLowerCase();
    return MODES.find(m => m.key === k || m.id === k) || null;
}
function instanceList(instances) {
    return Array.isArray(instances?.instances) ? instances.instances.filter(i => i && typeof i === 'object') : [];
}
// The ds-instances.json entry of a mode: by its instance id, or by a "mode" field where a kit
// writes one. A warm spare entry is never taken for the mode itself.
export function modeInstance(mode, instances = readJson(INSTANCES, null)) {
    const m = typeof mode === 'string' ? modeByKey(mode) : mode;
    if (!m) return null;
    const list = instanceList(instances);
    return list.find(i => i.id === m.id)
        || list.find(i => !i.spareOf && !isSpareId(i.id) && String(i.mode || '').toLowerCase() === m.key)
        || null;
}
export function modePort(mode, instances = readJson(INSTANCES, null)) {
    const m = typeof mode === 'string' ? modeByKey(mode) : mode;
    if (!m) throw new Error(`Unknown mode "${mode}" (solo, playground, duos, trios, squads).`);
    const p = modeInstance(m, instances)?.port;
    return validPort(p) ? p : m.port;
}
// The mode's warm spare entry, where the file names one: "<id>-spare" or an entry that points at
// the mode with spareOf.
export function spareInstance(mode, instances = readJson(INSTANCES, null)) {
    const m = typeof mode === 'string' ? modeByKey(mode) : mode;
    if (!m) return null;
    const id = modeInstance(m, instances)?.id || m.id;
    const list = instanceList(instances);
    return list.find(i => i.spareOf === id) || list.find(i => i.id === `${id}-spare`) || null;
}
// How far the spare's port is from the mode's. An explicit spare entry keeps the distance the file
// gives it; otherwise the file's warmSparePortOffset is used, and 100 is the fallback for older kits.
export function spareOffset(mode, instances = readJson(INSTANCES, null)) {
    const m = typeof mode === 'string' ? modeByKey(mode) : mode;
    if (!m) throw new Error(`Unknown mode "${mode}" (solo, playground, duos, trios, squads).`);
    const explicit = spareInstance(m, instances), off = instances?.warmSparePortOffset;
    if (validPort(explicit?.port)) return explicit.port - modePort(m, instances);
    return Number.isInteger(off) && off > 0 ? off : SPARE_PORT_OFFSET;
}
export function sparePort(mode, instances = readJson(INSTANCES, null)) {
    const m = typeof mode === 'string' ? modeByKey(mode) : mode;
    if (!m) throw new Error(`Unknown mode "${mode}" (solo, playground, duos, trios, squads).`);
    const port = modePort(m, instances) + spareOffset(m, instances);
    return validPort(port) ? port : modePort(m, instances) + SPARE_PORT_OFFSET;
}
export function modePorts(instances = readJson(INSTANCES, null)) {
    return Object.fromEntries(MODES.map(m => [m.key, modePort(m, instances)]));
}
export function sparePorts(instances = readJson(INSTANCES, null)) {
    return Object.fromEntries(SPARE_MODE_KEYS.map(k => [k, sparePort(k, instances)]));
}

// ---- servers and ports from the environment ----
// The same choices as the server kit's own setup (box-ports.mjs, an identical copy of the kit's
// RVSupervisor/box-ports.mjs), checked before anything is written:
//   RV_COUNTS=solo=4,duos=2          servers per mode (solo-01, solo-02, ...), each on its own port
//                                    and with its own warm spare; a lower count removes the extra ones
//   RV_PORT_BASE=<first port>        every server gets the next port, in MODES order
//   RV_PORTS=<mode or server>=<port> a port per mode (its first server) or per server id
//   RV_SPARE_OFFSET=<n>              a warm spare is its server's port + this
//   RV_SPARE_PORTS=<mode or server>=<port>  a warm spare port per mode or server id
// A server that is not named keeps the port it has. With none of them set the file is left untouched.
// The servers of one mode share its Config.<mode>.ini; each gets its own port on the command line.
const GAME_MODE = { solo: 1, playground: 0, duos: 2, trios: 3, squads: 4 };
const serverRe = key => new RegExp(`^${key}-(\\d+)$`);
// The server an entry belongs to: its own id, or for a spare the server it is the spare of.
const ownerId = i => String(i.spareOf || i.id || '').replace(/-spare$/, '');
const managedBy = i => MODES.find(m => serverRe(m.key).test(ownerId(i))) || null;
export function parsePortOverride(env = process.env) {
    const value = name => { const v = String(env[name] ?? '').trim(); return v ? v : undefined; };
    const choice = { counts: value('RV_COUNTS'), portBase: value('RV_PORT_BASE'), ports: value('RV_PORTS'),
        spareOffset: value('RV_SPARE_OFFSET'), sparePorts: value('RV_SPARE_PORTS') };
    return Object.values(choice).some(v => v !== undefined) ? choice : null;
}
// What the file already has, in the shape resolveBoxPorts reads.
// Parked servers (_moreModesLater, started when their mode is switched on) count like the others.
const parkedList = instances => Array.isArray(instances?._moreModesLater)
    ? instances._moreModesLater.filter(i => i && typeof i === 'object') : [];
export function currentLayout(instances) {
    const list = [...instanceList(instances), ...parkedList(instances)];
    const current = { counts: {}, ports: {}, spares: {}, offset: instances?.warmSparePortOffset, reserved: {} };
    for (const m of MODES) {
        const own = list.filter(i => !i.spareOf && serverRe(m.key).test(i.id));
        if (own.length) current.counts[m.key] = Math.max(...own.map(i => Number(serverRe(m.key).exec(i.id)[1])));
        for (const i of own) {
            if (validPort(i.port)) current.ports[i.id] = i.port;
            const spare = list.find(x => x.spareOf === i.id) || list.find(x => x.id === `${i.id}-spare`);
            if (validPort(i.sparePort)) current.spares[i.id] = i.sparePort;
            else if (validPort(spare?.port)) current.spares[i.id] = spare.port;
        }
    }
    for (const i of list) if (!managedBy(i) && !isSpareId(i.id) && validPort(i.port)) current.reserved[i.port] = i.id;
    return current;
}
// The servers and ports an override gives: { servers: [{ key, id, port, sparePort }], offset, ports,
// spares }. ports and spares are each mode's first server, as the rest of the container reads them.
export function resolvePorts(choice, instances = readJson(INSTANCES, null)) {
    if (!choice) return null;
    const layout = resolveBoxPorts(MODES, choice, currentLayout(instances));
    const first = key => layout.servers.find(x => x.key === key);
    return { ...layout,
        ports: Object.fromEntries(MODES.map(m => [m.key, first(m.key).port])),
        spares: Object.fromEntries(SPARE_MODE_KEYS.map(k => [k, first(k).sparePort])) };
}
// The file with the layout written in: every server of it present on its port, servers above a mode's
// count removed with their spares, and each spare where the layout puts it (a sparePort on its server,
// or the spare entry the file defines). Other instances are left as they are.
export function rewritePorts(instances, resolved, choice = {}) {
    const next = JSON.parse(JSON.stringify(instances));
    const changes = [];
    const wanted = new Set(resolved.servers.map(x => x.id));
    const keep = i => {
        if (!managedBy(i) || wanted.has(ownerId(i))) return true;
        changes.push({ id: i.id, kind: 'removed', from: i.port, to: null });
        return false;
    };
    const kept = instanceList(next).filter(keep);
    const parked = parkedList(next).filter(keep);
    const all = () => [...kept, ...parked];
    for (const x of resolved.servers) {
        let entry = all().find(i => i.id === x.id);
        if (!entry) {
            // A mode the file does not run is not added: the file is the box's choice of modes. An
            // extra server is a copy of its mode's first one, and waits with it when that is parked.
            const firstOfMode = all().find(i => !i.spareOf && serverRe(x.key).test(i.id));
            if (!firstOfMode) continue;
            const { sparePort: _ownSpare, ...base } = firstOfMode;
            entry = { ...base, id: x.id, port: x.port, gameMode: base.gameMode ?? GAME_MODE[x.key],
                config: base.config || `Config.${x.key}.ini` };
            (parked.includes(firstOfMode) ? parked : kept).push(entry);
            changes.push({ id: x.id, kind: 'added', from: null, to: x.port });
        } else if (entry.port !== x.port) {
            changes.push({ id: x.id, kind: 'main', from: entry.port, to: x.port });
            entry.port = x.port;
        }
        if (x.sparePort === undefined) continue;
        const defined = all().find(i => i.spareOf === x.id) || all().find(i => i.id === `${x.id}-spare`);
        if (defined) {
            if (defined.port !== x.sparePort) changes.push({ id: defined.id, kind: 'spare', from: defined.port, to: x.sparePort });
            defined.port = x.sparePort;
            delete entry.sparePort;
        } else if (x.sparePort === x.port + resolved.offset) {
            delete entry.sparePort;
        } else if (entry.sparePort !== x.sparePort) {
            changes.push({ id: x.id, kind: 'spare', from: entry.sparePort ?? x.port + resolved.offset, to: x.sparePort });
            entry.sparePort = x.sparePort;
        }
    }
    next.instances = kept;
    if (Array.isArray(next._moreModesLater)) next._moreModesLater = parked;
    if (choice.spareOffset !== undefined) {
        if (resolved.offset === SPARE_PORT_OFFSET) delete next.warmSparePortOffset;
        else next.warmSparePortOffset = resolved.offset;
    }
    return { next, changes };
}
export function applyPortOverride(instances, env = process.env) {
    const choice = parsePortOverride(env);
    if (!choice) return null;
    const resolved = resolvePorts(choice, instances);
    const { next, changes } = rewritePorts(instances, resolved, choice);
    return { next, changes, servers: resolved.servers, ports: resolved.ports, spares: resolved.spares };
}
// Called after the kit writes ds-instances.json and before the supervisor starts. Returns null when
// no override is set or the server is not set up yet.
export function applyPortOverrideFromEnv(log = () => {}) {
    const instances = readJson(INSTANCES, null);
    if (!instances) return null;
    let r;
    try { r = applyPortOverride(instances, process.env); }
    catch (e) { throw new Error(`Port override: ${e.message}`); }
    if (!r) return null;
    if (r.changes.length) {
        writeJson(INSTANCES, r.next, 0o644);
        for (const c of r.changes)
            log(c.kind === 'added' ? `${c.id}: added on port ${c.to}`
                : c.kind === 'removed' ? `${c.id}: removed (above the server count)`
                : `${c.id}: ${c.kind} port ${c.from ?? '?'} -> ${c.to}`);
    }
    return r;
}
// Every server of the file, as { id, key, port, sparePort } (sparePort for the battle royale modes):
// the ports the container uses, for the web page, the installer and the logs.
export function serverPorts(instances = readJson(INSTANCES, null)) {
    const list = instanceList(instances);
    const offsetOf = Number.isInteger(instances?.warmSparePortOffset) && instances.warmSparePortOffset > 0
        ? instances.warmSparePortOffset : SPARE_PORT_OFFSET;
    const out = [];
    for (const m of MODES) {
        const own = list.filter(i => !i.spareOf && serverRe(m.key).test(i.id) && validPort(i.port));
        if (!own.length) own.push({ id: m.id, port: modePort(m, instances) });
        for (const i of own) {
            const defined = list.find(x => x.spareOf === i.id) || list.find(x => x.id === `${i.id}-spare`);
            const sparePort = !SPARE_MODES.has(m.key) ? undefined
                : validPort(defined?.port) ? defined.port : validPort(i.sparePort) ? i.sparePort : i.port + offsetOf;
            out.push({ id: i.id, key: m.key, port: i.port, ...(sparePort !== undefined ? { sparePort } : {}) });
        }
    }
    return out;
}
// The ids of a mode's servers (solo-01, solo-02, ...); the mode's default id when the file has none.
export function serverIds(key, instances = readJson(INSTANCES, null)) {
    const m = modeByKey(key);
    if (!m) return [];
    const ids = instanceList(instances).filter(i => !i.spareOf && serverRe(m.key).test(i.id)).map(i => i.id);
    return ids.length ? ids : [m.id];
}
// How many servers each mode runs (1 when the file has none of its own).
export function serverCount(key, instances = readJson(INSTANCES, null)) {
    return serverIds(key, instances).length;
}
// A server id (solo-02) or a mode key (solo) -> { mode, ids }: the one server, or every server of the mode.
export function serverTarget(target, instances = readJson(INSTANCES, null)) {
    const t = String(target ?? '').toLowerCase();
    const mode = MODES.find(m => m.key === t || m.id === t || serverRe(m.key).test(t));
    if (!mode) return null;
    if (t === mode.key) return { mode, ids: serverIds(mode.key, instances) };
    return { mode, ids: [t] };
}

export const gameInstalled = () => existsSync(join(WIN64, GAME_EXE));
export const kitInstalled = () => existsSync(join(SERVER, 'rv-server.version'));
export const isConfigured = () => {
    const s = readState();
    return !!(s.nodeId && s.nodeKey && gameInstalled() && kitInstalled() && existsSync(INSTANCES));
};
export function kitVersion() {
    try { return readFileSync(join(SERVER, 'rv-server.version'), 'utf8').trim(); } catch { return ''; }
}

// ---- Config.<mode>.ini ----
// Keys are edited in place; every other line (comments, order, CRLF) is kept as it is.
export function readIni(file) {
    const out = {};
    let section = '';
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const sec = line.match(/^\s*\[(.+)\]\s*$/);
        if (sec) { section = sec[1]; continue; }
        const kv = line.match(/^\s*([^;#=][^=]*?)\s*=\s*(.*?)\s*$/);
        if (kv) out[`${section}/${kv[1]}`] = kv[2];
    }
    return out;
}
export function setIniValues(file, section, values) {
    const text = readFileSync(file, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const pending = new Map(Object.entries(values));
    let cur = '', sectionEnd = -1;
    for (let n = 0; n < lines.length; n++) {
        const sec = lines[n].match(/^\s*\[(.+)\]\s*$/);
        if (sec) { cur = sec[1]; continue; }
        if (cur !== section) continue;
        if (lines[n].trim()) sectionEnd = n;   // new keys go after the section's last real line, not after blank ones
        const kv = lines[n].match(/^(\s*)([^;#=][^=]*?)(\s*=\s*)(.*?)\s*$/);
        if (kv && pending.has(kv[2])) { lines[n] = `${kv[1]}${kv[2]}${kv[3]}${pending.get(kv[2])}`; pending.delete(kv[2]); }
    }
    if (pending.size) {
        const add = [...pending].map(([k, v]) => `${k}=${v}`);
        if (sectionEnd >= 0) lines.splice(sectionEnd + 1, 0, ...add);
        else lines.push(`[${section}]`, ...add);
    }
    writeFileSync(file, lines.join(eol));
}

// ---- game server processes (Wine children of the supervisor) ----
// Matched by the -RVInstance= argument the supervisor passes, like Stop-AllModes.bat does. The servers of a
// server pair (pairs.mjs) run from the same folder with their own instance ids (solo-01a / solo-01b) and
// belong to the pair controller, not to the supervisor.
export const isPairInstance = id => /\d[ab]$/.test(String(id || ''));
export function gameProcesses() {
    const out = [];
    for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
            if (!cmd.some(a => /RumbleverseClient-Win64-Shipping\.exe$/i.test(a))) continue;
            const inst = (cmd.find(a => a.startsWith('-RVInstance=')) || '').slice(12);
            if (!inst || isPairInstance(inst)) continue;
            if (!readlinkSync(`/proc/${pid}/cwd`).startsWith(SERVER + '/')) continue;
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            const rssKb = Number((status.match(/^VmRSS:\s+(\d+)/m) || [])[1] || 0);
            const swapKb = Number((status.match(/^VmSwap:\s+(\d+)/m) || [])[1] || 0);
            out.push({ pid: Number(pid), instance: inst, rssMb: Math.round(rssKb / 1024), swapMb: Math.round(swapKb / 1024) });
        } catch { /* process gone */ }
    }
    return out;
}

export function killGameProcesses(signal = 'SIGKILL') {
    let n = 0;
    for (const p of gameProcesses()) { try { process.kill(p.pid, signal); n++; } catch { /* gone */ } }
    return n;
}
