// Add-ons: your own DLLs, files and small binary patches, put in place right before each game server
// starts, so server kit updates do not undo them.
//
// Put them in the add-ons folder (RV_ADDONS_DIR, default /data/addons, which is <data folder>/addons on
// the host) together with a list, addons.list:
//
//   # a DLL for the mod loader: copied next to the game and listed in a free DList.ini slot,
//   # loaded <timer> seconds after the server starts (default 20)
//   dll   mymod.dll  timer=20
//   # any other file, copied next to the game (or to= a path inside the server folder)
//   file  mymod.ini
//   # change bytes in a game file, only when it is exactly the expected version (md5 before and after);
//   # offsets are file offsets, bytes are hex
//   patch Rumbleverse/Binaries/Win64/Server.dll  from=<md5> to=<md5>  0x26aad=00040000
//
// Taking a line out of the list undoes it at the next start: the DLL leaves DList.ini, copied files are
// deleted, a patched file gets its original back (kept in the add-ons folder under .orig/).
// A file that is not the expected version (for example after a kit update) is left alone and logged.
// RV_ADDONS=off skips all of this.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';

const OFF = /^(0|off|no|false)$/i.test(process.env.RV_ADDONS || 'on');
const DIR = process.env.RV_ADDONS_DIR || '/data/addons';
const md5 = buf => createHash('md5').update(buf).digest('hex');

