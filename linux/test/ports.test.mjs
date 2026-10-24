// Game port resolver and the RV_COUNTS / RV_PORT_BASE / RV_PORTS / RV_SPARE_OFFSET / RV_SPARE_PORTS override.
// Run: node --test linux/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MODES, SPARE_MODE_KEYS, modeByKey, modeInstance, modePort, spareInstance, spareOffset, sparePort,
    modePorts, sparePorts, parsePortOverride, resolvePorts, rewritePorts, applyPortOverride,
    serverPorts, serverCount, serverTarget,
} from '../rootfs/opt/rv/lib.mjs';

const file = (instances, extra = {}) => ({ instances, ...extra });
const five = () => file([
    { id: 'solo-01', port: 7777, gameMode: 1, config: 'Config.solo.ini' },
    { id: 'playground-01', port: 7778, gameMode: 0, config: 'Config.playground.ini' },
    { id: 'duos-01', port: 7779, gameMode: 2, config: 'Config.duos.ini' },
    { id: 'trios-01', port: 7780, gameMode: 3, config: 'Config.trios.ini' },
    { id: 'squads-01', port: 7781, gameMode: 4, config: 'Config.squads.ini' },
]);
const portOf = (obj, id) => obj.instances.find(i => i.id === id)?.port;

test('mode defaults stand in for a missing file or entry', () => {
    assert.equal(modePort('solo', null), 7777);
    assert.equal(modePort(MODES[3], null), 7780);
    assert.equal(modePort('solo', file([])), 7777);
    assert.equal(modePort('solo', file([{ id: 'solo-01', port: '7777' }])), 7777);
    assert.equal(modePort('solo', file([{ id: 'solo-01' }])), 7777);
    assert.deepEqual(modePorts(null), { solo: 7777, playground: 7778, duos: 7779, trios: 7780, squads: 7781 });
});

test('the file is read by instance id or by a mode field', () => {
    const byId = file([{ id: 'solo-01', port: 9001 }]);
    assert.equal(modePort('solo', byId), 9001);
    const byMode = file([{ id: 'another-id', mode: 'duos', port: 9002 }]);
    assert.equal(modePort('duos', byMode), 9002);
    assert.equal(modeInstance('duos', byMode).id, 'another-id');
    assert.equal(modeByKey('solo-01').key, 'solo');
    assert.equal(modeByKey('nope'), null);
    assert.throws(() => modePort('nope', byId), /Unknown mode/);
});

test('a warm spare is the file entry, the file offset, or port + 100', () => {
    assert.equal(sparePort('solo', null), 7877);
    assert.equal(spareOffset('solo', null), 100);
    assert.equal(sparePort('solo', file([{ id: 'solo-01', port: 7777 }], { warmSparePortOffset: 250 })), 8027);
    assert.equal(sparePort('solo', file([{ id: 'solo-01', port: 7777 }], { warmSparePortOffset: '250' })), 7877);
    const explicit = file([
        { id: 'solo-01', port: 7777 },
        { id: 'solo-01-spare', port: 7900, spareOf: 'solo-01' },
    ]);
    assert.equal(spareInstance('solo', explicit).id, 'solo-01-spare');
    assert.equal(spareOffset('solo', explicit), 123);
    assert.equal(sparePort('solo', explicit), 7900);
    assert.equal(sparePort('solo', file([
        { id: 'solo-01', port: 7777 },
        { id: 'sp-1', port: 8000, spareOf: 'solo-01' },
    ])), 8000);
    assert.deepEqual(sparePorts(null), { solo: 7877, duos: 7879, trios: 7880, squads: 7881 });
    assert.deepEqual(SPARE_MODE_KEYS, ['solo', 'duos', 'trios', 'squads']);
});

test('the override is unset without any variable', () => {
    assert.equal(parsePortOverride({}), null);
    assert.equal(parsePortOverride({ RV_PORT_BASE: '', RV_PORTS: '  ' }), null);
    assert.deepEqual(parsePortOverride({ RV_COUNTS: 'solo=2' }).counts, 'solo=2');
});

const ids = r => Object.fromEntries(r.servers.map(x => [x.id, x.port]));
const spareIds = r => Object.fromEntries(r.servers.filter(x => x.sparePort !== undefined).map(x => [x.id, x.sparePort]));
const resolve = (env, inst = null) => resolvePorts(parsePortOverride(env), inst);

