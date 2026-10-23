// Game port resolver and the RV_PORT_BASE / RV_PORTS override.
// Run: node --test linux/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MODES, SPARE_MODE_KEYS, modeByKey, modeInstance, modePort, spareInstance, spareOffset, sparePort,
    modePorts, sparePorts, parsePortOverride, resolvePorts, rewritePorts, applyPortOverride,
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

test('the override is unset without either variable', () => {
    assert.equal(parsePortOverride({}), null);
    assert.equal(parsePortOverride({ RV_PORT_BASE: '', RV_PORTS: '  ' }), null);
});

test('RV_PORT_BASE and RV_PORTS are parsed', () => {
    const base = parsePortOverride({ RV_PORT_BASE: '8000' });
    assert.equal(base.base, 8000);
    assert.equal(Object.keys(base.ports).length, 0);
    const ports = parsePortOverride({ RV_PORTS: 'solo=8000, duos-01=8001' });
    assert.equal(ports.base, null);
    assert.equal(ports.ports.solo, 8000);
    assert.equal(ports.ports.duos, 8001);
    const both = parsePortOverride({ RV_PORT_BASE: '9000', RV_PORTS: 'solo=8000' });
    assert.equal(both.base, 9000);
    assert.equal(both.ports.solo, 8000);
});

test('bad overrides are refused before anything is written', () => {
    assert.throws(() => parsePortOverride({ RV_PORTS: 'solo' }), /is not <mode>=<port>/);
    assert.throws(() => parsePortOverride({ RV_PORTS: 'solo=' }), /not a port number/);
    assert.throws(() => parsePortOverride({ RV_PORTS: 'nope=8000' }), /unknown mode/);
    assert.throws(() => parsePortOverride({ RV_PORTS: 'solo=8000,solo-01=8001' }), /more than once/);
    assert.throws(() => parsePortOverride({ RV_PORTS: 'solo=8000,duos=8000' }), /used for both/);
    assert.throws(() => parsePortOverride({ RV_PORTS: ',,,' }), /lists no/);
    assert.throws(() => parsePortOverride({ RV_PORTS: 'solo=0' }), /outside 1-65535/);
    assert.throws(() => parsePortOverride({ RV_PORTS: 'solo=65536' }), /outside 1-65535/);
    assert.throws(() => parsePortOverride({ RV_PORT_BASE: 'abc' }), /not a port number/);
    assert.throws(() => parsePortOverride({ RV_PORT_BASE: '65533' }), /leaves no room/);
});

test('a base gives the modes consecutive ports and derives the spares', () => {
    const r = resolvePorts(parsePortOverride({ RV_PORT_BASE: '7800' }), null);
    assert.deepEqual(r.ports, { solo: 7800, playground: 7801, duos: 7802, trios: 7803, squads: 7804 });
    assert.deepEqual(r.spares, { solo: 7900, duos: 7902, trios: 7903, squads: 7904 });
    assert.equal(r.spares.playground, undefined);
    assert.deepEqual(r.offsets, { solo: 100, duos: 100, trios: 100, squads: 100 });
});

test('RV_PORTS wins over the base for the mode it names', () => {
    const r = resolvePorts(parsePortOverride({ RV_PORTS: 'solo=9000' }), null);
    assert.equal(r.ports.solo, 9000);
    assert.equal(r.ports.duos, 7779);
    assert.equal(r.spares.solo, 9100);
    assert.equal(r.spares.duos, 7879);
});

test('a spare keeps the offset the file gives it', () => {
    const inst = file([
        { id: 'solo-01', port: 7777 },
        { id: 'solo-01-spare', port: 7950, spareOf: 'solo-01' },
    ]);
    const r = resolvePorts(parsePortOverride({ RV_PORT_BASE: '8000' }), inst);
    assert.equal(r.ports.solo, 8000);
    assert.equal(r.spares.solo, 8173);
    assert.equal(r.offsets.solo, 173);
    const off = resolvePorts(parsePortOverride({ RV_PORTS: 'solo=9000' }), file([
        { id: 'solo-01', port: 7777 },
    ], { warmSparePortOffset: 250 }));
    assert.equal(off.spares.solo, 9250);
});

test('a repeated or out of range port is refused', () => {
    assert.throws(() => resolvePorts({ base: null, ports: { solo: 7778, playground: 7778 } }, null), /already used by/);
    assert.throws(() => resolvePorts(parsePortOverride({ RV_PORTS: 'solo=7800,duos=7900' }), null),
        /already used by duos \(main\)/);
    assert.throws(() => resolvePorts(parsePortOverride({ RV_PORT_BASE: '65433' }), null), /outside 1-65535/);
    assert.throws(() => resolvePorts(parsePortOverride({ RV_PORT_BASE: '7800' }), file([
        { id: 'solo-01', port: 7777 },
        { id: 'event-01', port: 7800 },
    ])), /event-01 in ds-instances.json/);
    assert.throws(() => resolvePorts(parsePortOverride({ RV_PORT_BASE: '7800' }), file([
        { id: 'solo-01', port: 7777 },
    ], { _moreModesLater: [{ id: 'event-01', port: 7801 }] })), /event-01 in ds-instances.json/);
});

test('the rewrite changes the mode entries and the spare entries the file has', () => {
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
    assert.equal(r.next.instances.length, inst.instances.length, 'no spare entry is invented');
    assert.equal(r.next.instances.find(i => i.id === 'event-01').config, undefined);
    assert.deepEqual(r.changes.map(c => `${c.id}:${c.kind}`).sort(), ['duos-01:main', 'solo-01-spare:spare', 'solo-01:main']);
});

test('rewriting reports nothing when the file already has the ports', () => {
    const inst = five();
    const r = resolvePorts(parsePortOverride({ RV_PORT_BASE: '7777' }), inst);
    assert.deepEqual(rewritePorts(inst, r).changes, []);
});

test('applyPortOverride leaves the ports alone when no override is set', () => {
    assert.equal(applyPortOverride(five(), {}), null);
});

test('an override over an unknown mode entry falls back for the rest', () => {
    const inst = file([{ id: 'solo-01', port: 7777 }]);
    const r = applyPortOverride(inst, { RV_PORTS: 'solo=8000' });
    assert.equal(r.ports.solo, 8000);
    assert.equal(r.ports.playground, 7778);
    assert.equal(r.spares.playground, undefined);
    assert.equal(r.changes.length, 1);
});
