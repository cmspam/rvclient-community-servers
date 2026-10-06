// Automatic server kit updates.
//
// The kit's own updater (RVSupervisor/server-updater.js) only runs when someone asks for an update:
// the rVclient admins, the Windows rV Modes "update" button, or `rv update`. This asks for one by
// itself: a few minutes after the container starts and then every RV_KIT_UPDATE_HOURS (default 4),
// it compares the installed kit with the newest the backend offers and installs a newer one through
// the same call as `rv update`. The updater then restarts each mode only once it is empty (after
// 3 h regardless) and rolls back on its own if the new build crashes twice.
//
// RV_KIT_AUTO_UPDATE=off turns it off. If the updater rolled a version back (crashes happen on any
// version), the next check simply tries the newest version again.
import { isConfigured } from './lib.mjs';
import * as ops from './ops.mjs';

const FIRST_CHECK_MS = 5 * 60 * 1000;   // let the modes boot and the node register first
const BUSY = new Set(['installing', 'waiting-restart']);

// 2026.10.5.2 > 2026.10.4.17: compare the dotted numbers one by one.
export function newer(a, b) {
    const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d > 0;
    }
    return false;
}

// One check. Returns what it did, for the log.
export async function checkOnce(node = ops.node, update = ops.update) {
    if (!isConfigured()) return 'not set up yet';
    const r = await node();
    const local = r.localVersion, latest = r.latestServerVersion, st = r.update;
    if (!latest) return `on ${local || 'unknown'}; the backend offered no version`;
    if (st && BUSY.has(st.state)) return `an update is already ${st.state} (${st.version || latest})`;
    if (!newer(latest, local)) return `up to date (${local})`;
    const res = await update();
    return `installing ${latest} (was ${local}): ${res.message || 'started'}`;
}

export function startKitAutoUpdate(log) {
    if (/^(0|false|no|off)$/i.test(process.env.RV_KIT_AUTO_UPDATE || 'on')) {
        log('[kit-update] automatic server kit updates are off (RV_KIT_AUTO_UPDATE)');
        return;
    }
    const hours = Number(process.env.RV_KIT_UPDATE_HOURS) > 0 ? Number(process.env.RV_KIT_UPDATE_HOURS) : 4;
    const tick = async () => {
        try { log(`[kit-update] ${await checkOnce()}`); }
        catch (e) { log(`[kit-update] check failed: ${e.message}`); }
    };
    setTimeout(() => { tick(); setInterval(tick, hours * 3600 * 1000).unref(); }, FIRST_CHECK_MS).unref();
    log(`[kit-update] checking for a newer server kit in ${FIRST_CHECK_MS / 60000} minutes, then every ${hours} h`);
}
