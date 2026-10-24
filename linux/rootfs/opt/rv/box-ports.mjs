// The game servers a box runs and the UDP ports they use: any number of servers per mode, each
// with its own port, and a warm spare port for each Battle Royale server.
//
// setup-box.mjs takes the same choices as the Linux kit's RV_COUNTS / RV_PORT_BASE / RV_PORTS /
// RV_SPARE_OFFSET / RV_SPARE_PORTS:
//   --count solo=4,duos=2            servers per mode (default 1, or what the box already has)
//   --port-base 7777                 every server gets the next port, in MODES order
//   --ports solo=7777,solo-02=7790   a port per mode (its first server) or per server id
//   --spare-offset 100               a warm spare is its server's port + this
//   --spare-ports solo-02=9102       a warm spare port per mode or server id; wins over the offset
// A server is solo-01, solo-02 and so on. One not named keeps the port it already has, the first
// server of a mode the default layout, and an extra server the next free port above the others
// (with room for its spare). Every port is checked before anything is written: in range, used once.
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
export const DEFAULT_SPARE_OFFSET = 100;
export const SPARE_MODE_KEYS = ['solo', 'duos', 'trios', 'squads'];
export const MAX_SERVERS_PER_MODE = 32;

export const instanceId = (key, n) => `${key}-${String(n).padStart(2, '0')}`;

function positive(raw, what, max) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) throw new Error(`${what}: "${s}" is not a whole number.`);
    const n = Number(s);
    if (n < 1 || n > max) throw new Error(`${what}: ${s} is outside 1-${max}.`);
    return n;
}
const portNumber = (raw, what) => {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) throw new Error(`${what}: "${s}" is not a port number (${PORT_MIN}-${PORT_MAX}).`);
    const n = Number(s);
    if (n < PORT_MIN || n > PORT_MAX) throw new Error(`${what}: ${s} is outside ${PORT_MIN}-${PORT_MAX}.`);
    return n;
};

// "solo=7777,solo-02=7790" -> { solo: 7777, 'solo-02': 7790 }. allowed: the names that may appear.
// value parses one value (a port, or a count).
export function parseList(raw, what, allowed, value = portNumber) {
    const out = {};
    for (const part of String(raw ?? '').split(',')) {
        const item = part.trim();
        if (!item) continue;
        const eq = item.indexOf('=');
        if (eq <= 0) throw new Error(`${what}: "${item}" is not <name>=<value> (for example solo=7777).`);
        const key = item.slice(0, eq).trim().toLowerCase();
        if (!allowed.includes(key)) throw new Error(`${what}: unknown name "${key}" (use ${allowed.join(', ')}).`);
        if (key in out) throw new Error(`${what}: ${key} is given more than once.`);
        out[key] = value(item.slice(eq + 1), `${what} ${key}`);
    }
    if (!Object.keys(out).length) throw new Error(`${what} lists no <name>=<value> entries.`);
    return out;
}

