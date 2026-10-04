// First-time setup: the Linux counterpart of the upstream Setup-RVServer.ps1.
//
// Same steps, same backend calls and the same file rules as the Windows script:
//   1. game files from the user's zip (client-only files dropped)
//   2. public IP and region (region by TCP ping to GameLift, as the game and setup do)
//   3. sign-up with the backend: private (setup code) or community (contact) - or an existing node
//   4. server kit downloaded THROUGH the backend, every file SHA-256 checked
//   5. configs written by the kit's own setup-box.mjs
// The Windows-only steps (firewall rules, scheduled task, Node.js and VC++ installers) have no
// counterpart: the container image provides Node.js and Wine, and runs the servers itself.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync,
    copyFileSync, readFileSync, writeFileSync, symlinkSync, lstatSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { DATA, SERVER, WIN64, SUP_DIR, LOGS, SETUP_LOG, GAME_EXE, DEFAULT_BACKEND, MODES,
    readState, updateState, gameInstalled, kitVersion, ensureDirs } from './lib.mjs';

export const REGIONS = {
    'us-east-1': 'USA East', 'us-west-1': 'USA West', 'eu-central-1': 'Europe', 'sa-east-1': 'South America',
    'ap-northeast-1': 'Asia (Tokyo)', 'ap-south-1': 'India', 'ap-southeast-1': 'Asia (Singapore)', 'ap-southeast-2': 'Oceania',
};

// Files the Windows setup removes after unpacking a game zip: someone else's configs, secrets and
// supervisor state, logs and dumps, and the player mod (a server does not use it).
const DROP = ['Config*.ini*', 'ds-instances.json*', 'modes.json*', 'rv-server.version', '*.log', '*.dmp', 'crash_trace*',
    'Client.dll*', 'cnsl.dll*', 'odin.dll*', 'odin_crypto.dll*', 'rvclient.version*'];
const dropRe = new RegExp('^(' + DROP.map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|') + ')$', 'i');