test('RV_PORT_BASE and RV_PORTS: per mode, per server id, the named one wins', () => {
    assert.deepEqual(resolve({ RV_PORTS: 'solo=8000, duos-01=8001' }).ports,
        { solo: 8000, playground: 7778, duos: 8001, trios: 7780, squads: 7781 });
    const both = resolve({ RV_PORT_BASE: '9000', RV_PORTS: 'solo=8000' });
    assert.equal(both.ports.solo, 8000);
    assert.equal(both.ports.duos, 9002);
});

test('bad overrides are refused before anything is written', () => {
    assert.throws(() => resolve({ RV_PORTS: 'solo' }), /is not <name>=<value>/);
    assert.throws(() => resolve({ RV_PORTS: 'solo=' }), /not a port number/);
    assert.throws(() => resolve({ RV_PORTS: 'nope=8000' }), /unknown name/);
    assert.throws(() => resolve({ RV_PORTS: 'solo=8000,solo-01=8001' }), /more than once/);
    assert.throws(() => resolve({ RV_PORTS: 'solo=8000,duos=8000' }), /already used by/);
    assert.throws(() => resolve({ RV_PORTS: ',,,' }), /lists no/);
    assert.throws(() => resolve({ RV_PORTS: 'solo=0' }), /outside 1-65535/);
    assert.throws(() => resolve({ RV_PORTS: 'solo=65536' }), /outside 1-65535/);
    assert.throws(() => resolve({ RV_PORT_BASE: 'abc' }), /not a port number/);
    assert.throws(() => resolve({ RV_PORT_BASE: '65533' }), /no room/);
    assert.throws(() => resolve({ RV_COUNTS: 'solo=0' }), /outside 1-/);
    assert.throws(() => resolve({ RV_SPARE_PORTS: 'playground=9000' }), /unknown name/);
});

test('a base gives the servers consecutive ports and derives the spares', () => {
    const r = resolve({ RV_PORT_BASE: '7800' });
    assert.deepEqual(r.ports, { solo: 7800, playground: 7801, duos: 7802, trios: 7803, squads: 7804 });
    assert.deepEqual(r.spares, { solo: 7900, duos: 7902, trios: 7903, squads: 7904 });
    assert.equal(r.spares.playground, undefined);
});

test('RV_SPARE_OFFSET and RV_SPARE_PORTS place the warm spares', () => {
    const r = resolve({ RV_SPARE_OFFSET: '50', RV_SPARE_PORTS: 'duos=9100' });
    assert.deepEqual(r.spares, { solo: 7827, duos: 9100, trios: 7830, squads: 7831 });
    assert.throws(() => resolve({ RV_SPARE_PORTS: 'solo=7778' }), /already used by/);
});

test('RV_COUNTS runs several servers of a mode, each with its own port and spare', () => {
    const r = resolve({ RV_COUNTS: 'solo=4' }, five());
    assert.deepEqual(Object.keys(ids(r)).filter(id => id.startsWith('solo')), ['solo-01', 'solo-02', 'solo-03', 'solo-04']);
    assert.deepEqual([ids(r)['solo-02'], spareIds(r)['solo-02']], [7782, 7882]);
    const out = applyPortOverride(five(), { RV_COUNTS: 'solo=3', RV_PORTS: 'solo-03=9000' });
    const solo3 = out.next.instances.find(i => i.id === 'solo-03');
    assert.deepEqual([solo3.port, solo3.gameMode, solo3.config], [9000, 1, 'Config.solo.ini'], 'a copy of the mode\'s first server');
    assert.deepEqual(out.changes.filter(c => c.kind === 'added').map(c => c.id), ['solo-02', 'solo-03']);
    // A lower count removes the extra servers and their spare entries.
    const three = out.next;
    three.instances.push({ id: 'solo-03-spare', port: 9100, spareOf: 'solo-03' });
    const back = applyPortOverride(three, { RV_COUNTS: 'solo=1' });
    assert.deepEqual(back.next.instances.map(i => i.id).filter(id => id.startsWith('solo')), ['solo-01']);
    assert.deepEqual(back.changes.map(c => `${c.id}:${c.kind}`).sort(), ['solo-02:removed', 'solo-03-spare:removed', 'solo-03:removed']);
});

test('a moved server keeps its spare at the distance the file gives it', () => {
    const inst = file([
        { id: 'solo-01', port: 7777 },
        { id: 'solo-01-spare', port: 7950, spareOf: 'solo-01' },
    ]);
    const r = resolve({ RV_PORT_BASE: '8000' }, inst);
    assert.equal(r.ports.solo, 8000);
    assert.equal(r.spares.solo, 8173);
    const off = resolve({ RV_PORTS: 'solo=9000' }, file([{ id: 'solo-01', port: 7777 }], { warmSparePortOffset: 250 }));
    assert.equal(off.spares.solo, 9250);
});