// modes: [{ key, port }] in order, the default layout of each mode's first server.
// choice: the raw flag values (undefined when not given): counts, portBase, ports, spareOffset, sparePorts.
// current: { counts: {key: n}, ports: {id: port}, spares: {id: port}, offset, reserved: {port: name} } from
// an existing setup, or {}. reserved are ports other instances of the box use (a server the layout does
// not manage): nothing here takes them.
// Returns { servers: [{ key, id, port, sparePort }], offset, changed }. sparePort is set for the
// Battle Royale modes only; changed says whether any flag was given.
export function resolveBoxPorts(modes, choice = {}, current = {}) {
    const keys = modes.map(m => m.key);
    const given = ['counts', 'portBase', 'ports', 'spareOffset', 'sparePorts'].some(k => choice[k] !== undefined);
    const counts = choice.counts !== undefined
        ? parseList(choice.counts, '--count', keys, (v, what) => positive(v, what, MAX_SERVERS_PER_MODE)) : {};
    const servers = [];
    for (const m of modes) {
        const n = counts[m.key] ?? current.counts?.[m.key] ?? 1;
        for (let i = 1; i <= n; i++) servers.push({ key: m.key, id: instanceId(m.key, i), first: i === 1, defaultPort: m.port });
    }
    const names = [...keys, ...servers.map(s => s.id)];
    // A mode name is its first server: solo and solo-01 name the same one.
    const byName = (list, what) => {
        const out = {};
        for (const [name, port] of Object.entries(list)) {
            const id = keys.includes(name) ? instanceId(name, 1) : name;
            if (id in out) throw new Error(`${what}: ${id} is given more than once.`);
            out[id] = port;
        }
        return out;
    };
    const named = choice.ports !== undefined ? byName(parseList(choice.ports, '--ports', names), '--ports') : {};
    const brNames = names.filter(n => SPARE_MODE_KEYS.includes(n.replace(/-\d+$/, '')));
    const spareNamed = choice.sparePorts !== undefined ? byName(parseList(choice.sparePorts, '--spare-ports', brNames), '--spare-ports') : {};
    for (const id of [...Object.keys(named), ...Object.keys(spareNamed)])
        if (!servers.some(s => s.id === id)) throw new Error(`${id} is not one of this box's servers (raise its --count).`);
    const base = choice.portBase !== undefined ? portNumber(choice.portBase, '--port-base') : null;
    if (base !== null && base + servers.length - 1 > PORT_MAX)
        throw new Error(`--port-base: ${base} leaves no room for ${servers.length} servers below ${PORT_MAX}.`);
    const offset = choice.spareOffset !== undefined ? portNumber(choice.spareOffset, '--spare-offset')
        : Number.isInteger(current.offset) && current.offset > 0 ? current.offset : DEFAULT_SPARE_OFFSET;

    // Mains first: named, then the base, then what the server had, then the default layout.
    servers.forEach((s, i) => {
        s.port = named[s.id] ?? (base !== null ? base + i : current.ports?.[s.id] ?? (s.first ? s.defaultPort : undefined));
    });
    const hasSpare = s => SPARE_MODE_KEYS.includes(s.key);
    const spareFor = s => {
        // A spare follows its server unless it was named: a moved server takes its spare along at the
        // same distance, and a new --spare-offset places every spare that was not named.
        if (spareNamed[s.id] !== undefined) return spareNamed[s.id];
        const kept = current.spares?.[s.id], was = current.ports?.[s.id];
        if (choice.spareOffset === undefined && kept !== undefined && was !== undefined) return s.port + (kept - was);
        return s.port + offset;
    };
    const reserved = Object.entries(current.reserved || {}).map(([port, name]) => [Number(port), name]);
    const taken = new Set(reserved.map(([port]) => port));
    for (const s of servers) if (s.port !== undefined) {
        taken.add(s.port);
        if (hasSpare(s)) taken.add(spareFor(s));
    }
    // An extra server with no port yet: the next free port above every main port, whose spare
    // port is free as well.
    let next = Math.max(...servers.filter(s => s.port !== undefined).map(s => s.port), modes[modes.length - 1].port);
    for (const s of servers) {
        if (s.port !== undefined) continue;
        do next++; while (next <= PORT_MAX && (taken.has(next) || (hasSpare(s) && taken.has(next + offset))));
        s.port = next;
        taken.add(s.port);
        if (hasSpare(s)) taken.add(spareFor(s));
    }
    for (const s of servers) if (hasSpare(s)) s.sparePort = spareFor(s);

    const use = new Map(reserved);
    const claim = (port, what) => {
        if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX)
            throw new Error(`${what} would use UDP ${port}, outside ${PORT_MIN}-${PORT_MAX}.`);
        if (use.has(port)) throw new Error(`${what} would use UDP ${port}, already used by ${use.get(port)}.`);
        use.set(port, what);
    };
    for (const s of servers) claim(s.port, s.id);
    for (const s of servers) if (s.sparePort !== undefined) claim(s.sparePort, `${s.id} (warm spare)`);
    return {
        servers: servers.map(({ key, id, port, sparePort }) => ({ key, id, port, ...(sparePort !== undefined ? { sparePort } : {}) })),
        offset, changed: given,
    };
}