// ---- helpers ----
function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        let out = '';
        p.stdout.on('data', d => { out += d; opts.onLine?.(String(d)); });
        p.stderr.on('data', d => { out += d; });
        p.on('error', reject);
        p.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}: ${out.trim().slice(-400)}`)));
    });
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}

function* walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walk(p); else yield p;
    }
}

async function postJson(backend, route, body, timeoutMs = 60000) {
    const r = await fetch(backend.replace(/\/$/, '') + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || json?.success === false) throw new Error(json?.error || `HTTP ${r.status}`);
    return json;
}

function tcpPing(host, port = 443, timeoutMs = 2500) {
    return new Promise(resolve => {
        const t0 = process.hrtime.bigint();
        const s = net.connect({ host, port });
        const done = ms => { s.destroy(); resolve(ms); };
        s.setTimeout(timeoutMs, () => done(null));
        s.once('connect', () => done(Number(process.hrtime.bigint() - t0) / 1e6));
        s.once('error', () => done(null));
    });
}

// Same measurement as the Windows setup: the TCP connect time to each region's GameLift endpoint.
export async function measureRegions() {
    const out = {};
    await Promise.all(Object.keys(REGIONS).map(async r => {
        let best = null;
        for (let i = 0; i < 3; i++) {
            const ms = await tcpPing(`gamelift.${r}.amazonaws.com`);
            if (ms != null && (best == null || ms < best)) best = ms;
        }
        out[r] = best == null ? null : Math.max(1, Math.round(best));
    }));
    return out;
}

export async function detectPublicIp() {
    for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com']) {
        try {
            const t = (await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text()).trim();
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
        } catch { /* try the next one */ }
    }
    return '';
}

// What this machine is, sent with network checks and sign-ups so the admins know what they review.
function machineInfo() {
    let distro = 'Linux';
    try { distro = (readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || distro; } catch { /* none */ }
    let vm = '';
    try {
        const v = readFileSync('/sys/class/dmi/id/sys_vendor', 'utf8').trim();
        const p = readFileSync('/sys/class/dmi/id/product_name', 'utf8').trim();
        if (/VMware|KVM|QEMU|Xen|HVM domU|Virtual Machine|VirtualBox|Bochs|OpenStack|Standard PC|Google|Amazon|DigitalOcean|Droplet|Hetzner|Parallels|Nutanix|oVirt|RHEV|Proxmox|Linode|Vultr|OVH|Scaleway|Alibaba|Tencent/i.test(`${v} ${p}`)) vm = `${v} ${p}`.trim();
    } catch { /* not visible in this container */ }
    return { os: `${distro} (Wine, container ${os.release()})`, serverOs: false, vm };
}

// A stable per-installation id, hashed the way the Windows setup hashes its machine id.
function hostId() {
    let s = readState();
    if (!s.machineId) s = updateState({ machineId: randomUUID() });
    return createHash('sha256').update(`rv-host:${s.machineId.toLowerCase()}`).digest('hex');
}

// ---- steps ----
export async function installGameFiles(zip, log) {
    if (gameInstalled()) { log(`Game files already in place: ${SERVER}`); return; }
    if (!existsSync(zip)) throw new Error(`Game zip not found at ${zip}. Mount your zip there (see README).`);
    const unz = join(DATA, '_game-unpack');
    rmSync(unz, { recursive: true, force: true });
    mkdirSync(unz, { recursive: true });
    log(`Unpacking ${zip} (about 11 GB, this takes a few minutes)...`);
    await run('bsdtar', ['-xf', zip, '-C', unz]);
    let root = null;
    for (const f of walk(unz)) {
        if (f.endsWith(`/Rumbleverse/Binaries/Win64/${GAME_EXE}`)) { root = dirname(dirname(dirname(dirname(f)))); break; }
    }
    if (!root) throw new Error(`No Rumbleverse/Binaries/Win64/${GAME_EXE} inside the zip`);
    rmSync(SERVER, { recursive: true, force: true });
    renameSync(root, SERVER);
    rmSync(unz, { recursive: true, force: true });
    let dropped = 0;
    for (const f of walk(SERVER)) {
        const name = f.slice(f.lastIndexOf('/') + 1);
        if (dropRe.test(name)) { rmSync(f, { force: true }); dropped++; }
    }
    rmSync(join(WIN64, 'RVSupervisor'), { recursive: true, force: true });
    rmSync(join(SERVER, '_updates'), { recursive: true, force: true });
    log(`Game files ready (${dropped} client-only or leftover files removed).`);
}

async function register(opts, log) {
    const backend = opts.backend;
    const s = readState();
    if (opts.nodeId && opts.nodeKey) {
        log(`Using the existing registration ${opts.nodeId}.`);
        updateState({ nodeId: opts.nodeId, nodeKey: opts.nodeKey, edition: opts.edition, backend });
        return { nodeId: opts.nodeId, nodeKey: opts.nodeKey };
    }
    if (s.nodeId && s.nodeKey) {
        try {
            await postJson(backend, '/nodes/status', { nodeId: s.nodeId, key: s.nodeKey });
            log(`Using this server's existing registration ${s.nodeId}.`);
            return { nodeId: s.nodeId, nodeKey: s.nodeKey };
        } catch (e) {
            if (!/Unknown node|bad key/i.test(e.message)) throw new Error(`Backend check failed: ${e.message}`);
            log(`The old registration ${s.nodeId} was removed - registering again.`);
            updateState({ nodeId: '', nodeKey: '' });
        }
    }
    let r;
    if (opts.edition === 'private') {
        if (!opts.setupCode) throw new Error('A private server needs a setup code (launcher: Server Status > My private servers > Set up a private server).');
        log('Registering a private server with the setup code...');
        r = await postJson(backend, '/nodes/signup-private', { code: opts.setupCode, name: opts.name });
    } else {
        if (!opts.contact) throw new Error('A community server needs your Discord name, so the admins can reach you about approval.');
        try {
            const net = await postJson(backend, '/nodes/network-check', { machine: machineInfo() });
            if (net?.hosting === false) log(`Note: ${opts.publicIp} looks like a home connection${net.isp ? ` (${net.isp})` : ''}. Public matchmaking needs a VPS or dedicated server; an admin checks it during review.`);
        } catch { /* older backend without the route */ }
        log('Registering a community server (it then waits for approval)...');
        r = await postJson(backend, '/nodes/signup', { name: opts.name, contact: opts.contact, publicIp: opts.publicIp, machine: machineInfo() });
    }
    const nodeId = r.node?.id, nodeKey = r.key;
    if (!nodeId || !nodeKey) throw new Error('The backend did not return a node id and key.');
    updateState({ nodeId, nodeKey, edition: opts.edition, backend });
    log(`Registered as ${nodeId} (${r.node?.status || 'pending'}).`);
    return { nodeId, nodeKey };
}

