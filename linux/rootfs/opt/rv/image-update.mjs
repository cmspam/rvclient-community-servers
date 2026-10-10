// Container image updates, only while nobody is playing.
//
// The image knows the build it is (/opt/rv/IMAGE: its registry tag and git revision, written when it is
// built). About once an hour (RV_IMAGE_UPDATE_HOURS) this asks the registry which build that tag points to
// now. When it is a newer one, it waits until every game server is empty - the supervisor's (warm spares
// included) and the server pairs' active ones - and then stops the container. The service manager starts it again and, with
// Quadlet's Pull=newer (podman run --pull=newer), on the new image. A match is never cut off for an update;
// after RV_IMAGE_UPDATE_MAX_HOURS (default 6) of servers never being empty it restarts anyway.
//
// If the container comes back on the same build (a setup that does not pull on start: Docker, or a Quadlet
// without Pull=newer), it logs how to get updates and does not stop again for that build.
// RV_IMAGE_AUTO_UPDATE=off turns it off.
import { readFileSync } from 'node:fs';
import { readState, updateState } from './lib.mjs';
import { admin } from './ops.mjs';
import { pairStatus } from './pairs.mjs';

const OFF = /^(0|off|no|false)$/i.test(process.env.RV_IMAGE_AUTO_UPDATE || 'on');
const HOURS = Number(process.env.RV_IMAGE_UPDATE_HOURS) > 0 ? Number(process.env.RV_IMAGE_UPDATE_HOURS) : 1;
const MAX_HOURS = Number(process.env.RV_IMAGE_UPDATE_MAX_HOURS) > 0 ? Number(process.env.RV_IMAGE_UPDATE_MAX_HOURS) : 6;
const FIRST_CHECK_MS = 10 * 60 * 1000;

// { ref: 'ghcr.io/owner/name:tag', revision: '<git sha>' } of this image, or null.
export function thisImage() {
    try {
        const kv = Object.fromEntries(readFileSync('/opt/rv/IMAGE', 'utf8').split('\n').map(l => l.split('=')).filter(x => x.length === 2));
        return kv.ref && kv.revision ? { ref: kv.ref, revision: kv.revision } : null;
    } catch { return null; }
}

// The git revision the registry's tag points to now (the image's org.opencontainers.image.revision label).
export async function remoteRevision(ref, fetchFn = fetch) {
    const m = /^([^/]+)\/(.+):([^:/]+)$/.exec(ref);
    if (!m) throw new Error(`not an image reference: ${ref}`);
    const [, host, repo, tag] = m;
    const tok = await (await fetchFn(`https://${host}/token?scope=repository:${repo}:pull&service=${host}`)).json();
    const h = { Authorization: `Bearer ${tok.token}` };
    const get = async (path, accept) => {
        const r = await fetchFn(`https://${host}/v2/${repo}/${path}`, { headers: { ...h, ...(accept ? { Accept: accept } : {}) } });
        if (!r.ok) throw new Error(`registry ${path}: HTTP ${r.status}`);
        return r.json();
    };
    const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
    let man = await get(`manifests/${tag}`, accept);
    if (man.manifests) {
        const pick = man.manifests.find(x => x.platform?.os === 'linux' && x.platform?.architecture === 'amd64');
        if (!pick) throw new Error('no linux/amd64 image');
        man = await get(`manifests/${pick.digest}`, accept);
    }
    const cfg = await get(`blobs/${man.config.digest}`);
    return cfg.config?.Labels?.['org.opencontainers.image.revision'] || '';
}

// Players on any game server right now (the supervisor's, warm spares included, + pairs' active servers); null if unknown.
export async function playersNow() {
    let n = 0;
    try { n += ((await admin('/instances')).instances || []).reduce((s, i) => s + (i.running ? Number(i.players) || 0 : 0), 0); }
    catch { return null; }
    for (const m of Object.values(pairStatus() || {})) n += Number(m.activeDetails?.players) || 0;
    return n;
}

export function startImageAutoUpdate(log, restart) {
    const me = thisImage();
    if (OFF) { log('[image-update] off (RV_IMAGE_AUTO_UPDATE=off)'); return; }
    if (!me) { log('[image-update] this image does not know its build (/opt/rv/IMAGE) - not checking for updates'); return; }
    const st = readState().imageUpdate || {};
    if (st.stoppedFor && st.stoppedFor !== me.revision && st.from === me.revision)
        log(`[image-update] the container was restarted for build ${st.stoppedFor.slice(0, 7)} but still runs ${me.revision.slice(0, 7)}: ` +
            'its service does not pull a newer image on start (Quadlet: Pull=newer, see the README)');
    let waitingFor = null, since = 0;
    const tick = async () => {
        try {
            const rev = await remoteRevision(me.ref);
            if (!rev || rev === me.revision) { waitingFor = null; return; }
            const done = readState().imageUpdate || {};
            if (done.stoppedFor === rev && done.from === me.revision) return;   // already tried for this build
            if (waitingFor !== rev) { waitingFor = rev; since = Date.now(); log(`[image-update] newer image ${rev.slice(0, 7)} (running ${me.revision.slice(0, 7)}) - restarting once every server is empty (at most ${MAX_HOURS} h)`); }
            const players = await playersNow();
            const overdue = Date.now() - since >= MAX_HOURS * 3600 * 1000;
            if (players !== 0 && !overdue) return;
            log(players ? `[image-update] still ${players} player(s) after ${MAX_HOURS} h - restarting for the new image anyway` : '[image-update] all servers empty - restarting for the new image');
            updateState({ imageUpdate: { stoppedFor: rev, from: me.revision, at: new Date().toISOString() } });
            await restart();
        } catch (e) { log(`[image-update] check failed: ${e.message}`); }
    };
    // once an hour; every minute while a newer image waits for the servers to empty
    const loop = async () => { await tick(); setTimeout(loop, waitingFor ? 60000 : HOURS * 3600 * 1000).unref(); };
    setTimeout(loop, FIRST_CHECK_MS).unref();
    log(`[image-update] checking for a newer image of ${me.ref} in ${FIRST_CHECK_MS / 60000} minutes, then every ${HOURS} h`);
}
