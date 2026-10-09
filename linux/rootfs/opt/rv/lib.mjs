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
// Matched by the -RVInstance= argument the supervisor passes, like Stop-AllModes.bat does, and by their
// folder: with server pairs (RV_SWAP) several servers run in this container, each in its own data folder.
export function gameProcesses() {
    const out = [];
    for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
            if (!cmd.some(a => /RumbleverseClient-Win64-Shipping\.exe$/i.test(a))) continue;
            const inst = (cmd.find(a => a.startsWith('-RVInstance=')) || '').slice(12);
            if (!inst) continue;
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
