// Shared paths and helpers for the entrypoint, setup and web UI.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

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

// ---- install-time port override ----
// RV_PORT_BASE=<first port>: the modes get it and the next ports, in MODES order.
// RV_PORTS=<mode>=<port>,...: a port per named mode; a named mode wins over RV_PORT_BASE.
// Both are checked before anything is written. With neither set the file is left untouched.
function portNumber(raw, what) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) throw new Error(`${what}: "${s}" is not a port number (${PORT_MIN}-${PORT_MAX}).`);
    const n = Number(s);
    if (!Number.isInteger(n) || n < PORT_MIN || n > PORT_MAX) throw new Error(`${what}: ${s} is outside ${PORT_MIN}-${PORT_MAX}.`);
    return n;
}
export function parsePortOverride(env = process.env) {
    const baseRaw = String(env.RV_PORT_BASE ?? '').trim();
    const portsRaw = String(env.RV_PORTS ?? '').trim();
    if (!baseRaw && !portsRaw) return null;
    const ports = Object.create(null), seen = new Map(), given = new Set();
    if (portsRaw) {
        for (const part of portsRaw.split(',')) {
            const item = part.trim();
            if (!item) continue;
            const eq = item.indexOf('=');
            if (eq <= 0) throw new Error(`RV_PORTS: "${item}" is not <mode>=<port> (for example solo=7777).`);
            const name = item.slice(0, eq).trim().toLowerCase();
            const m = modeByKey(name);
            if (!m) throw new Error(`RV_PORTS: unknown mode "${name}" (use solo, playground, duos, trios, squads).`);
            if (given.has(m.key)) throw new Error(`RV_PORTS: ${m.key} is given more than once.`);
            const p = portNumber(item.slice(eq + 1), `RV_PORTS ${m.key}`);
            if (seen.has(p)) throw new Error(`RV_PORTS: port ${p} is used for both ${seen.get(p)} and ${m.key}.`);
            given.add(m.key);
            seen.set(p, m.key);
            ports[m.key] = p;
        }
        if (!given.size) throw new Error('RV_PORTS lists no <mode>=<port> entries.');
    }
    let base = null;
    if (baseRaw) {
        base = portNumber(baseRaw, 'RV_PORT_BASE');
        if (base + MODES.length - 1 > PORT_MAX) throw new Error(`RV_PORT_BASE: ${base} leaves no room for ${MODES.length} modes below ${PORT_MAX}.`);
    }
    return { base, ports };
}
// The final ports of every mode from an override and the file, with the warm spares derived the
// same way. Throws when a main or spare port repeats another, or is used by another instance the
// file defines.
export function resolvePorts(override, instances = readJson(INSTANCES, null)) {
    if (!override) return null;
    const ports = {}, spares = {}, offsets = {};
    MODES.forEach((m, i) => {
        ports[m.key] = override.ports[m.key] ?? (override.base != null ? override.base + i : modePort(m, instances));
    });
    const use = new Map();
    const claim = (port, what) => {
        if (!validPort(port)) throw new Error(`${what} would use UDP ${port}, outside ${PORT_MIN}-${PORT_MAX}.`);
        if (use.has(port)) throw new Error(`${what} would use UDP ${port}, already used by ${use.get(port)}.`);
        use.set(port, what);
    };
    for (const m of MODES) claim(ports[m.key], `${m.key} (main)`);
    const rewritten = new Set();
    for (const m of MODES) {
        const main = modeInstance(m, instances), explicit = spareInstance(m, instances);
        if (main?.id) rewritten.add(main.id);
        if (explicit?.id) rewritten.add(explicit.id);
        if (!SPARE_MODES.has(m.key) && !explicit) continue;
        offsets[m.key] = spareOffset(m, instances);
        spares[m.key] = ports[m.key] + offsets[m.key];
        claim(spares[m.key], `${m.key} (warm spare)`);
    }
    // Other instances keep their own ports; the supervisor refuses a duplicate too, so check them.
    const extra = [...instanceList(instances), ...(Array.isArray(instances?._moreModesLater) ? instances._moreModesLater : [])];
    for (const i of extra) {
        if (!i || rewritten.has(i.id) || !validPort(i.port)) continue;
        claim(i.port, `${i.id || 'another instance'} in ds-instances.json`);
    }
    return { ports, spares, offsets };
}
// The same instances with the resolved ports written into the mode entries and the spare entries
// the file already has. Nothing is added: a spare the file does not name is the supervisor's own.
export function rewritePorts(instances, resolved) {
    const next = JSON.parse(JSON.stringify(instances));
    const changes = [];
    const set = (entry, port, kind) => {
        if (!entry || entry.port === port) return;
        changes.push({ id: entry.id, kind, from: entry.port, to: port });
        entry.port = port;
    };
    for (const m of MODES) {
        set(modeInstance(m, next), resolved.ports[m.key], 'main');
        if (resolved.spares[m.key] !== undefined) set(spareInstance(m, next), resolved.spares[m.key], 'spare');
    }
    return { next, changes };
}
export function applyPortOverride(instances, env = process.env) {
    const override = parsePortOverride(env);
    if (!override) return null;
    const resolved = resolvePorts(override, instances);
    const { next, changes } = rewritePorts(instances, resolved);
    return { next, changes, ports: resolved.ports, spares: resolved.spares };
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
        for (const c of r.changes) log(`${c.id || 'instance'}: ${c.kind} port ${c.from ?? '?'} -> ${c.to}`);
    }
    return r;
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
