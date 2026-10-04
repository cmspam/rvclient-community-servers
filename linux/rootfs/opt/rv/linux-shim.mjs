// Preloaded into the upstream supervisor (node --import linux-shim.mjs ds-supervisor.js ...).
//
// The supervisor starts each game server with spawn('<...>/RumbleverseClient-Win64-Shipping.exe',
// args). Linux cannot execute a Windows binary directly, so any *.exe passed to spawn/execFile is
// run through Wine instead. The upstream files stay exactly as the server kit delivers them, so
// kit updates keep applying unchanged.
import childProcess from 'node:child_process';
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
// Make `import { spawn } from 'node:child_process'` in the upstream modules see the wrappers.
syncBuiltinESMExports();
