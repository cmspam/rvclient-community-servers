// RAM saving for the game servers (RV_SLIM, default on). Run right before each game server starts,
// so it is back in place after any server kit update.
//
//   - rvslim.dll (built from src/rvslim.c) goes next to the game exe and is listed in DList.ini, so
//     the mod loader starts it. It frees data a server never uses: mesh render buffers, distance
//     fields, texture mips, sound data. About 1.5 GB less per mode.
//   - rest-api-client.dll (in the game files, not in this image) is patched in place: two bytes make
//     its matchmaking data table start with 0 teams instead of 64, which saves 433 MB per mode. Only the
//     known original file is patched, and RV_SLIM=off patches it back.
//
// Server kits from 2026.10.10.1 on free the same graphics and sound data in Server.dll itself (its
// SlimMemory setting, on by default). With such a Server.dll, rvslim.dll is taken out of DList.ini (two
// freeing the same data must not run together) and only the rest-api-client.dll patch is done here.
//
// Files are replaced by renaming a new copy over them, so running servers keep the copies they have open.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export const SLIM = !/^(0|off|no|false)$/i.test(process.env.RV_SLIM || 'on');
const DLL_SRC = process.env.RV_SLIM_DLL || '/opt/rv/lib/rvslim.dll';
const REST = 'Engine/Plugins/IronGalaxy/IGCozmo/Source/External/Cozmo/x64/Release/rest-api-client.dll';
const REST_ORIGINAL = '7735be1b3826910f085b30d392c9240f';
const REST_PATCHED = '6edaef550da41ddd837c0c8c12866bb0';
const REST_SPOTS = [0x1d9945, 0x1d9969];   // "mov r8d, 64": the byte at +2 is the team count

const md5 = buf => createHash('md5').update(buf).digest('hex');

function replace(dest, data) {
    const tmp = join(dirname(dest), `.${basename(dest)}.rv-new-${process.pid}`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
}

// Lists rvslim.dll in DList.ini (on = true) or takes it out. Keeps the file's line endings.
export function editDList(text, on) {
    const slotOf = re => { const m = text.match(re); return m ? m[1] : null; };
    let slot = slotOf(/^DLL(\d+)=rvslim\.dll\r?$/m);
    if (!on) {
        if (slot === null) return text;
        return text.replace(new RegExp(`^DLL${slot}=[^\\r\\n]*`, 'm'), `DLL${slot}=PutYourDLLHere.dll`)
            .replace(new RegExp(`^Timer${slot}=[^\\r\\n]*`, 'm'), `Timer${slot}=JustPutANumberInSeconds`);
    }
    if (slot === null) slot = slotOf(/^DLL(\d+)=PutYourDLLHere\.dll\r?$/m);
    if (slot === null) return null;
    return text.replace(new RegExp(`^DLL${slot}=[^\\r\\n]*`, 'm'), `DLL${slot}=rvslim.dll`)
        .replace(new RegExp(`^Timer${slot}=[^\\r\\n]*`, 'm'), `Timer${slot}=1`);
}

// Sets the team count in rest-api-client.dll. Returns the new file, or null when it is not the known file.
export function patchRest(buf, on) {
    const want = on ? REST_ORIGINAL : REST_PATCHED;
    if (md5(buf) !== want) return null;
    const out = Buffer.from(buf);
    for (const off of REST_SPOTS) {
        if (out.readUInt16BE(off) !== 0x41b8) return null;
        out[off + 2] = on ? 0 : 0x40;
    }
    return md5(out) === (on ? REST_PATCHED : REST_ORIGINAL) ? out : null;
}

// Does this Server.dll free the graphics and sound data itself (its SlimMemory setting)?
export function serverDllSlims(win64) {
    try { return fs.readFileSync(join(win64, 'Server.dll')).includes(Buffer.from('SlimMemory=')); } catch { return false; }
}

// exe: the game server's RumbleverseClient-Win64-Shipping.exe. Never throws: a problem here must not
// keep a server from starting.
export function applySlim(exe, on = SLIM, log = msg => console.log(`[slim] ${msg}`)) {
    const win64 = dirname(exe), root = resolve(win64, '../../..');
    try {
        const dll = join(win64, 'rvslim.dll');
        const useDll = on && !serverDllSlims(win64);   // Server.dll's own SlimMemory takes over from rvslim.dll
        if (useDll) {
            const src = fs.readFileSync(DLL_SRC);
            if (!fs.existsSync(dll) || md5(fs.readFileSync(dll)) !== md5(src)) { replace(dll, src); log('installed rvslim.dll'); }
        }
        const ini = join(win64, 'DList.ini');
        if (fs.existsSync(ini)) {
            const text = fs.readFileSync(ini, 'latin1');
            const next = editDList(text, useDll);
            if (next === null) log('DList.ini has no free slot, rvslim.dll not listed');
            else if (next !== text) {
                replace(ini, Buffer.from(next, 'latin1'));
                log(useDll ? 'listed rvslim.dll in DList.ini' : on ? 'took rvslim.dll out of DList.ini: Server.dll frees that memory itself (SlimMemory)' : 'took rvslim.dll out of DList.ini');
            }
        }
        const rest = join(root, REST);
        if (fs.existsSync(rest)) {
            const out = patchRest(fs.readFileSync(rest), on);
            if (out) { replace(rest, out); log(on ? 'patched rest-api-client.dll (0 matchmaking teams)' : 'restored the original rest-api-client.dll'); }
        }
    } catch (e) { log(`skipped: ${e.message}`); }
}