function replace(dest, data) {
    fs.mkdirSync(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.${basename(dest)}.rv-new-${process.pid}`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
}
const readIf = p => { try { return fs.readFileSync(p); } catch { return null; } };

// addons.list -> [{kind, name, opts, edits}]; bad lines are reported, not fatal.
export function parseList(text, log = () => {}) {
    const out = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) return;
        const [kind, name, ...rest] = line.split(/\s+/);
        const opts = {}, edits = [];
        for (const r of rest) {
            const m = r.match(/^([^=]+)=(.*)$/);
            if (!m) { log(`addons.list line ${i + 1}: cannot read "${r}"`); return; }
            if (/^0x[0-9a-f]+$/i.test(m[1])) {
                if (!/^([0-9a-f]{2})+$/i.test(m[2])) { log(`addons.list line ${i + 1}: bytes must be hex: ${r}`); return; }
                edits.push([parseInt(m[1], 16), Buffer.from(m[2], 'hex')]);
            } else opts[m[1]] = m[2];
        }
        if (!['dll', 'file', 'patch'].includes(kind) || !name) { log(`addons.list line ${i + 1}: unknown entry "${line}"`); return; }
        if (kind === 'patch' && (!/^[0-9a-f]{32}$/i.test(opts.from || '') || !/^[0-9a-f]{32}$/i.test(opts.to || '') || !edits.length)) {
            log(`addons.list line ${i + 1}: a patch needs from=<md5> to=<md5> and at least one offset=bytes`); return;
        }
        out.push({ kind, name, opts, edits });
    });
    return out;
}

// DList.ini: the slot listing `name`, or a free one (PutYourDLLHere.dll). Keeps the file's line endings.
const slotOf = (text, re) => { const m = text.match(re); return m ? m[1] : null; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function dlistAdd(text, name, timer) {
    let slot = slotOf(text, new RegExp(`^DLL(\\d+)=${esc(name)}\\r?$`, 'mi'));
    if (slot === null) slot = slotOf(text, /^DLL(\d+)=PutYourDLLHere\.dll\r?$/m);
    if (slot === null) return null;
    return text.replace(new RegExp(`^DLL${slot}=[^\\r\\n]*`, 'm'), `DLL${slot}=${name}`)
        .replace(new RegExp(`^Timer${slot}=[^\\r\\n]*`, 'm'), `Timer${slot}=${timer}`);
}
export function dlistRemove(text, name) {
    const slot = slotOf(text, new RegExp(`^DLL(\\d+)=${esc(name)}\\r?$`, 'mi'));
    if (slot === null) return text;
    return text.replace(new RegExp(`^DLL${slot}=[^\\r\\n]*`, 'm'), `DLL${slot}=PutYourDLLHere.dll`)
        .replace(new RegExp(`^Timer${slot}=[^\\r\\n]*`, 'm'), `Timer${slot}=JustPutANumberInSeconds`);
}

// Applies the bytes of a patch entry. Returns the new file, or null when `buf` is not the `from` version.
export function patchBuffer(buf, entry) {
    if (md5(buf) !== entry.opts.from.toLowerCase()) return null;
    const out = Buffer.from(buf);
    for (const [off, bytes] of entry.edits) {
        if (off + bytes.length > out.length) return null;
        bytes.copy(out, off);
    }
    return md5(out) === entry.opts.to.toLowerCase() ? out : null;
}

// Inside the server folder only.
function inside(root, p) {
    const full = resolve(root, p);
    const rel = relative(root, full);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
}

// exe: the game server's RumbleverseClient-Win64-Shipping.exe. Never throws.
export function applyAddons(exe, { dir = DIR, off = OFF, log = msg => console.log(`[addons] ${msg}`) } = {}) {
    if (off) return;
    const win64 = dirname(exe), root = resolve(win64, '../../..');
    const stateFile = join(dir, '.state.json');
    try {
        const listText = readIf(join(dir, 'addons.list'));
        const state = JSON.parse(readIf(stateFile) || '{"dlls":[],"files":[],"patches":{}}');
        if (!listText && !state.dlls.length && !state.files.length && !Object.keys(state.patches).length) return;
        const entries = listText ? parseList(listText.toString('utf8'), log) : [];
        const next = { dlls: [], files: [], patches: {} };
        const iniPath = join(win64, 'DList.ini');
        let dlist = readIf(iniPath)?.toString('latin1') ?? null;
        const dlistBefore = dlist;

        for (const e of entries) {
            try {
                if (e.kind === 'dll' || e.kind === 'file') {
                    const src = readIf(join(dir, e.name));
                    if (!src) { log(`${e.name}: not in the add-ons folder`); continue; }
                    const dest = e.opts.to ? inside(root, e.opts.to) : join(win64, basename(e.name));
                    if (!dest) { log(`${e.name}: to= must be inside the server folder`); continue; }
                    const cur = readIf(dest);
                    if (!cur || md5(cur) !== md5(src)) { replace(dest, src); log(`installed ${relative(root, dest)}`); }
                    if (e.kind === 'dll') {
                        if (dlist === null) { log(`${e.name}: no DList.ini, not listed`); continue; }
                        const timer = /^\d+$/.test(e.opts.timer || '') ? e.opts.timer : '20';
                        const t = dlistAdd(dlist, basename(dest), timer);
                        if (t === null) log(`${e.name}: DList.ini has no free slot, not listed`);
                        else { dlist = t; next.dlls.push(basename(dest)); }
                    } else next.files.push(relative(root, dest));
                } else {
                    const target = inside(root, e.name);
                    if (!target) { log(`${e.name}: must be a path inside the server folder`); continue; }
                    const cur = readIf(target);
                    if (!cur) { log(`${e.name}: not found, not patched`); continue; }
                    const have = md5(cur), to = e.opts.to.toLowerCase();
                    if (have !== to) {
                        const out = patchBuffer(cur, e);
                        if (!out) { log(`${e.name}: not the expected version (md5 ${have}), not patched`); continue; }
                        const orig = join(dir, '.orig', e.name);
                        if (md5(readIf(orig) || Buffer.alloc(0)) !== have) replace(orig, cur);
                        replace(target, out);
                        log(`patched ${e.name}`);
                    }
                    next.patches[e.name] = { from: e.opts.from.toLowerCase(), to };
                }
            } catch (err) { log(`${e.name}: ${err.message}`); }
        }

        // Undo what an earlier list did and this one no longer does.
        for (const name of state.dlls) if (!next.dlls.includes(name)) {
            if (dlist !== null) dlist = dlistRemove(dlist, name);
            try { fs.unlinkSync(join(win64, name)); } catch { /* already gone */ }
            log(`removed ${name}`);
        }
        for (const rel of state.files) if (!next.files.includes(rel)) {
            const p = inside(root, rel);
            if (p) { try { fs.unlinkSync(p); } catch { /* already gone */ } log(`removed ${rel}`); }
        }
        for (const [rel, p] of Object.entries(state.patches)) if (!next.patches[rel]) {
            const target = inside(root, rel), orig = readIf(join(dir, '.orig', rel)), cur = target && readIf(target);
            if (target && cur && orig && md5(cur) === p.to && md5(orig) === p.from) { replace(target, orig); log(`restored the original ${rel}`); }
        }
        if (dlist !== null && dlist !== dlistBefore) replace(iniPath, Buffer.from(dlist, 'latin1'));
        fs.mkdirSync(dir, { recursive: true });
        replace(stateFile, JSON.stringify(next, null, 2));
    } catch (e) { log(`skipped: ${e.message}`); }
}