async function installKit(backend, nodeId, nodeKey, log) {
    const { manifest: m } = await postJson(backend, '/nodes/update/manifest', { nodeId, key: nodeKey });
    if (!m?.version || !m.package || !m.sha256 || !Array.isArray(m.files)) throw new Error('The backend returned an incomplete server kit manifest.');
    if (kitVersion() === m.version) { log(`Already on server kit ${m.version}.`); return m.version; }
    log(`Downloading server kit ${m.version} (${Math.round((m.size || 0) / 1048576)} MB) through the backend. This can be slow; it is checked afterwards.`);
    const zip = join(DATA, m.package.replace(/[^A-Za-z0-9._-]/g, '_'));
    const res = await fetch(backend.replace(/\/$/, '') + '/nodes/update/package', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, key: nodeKey, version: m.version }), signal: AbortSignal.timeout(3 * 3600 * 1000),
    });
    if (!res.ok) throw new Error(`Kit download failed: HTTP ${res.status}`);
    let got = 0, lastPct = -10;
    const counter = new Transform({
        transform(chunk, _e, cb) {
            got += chunk.length;
            const pct = m.size ? Math.floor(got * 100 / m.size) : 0;
            if (pct >= lastPct + 10) { lastPct = pct; log(`  kit download ${pct}% (${Math.round(got / 1048576)} MB)`); }
            cb(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(zip));
    if ((await sha256(zip)) !== String(m.sha256).toLowerCase()) { rmSync(zip, { force: true }); throw new Error('The kit does not match its SHA-256 - not installed. Try again.'); }
    const stage = join(DATA, '_kit');
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    await run('bsdtar', ['-xf', zip, '-C', stage]);
    for (const f of m.files) {
        const p = join(stage, f.path);
        if (!existsSync(p) || (await sha256(p)) !== String(f.sha256).toLowerCase()) throw new Error(`Kit file failed its SHA-256 check: ${f.path}`);
    }
    for (const f of m.files) {
        const dst = join(SERVER, f.path);
        mkdirSync(dirname(dst), { recursive: true });
        try { if (lstatSync(dst).isSymbolicLink()) rmSync(dst); } catch { /* not there */ }
        copyFileSync(join(stage, f.path), dst);
    }
    writeFileSync(join(SERVER, 'rv-server.version'), m.version);
    rmSync(stage, { recursive: true, force: true });
    rmSync(zip, { force: true });
    log(`Installed server kit ${m.version} (${m.files.length} files, all checked).`);
    return m.version;
}

async function writeConfigs(opts, nodeId, nodeKey, log) {
    const args = ['setup-box.mjs', '--backend', opts.backend, '--node-id', nodeId, '--node-key', nodeKey,
        '--region', opts.region, '--public-ip', opts.publicIp, '--modes', opts.modes.join(','), '--host-id', hostId()];
    if (opts.edition === 'private') args.push('--private');
    const out = await run(process.execPath, args, { cwd: SUP_DIR });
    for (const line of out.split(/\r?\n/)) if (line.trim()) log(line.trim());
}

export async function ensureWinePrefix(log = () => {}) {
    const prefix = process.env.WINEPREFIX || join(DATA, 'wine');
    if (!existsSync(join(prefix, 'system.reg'))) {
        log('Preparing the Wine environment (first start only)...');
        await run('wineboot', ['-i'], { env: { ...process.env, WINEPREFIX: prefix } });
    }
    // The game writes its logs to the Wine user's LocalAppData: point that at /data/logs/game.
    const user = os.userInfo().username;
    const logs = join(prefix, 'drive_c', 'users', user, 'AppData', 'Local', 'Rumbleverse', 'Saved', 'Logs');
    mkdirSync(join(LOGS, 'game'), { recursive: true });
    mkdirSync(dirname(logs), { recursive: true });
    try { if (!lstatSync(logs).isSymbolicLink()) { rmSync(logs, { recursive: true, force: true }); symlinkSync(join(LOGS, 'game'), logs); } }
    catch { symlinkSync(join(LOGS, 'game'), logs); }
}

// opts: { edition, setupCode, contact, name, modes[], publicIp, region, nodeId, nodeKey, backend, zip }
export async function runSetup(input, log) {
    ensureDirs();
    const say = msg => { const line = `${new Date().toISOString()} ${msg}`; log(msg); try { appendFileSync(SETUP_LOG, line + '\n'); } catch { /* ignore */ } };
    const opts = { ...input };
    opts.backend = opts.backend || readState().backend || DEFAULT_BACKEND;
    if (!['private', 'community'].includes(opts.edition)) throw new Error('Edition must be "private" or "community".');
    say(`== Rumbleverse server setup (${opts.edition})`);

    say('== Game files');
    await installGameFiles(opts.zip || '/game.zip', say);

    say('== Your server');
    if (!opts.publicIp) opts.publicIp = await detectPublicIp();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(opts.publicIp || '')) throw new Error('Could not detect the public IPv4 address - set it (RV_PUBLIC_IP).');
    say(`Public IP players connect to: ${opts.publicIp}`);
    if (!opts.region) {
        if (opts.edition === 'private') opts.region = 'us-east-1';   // never matchmade: region unused
        else {
            say('Measuring the ping to each region...');
            const pings = await measureRegions();
            for (const [r, ms] of Object.entries(pings)) say(`  ${REGIONS[r].padEnd(16)} ${ms == null ? 'no answer' : ms + ' ms'}`);
            opts.region = Object.entries(pings).filter(([, ms]) => ms != null).sort((a, b) => a[1] - b[1])[0]?.[0] || 'us-east-1';
        }
    }
    if (!REGIONS[opts.region]) throw new Error(`Unknown region ${opts.region}`);
    say(`Region: ${opts.region} (${REGIONS[opts.region]})`);
    if (!opts.modes?.length) opts.modes = opts.edition === 'private' ? ['playground'] : ['solo', 'playground'];
    for (const m of opts.modes) if (!MODES.some(x => x.key === m)) throw new Error(`Unknown mode "${m}" (solo, playground, duos, trios, squads)`);
    if (!opts.name) opts.name = opts.edition === 'private' ? 'Linux private server' : `${REGIONS[opts.region]} Community`;
    say(`Name: ${opts.name}   Modes: ${opts.modes.join(', ')}`);
    const { nodeId, nodeKey } = await register(opts, say);

    say('== Server kit (through the backend)');
    await installKit(opts.backend, nodeId, nodeKey, say);

    say('== Configs');
    await writeConfigs(opts, nodeId, nodeKey, say);
    await ensureWinePrefix(say);

    updateState({ edition: opts.edition, name: opts.name, region: opts.region, publicIp: opts.publicIp, setupDoneAt: new Date().toISOString() });
    say(opts.edition === 'private'
        ? '== Done. Your private server starts now: launcher > Server Status > My private servers > Join.'
        : `== Done. Your server ${nodeId} is registered and WAITING FOR APPROVAL. It joins matchmaking by itself once approved.`);
    return { nodeId };
}

// Settings from environment variables (for automated installs). Returns null when the
// required ones are missing, so the web setup wizard is used instead.
export function optionsFromEnv(env = process.env) {
    const edition = (env.RV_EDITION || '').toLowerCase();
    if (!edition) return null;
    const modesRaw = (env.RV_MODES || '').toLowerCase().trim();
    const modes = modesRaw === 'all' ? MODES.map(m => m.key) : modesRaw.split(',').map(s => s.trim()).filter(Boolean);
    const o = { edition, setupCode: env.RV_SETUP_CODE || '', contact: env.RV_CONTACT || '', name: env.RV_NAME || '', modes,
        publicIp: env.RV_PUBLIC_IP || '', region: env.RV_REGION || '', nodeId: env.RV_NODE_ID || '', nodeKey: env.RV_NODE_KEY || '',
        backend: env.RV_BACKEND || '', zip: env.RV_GAME_ZIP || '/game.zip' };
    const haveCredential = (o.nodeId && o.nodeKey) || readState().nodeId || (edition === 'private' ? o.setupCode : o.contact);
    return haveCredential ? o : null;
}
