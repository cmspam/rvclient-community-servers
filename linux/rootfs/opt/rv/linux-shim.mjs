// Preloaded into the upstream supervisor (node --import linux-shim.mjs ds-supervisor.js ...).
//
// The supervisor starts each game server with spawn('<...>/RumbleverseClient-Win64-Shipping.exe',
// args). Linux cannot execute a Windows binary directly, so any *.exe passed to spawn/execFile is
// run through Wine instead. The upstream files stay exactly as the server kit delivers them, so
// kit updates keep applying unchanged.
//
// The kit's updater installs a file by copying it over the old one (copyFileSync). On Windows a
// loaded DLL is locked, so it is moved aside and running servers keep the old image. Linux has no
// such lock: the copy would rewrite the file a running server has mapped (Server.dll), which freezes
// it mid-match. So an existing file is replaced the Linux way instead: the copy goes to a temporary
// file in the same folder, which is then renamed over the old one. Running servers keep the old
// file they have open; the next start loads the new one.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const WINE = process.env.RV_WINE || 'wine';
// RV_KSM=on: start through rv-ksm, which marks the game server's memory as mergeable, so the
// kernel's KSM keeps identical pages of several servers only once (needs CAP_SYS_RESOURCE and
// KSM switched on on the host: /sys/kernel/mm/ksm/run = 1).
const KSM = /^(1|on|yes|true)$/i.test(process.env.RV_KSM || '');
const isExe = cmd => typeof cmd === 'string' && /\.exe$/i.test(cmd);

function viaWine(fn) {
    return function (cmd, args, ...rest) {
        if (!isExe(cmd)) return fn.call(this, cmd, args, ...rest);
        if (!Array.isArray(args)) { rest.unshift(args); args = []; }
        return KSM ? fn.call(this, 'rv-ksm', [WINE, cmd, ...args], ...rest)
            : fn.call(this, WINE, [cmd, ...args], ...rest);
    };
}

for (const name of ['spawn', 'execFile', 'spawnSync', 'execFileSync']) {
    childProcess[name] = viaWine(childProcess[name]);
}

const copyFileSync = fs.copyFileSync;
export function replacingCopyFileSync(src, dest, mode = 0) {
    // COPYFILE_EXCL must fail on an existing file, and a missing file has nothing to protect.
    if (mode & fs.constants.COPYFILE_EXCL || typeof dest !== 'string' || !fs.existsSync(dest)) return copyFileSync(src, dest, mode);
    const tmp = join(dirname(dest), `.${basename(dest)}.rv-new-${process.pid}`);
    try {
        copyFileSync(src, tmp, mode);
        fs.renameSync(tmp, dest);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* not created */ }
        throw e;
    }
}
fs.copyFileSync = replacingCopyFileSync;

// Make `import { spawn } from 'node:child_process'` (and copyFileSync from 'node:fs') in the
// upstream modules see the wrappers.
syncBuiltinESMExports();
