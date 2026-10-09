// Better bots (RV_BOTS, default on). Run right before each game server starts, so server kit updates
// do not undo it.
//
// The battle royale bots run the game's own AI, which on a server mostly stands still or jumps in
// place: it sees 5 m ahead, looks for players only within 30 m, and its paths are built while the
// game runs, which Server.dll limits to 2 pieces at a time. With RV_BOTS on:
//   - rvbots.dll (built from src/rvbots.c) is listed in DList.ini. It lets bots look for players within
//     150 m, see 40 m in a 180 degree view, and go after players they have no path to yet.
//     RVBOTS_PLAYER_SEARCH_RADIUS, RVBOTS_SIGHT_RADIUS, RVBOTS_SIGHT_ANGLE and
//     RVBOTS_KEEP_UNREACHABLE_PLAYERS change those values (the DLL reads them itself).
//   - Server.dll (in the server kit, not in this image) gets the number of paths it lets the engine
//     build at once raised from 2 to RV_BOT_NAV_JOBS (default 1024, the engine's own default). Only
//     when the instruction that sets it is found exactly once; otherwise the file is left alone.
//   - Bot navigation is switched on in every battle royale mode's config (BotNavigation=true,
//     BotNavRadius=RV_BOT_NAV_RADIUS, default 100 metres).
// RV_BOTS=off takes the DLL out of DList.ini and sets Server.dll back to 2; the config is left as it is.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { dlistAdd, dlistRemove } from './addons.mjs';

export const BOTS = !/^(0|off|no|false)$/i.test(process.env.RV_BOTS || 'on');
const DLL_SRC = process.env.RV_BOTS_DLL || '/opt/rv/lib/rvbots.dll';
const ORIGINAL_JOBS = 2;
const MODES = ['solo', 'duos', 'trios', 'squads'];

const md5 = buf => createHash('md5').update(buf).digest('hex');
function replace(dest, data) {
    const tmp = join(dirname(dest), `.${basename(dest)}.rv-new-${process.pid}`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
}

export function navJobs(env = process.env) {
    const n = Number(env.RV_BOT_NAV_JOBS);
    return Number.isInteger(n) && n >= 1 && n <= 4096 ? n : 1024;
}

// Server.dll: mov dword [rbp-0x78], <jobs>; lea r8, [rbp-0x78]; mov rdx, rbx; mov rcx, [rip+...]
// right before it calls NavigationSystemV1.SetMaxSimultaneousTileGenerationJobsCount.
const BEFORE = Buffer.from('c74588', 'hex'), AFTER = Buffer.from('4c8d4588488bd3488b0d', 'hex');
const FUNC = Buffer.from('Function NavigationSystem.NavigationSystemV1.SetMaxSimultaneousTileGenerationJobsCount');
export function findJobsSetting(buf) {
    if (buf.indexOf(FUNC) < 0) return -1;
    let found = -1;
    for (let i = buf.indexOf(BEFORE); i >= 0; i = buf.indexOf(BEFORE, i + 1)) {
        if (buf.compare(AFTER, 0, AFTER.length, i + 7, i + 7 + AFTER.length) !== 0) continue;
        if (found >= 0) return -1;      // more than one: not the code we know
        found = i + 3;
    }
    return found;
}
// Returns the changed file, or null when there is nothing to change or the code is not recognised.
export function setNavJobs(buf, jobs) {
    const at = findJobsSetting(buf);
    if (at < 0 || buf.readUInt32LE(at) === jobs) return null;
    const out = Buffer.from(buf);
    out.writeUInt32LE(jobs, at);
    return out;
}

// One "key=value" in an ini's [Game Settings], keeping the file's line endings.
export function setIniValue(text, key, value) {
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const re = new RegExp(`^${key}=[^\\r\\n]*`, 'mi');
    if (re.test(text)) return text.replace(re, `${key}=${value}`);
    const sec = text.match(/^\[Game Settings\][^\r\n]*\r?\n?/mi);
    if (sec) { const at = sec.index + sec[0].length; return text.slice(0, at) + `${key}=${value}${nl}` + text.slice(at); }
    return text + (text.endsWith('\n') || !text ? '' : nl) + `[Game Settings]${nl}${key}=${value}${nl}`;
}

// exe: the game server's RumbleverseClient-Win64-Shipping.exe. Never throws.
export function applyBots(exe, on = BOTS, log = msg => console.log(`[bots] ${msg}`)) {
    const win64 = dirname(exe);
    try {
        const dll = join(win64, 'rvbots.dll');
        if (on) {
            const src = fs.readFileSync(DLL_SRC);
            if (!fs.existsSync(dll) || md5(fs.readFileSync(dll)) !== md5(src)) { replace(dll, src); log('installed rvbots.dll'); }
        }
        const ini = join(win64, 'DList.ini');
        if (fs.existsSync(ini)) {
            const text = fs.readFileSync(ini, 'latin1');
            const next = on ? dlistAdd(text, 'rvbots.dll', '20') : dlistRemove(text, 'rvbots.dll');
            if (next === null) log('DList.ini has no free slot, rvbots.dll not listed');
            else if (next !== text) { replace(ini, Buffer.from(next, 'latin1')); log(on ? 'listed rvbots.dll in DList.ini' : 'took rvbots.dll out of DList.ini'); }
        }
        const server = join(win64, 'Server.dll');
        if (fs.existsSync(server)) {
            const buf = fs.readFileSync(server), jobs = on ? navJobs() : ORIGINAL_JOBS;
            if (findJobsSetting(buf) < 0) log('Server.dll: navigation build setting not found, left as it is');
            else {
                const out = setNavJobs(buf, jobs);
                if (out) { replace(server, out); log(`Server.dll: navigation built ${jobs} at a time`); }
            }
        }
        if (on) {
            const radius = /^\d+$/.test(process.env.RV_BOT_NAV_RADIUS || '') ? process.env.RV_BOT_NAV_RADIUS : '100';
            for (const mode of MODES) {
                const cfg = join(win64, `Config.${mode}.ini`);
                if (!fs.existsSync(cfg)) continue;
                const text = fs.readFileSync(cfg, 'latin1');
                const next = setIniValue(setIniValue(text, 'BotNavigation', 'true'), 'BotNavRadius', radius);
                if (next !== text) { replace(cfg, Buffer.from(next, 'latin1')); log(`Config.${mode}.ini: bot navigation on, radius ${radius} m`); }
            }
        }
    } catch (e) { log(`skipped: ${e.message}`); }
}
