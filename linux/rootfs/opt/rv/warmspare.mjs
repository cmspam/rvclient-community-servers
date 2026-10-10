// Zero Wait with the server kit's warm spare (kit 2026.10.10.1 and newer).
//
// The kit's supervisor (ds-supervisor.js) gives each Battle Royale server a twin "<id>-spare" on the
// mode's port + 100 (7777 -> 7877), with the same Config ini. Both are ordinary game servers: each sends
// its own heartbeat to the backend with its own port, and the node agent registers both. Matchmaking sends
// players to whichever is in its lobby, so while one plays a match or restarts after it, the other takes
// the next players. Per mode, WarmSpare=false in Config.<mode>.ini turns the spare off (it closes after its
// current match); it only starts with warmSpareMinFreeMb (default 2500) of free memory.
//
// On Linux the supervisor runs unchanged under the shim (linux-shim.mjs); the spare's port needs no
// container change (host networking), only a port forward or firewall rule where the box has one. Kits
// without the warm spare use the server pairs (pairs.mjs) instead.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUP_DIR, WIN64, INSTANCES, MODES, readJson, writeJson, readIni, setIniValues, readState, updateState } from './lib.mjs';

export const SPARE_PORT_OFFSET = 100;
export const isSpare = id => /-spare$/.test(String(id || ''));
const BR = new Set(['solo', 'duos', 'trios', 'squads']);
export const brModes = () => MODES.filter(m => BR.has(m.key));

// Does the installed kit's supervisor run warm spares?
export function kitHasWarmSpare() {
    try { return readFileSync(join(SUP_DIR, 'ds-supervisor.js'), 'utf8').includes('warmSpareWanted'); } catch { return false; }
}

const iniOf = key => join(WIN64, `Config.${key}.ini`);
const truthy = v => !/^(false|0|no|off)$/i.test(String(v ?? '').trim());

// WarmSpare of a mode as the supervisor reads it: on unless the ini says false/0/no/off.
export function warmSpareOn(key) {
    if (!BR.has(key)) return false;
    try {
        const ini = readIni(iniOf(key));
        const k = Object.keys(ini).find(x => x.split('/')[1]?.toLowerCase() === 'warmspare');
        return k ? truthy(ini[k]) : true;
    } catch { return false; }
}
export function setWarmSpare(key, on) {
    const m = MODES.find(x => x.key === key);
    if (!m) throw new Error(`Unknown mode "${key}" (solo, playground, duos, trios, squads).`);
    if (!BR.has(m.key)) throw new Error(`${m.label} has no matches to wait between: Zero Wait is for Solos, Duos, Trios and Squads.`);
    if (!existsSync(iniOf(m.key))) throw new Error(`Config.${m.key}.ini not found (is the server set up?)`);
    setIniValues(iniOf(m.key), 'Game Settings', { WarmSpare: on ? 'true' : 'false' });
    return `${m.label}: Zero Wait ${on ? 'on - its spare server starts within a few seconds (with enough free memory)' : 'off - its spare server closes after its current match'}.`;
}
export const warmSpareModes = () => brModes().filter(m => warmSpareOn(m.key)).map(m => m.key);

// Before the supervisor starts: it reads the owner's modes.json (the pairs' modes.main.json is not used),
// the spare settings from the environment, and the modes' Zero Wait choice from the pairs era, once.
export function prepareWarmSpare(log) {
    const inst = readJson(INSTANCES, null);
    if (inst) {
        const want = { ...inst, modesFile: 'modes.json', warmSpareFirewall: false };
        const minFree = Number(process.env.RV_WARM_SPARE_MIN_FREE_MB);
        if (minFree > 0) want.warmSpareMinFreeMb = Math.round(minFree); else delete want.warmSpareMinFreeMb;
        if (JSON.stringify(want) !== JSON.stringify(inst)) writeJson(INSTANCES, want, 0o644);
    }
    const st = readState();
    if (!st.warmSpareSet) {
        // The modes that ran as server pairs (or RV_SWAP) keep Zero Wait; the others get WarmSpare=false, so a
        // box that never chose Zero Wait for a mode does not start a second server for it. An owner's own
        // WarmSpare line is kept.
        const chosen = new Set(Array.isArray(st.swapModes) ? st.swapModes
            : String(process.env.RV_SWAP || '').split(',').map(s => s.trim()).filter(Boolean));
        for (const m of brModes()) {
            if (!existsSync(iniOf(m.key))) continue;
            const ini = readIni(iniOf(m.key));
            if (Object.keys(ini).some(x => x.split('/')[1]?.toLowerCase() === 'warmspare')) continue;
            setIniValues(iniOf(m.key), 'Game Settings', { WarmSpare: chosen.has(m.key) ? 'true' : 'false' });
        }
        updateState({ warmSpareSet: true });
        log(`[spare] Zero Wait runs on the server kit's warm spares: ${warmSpareModes().join(', ') || 'no modes'} (per mode: WarmSpare in Config.<mode>.ini)`);
    }
    updateState({ pairedModes: [] });
}

// `rv swap status | on <mode> | off <mode> | restart <mode>` with warm spares.
export async function spareCli(args) {
    const [cmd, key] = args;
    if (cmd === 'on' || cmd === 'off') return console.log(setWarmSpare(key, cmd === 'on'));
    const ops = await import('./ops.mjs');
    if (cmd === 'restart') {
        if (!brModes().some(m => m.key === key)) return console.log(`usage: rv swap restart <${brModes().map(m => m.key).join('|')}>`);
        await ops.instanceAction(key, 'restart');
        return console.log(`${MODES.find(m => m.key === key).label}: its server restarted (its warm spare takes the next players if it is in its lobby).`);
    }
    const on = warmSpareModes();
    if (!on.length) return console.log('No mode has Zero Wait (warm spare) switched on. rv swap on <mode> switches it on.');
    for (const i of await ops.instances()) {
        if (!on.includes(i.mode)) continue;
        const s = i.spare;
        console.log(`${i.label}: server ${i.id} (port ${i.port}) ${i.state}, ${i.players ?? 0} player(s) | spare ${s ? `${s.id} (port ${s.port}) ${s.state}, ${s.players} player(s)` : 'not started yet (it needs 2.5 GB free memory to start)'}`);
    }
}