test('ports of other instances in the file are left to them', () => {
    assert.throws(() => resolve({ RV_PORT_BASE: '7800' }, file([
        { id: 'solo-01', port: 7777 },
        { id: 'event-01', port: 7800 },
    ])), /already used by event-01/);
    assert.throws(() => resolve({ RV_PORT_BASE: '7800' }, file([
        { id: 'solo-01', port: 7777 },
    ], { _moreModesLater: [{ id: 'event-01', port: 7801 }] })), /already used by event-01/);
    const r = resolve({ RV_COUNTS: 'solo=2' }, file([...five().instances, { id: 'event-01', port: 7782 }]));
    assert.equal(ids(r)['solo-02'], 7783, 'an extra server skips a port another instance uses');
});

test('the rewrite changes the server entries and the spare entries the file has', () => {
    const inst = file([
        { id: 'solo-01', port: 7777, config: 'Config.solo.ini' },
        { id: 'solo-01-spare', port: 7950, spareOf: 'solo-01', config: 'Config.solo.ini' },
        { id: 'duos-01', port: 7779, config: 'Config.duos.ini' },
        { id: 'event-01', port: 9000 },
    ]);
    const before = JSON.stringify(inst);
    const r = applyPortOverride(inst, { RV_PORT_BASE: '8000' });
    assert.equal(JSON.stringify(inst), before, 'the input object is left as it was');
    assert.equal(portOf(r.next, 'solo-01'), 8000);
    assert.equal(portOf(r.next, 'solo-01-spare'), 8173);
    assert.equal(portOf(r.next, 'duos-01'), 8002);
    assert.equal(portOf(r.next, 'event-01'), 9000);
    assert.equal(r.next.instances.length, inst.instances.length, 'no spare entry and no mode is invented');
    assert.equal(r.next.instances.find(i => i.id === 'event-01').config, undefined);
    assert.deepEqual(r.changes.map(c => `${c.id}:${c.kind}`).sort(), ['duos-01:main', 'solo-01-spare:spare', 'solo-01:main']);
});

test('a parked mode keeps its servers parked', () => {
    const inst = file([{ id: 'solo-01', port: 7777, gameMode: 1, config: 'Config.solo.ini' }],
        { _moreModesLater: [{ id: 'duos-01', port: 7779, gameMode: 2, config: 'Config.duos.ini' }] });
    const r = applyPortOverride(inst, { RV_COUNTS: 'duos=2' });
    assert.deepEqual(r.next._moreModesLater.map(i => i.id), ['duos-01', 'duos-02']);
    assert.deepEqual(r.next.instances.map(i => i.id), ['solo-01']);
});

test('rewriting reports nothing when the file already has the ports', () => {
    const inst = five();
    const r = resolvePorts(parsePortOverride({ RV_PORT_BASE: '7777' }), inst);
    assert.deepEqual(rewritePorts(inst, r).changes, []);
});

test('applyPortOverride leaves the ports alone when no override is set', () => {
    assert.equal(applyPortOverride(five(), {}), null);
});

test('an override over a file that runs one mode leaves the other modes out', () => {
    const inst = file([{ id: 'solo-01', port: 7777 }]);
    const r = applyPortOverride(inst, { RV_PORTS: 'solo=8000' });
    assert.equal(r.ports.solo, 8000);
    assert.equal(r.ports.playground, 7778);
    assert.equal(r.spares.playground, undefined);
    assert.equal(r.changes.length, 1);
    assert.deepEqual(r.next.instances.map(i => i.id), ['solo-01']);
});

test('serverPorts lists every server of the file with its spare port', () => {
    const inst = file([...five().instances, { id: 'solo-02', port: 7790, gameMode: 1, sparePort: 9190 }]);
    const list = serverPorts(inst);
    assert.deepEqual(list.filter(x => x.key === 'solo'), [
        { id: 'solo-01', key: 'solo', port: 7777, sparePort: 7877 },
        { id: 'solo-02', key: 'solo', port: 7790, sparePort: 9190 },
    ]);
    assert.equal(list.find(x => x.key === 'playground').sparePort, undefined);
    assert.equal(serverCount('solo', inst), 2);
    assert.deepEqual(serverTarget('solo', inst).ids, ['solo-01', 'solo-02']);
    assert.deepEqual(serverTarget('solo-02', inst).ids, ['solo-02']);
});
