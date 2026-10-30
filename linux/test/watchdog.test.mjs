// Game server watchdog: boot freeze/stall, and the running-phase engine-thread check.
// Run: node --test linux/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchGameServer } from '../rootfs/opt/rv/watchdog.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
const fakeChild = (pid = 4242) => Object.assign(new EventEmitter(), { pid });
const tempDir = t => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-watchdog-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const exeIn = dir => join(dir, 'RumbleverseClient-Win64-Shipping.exe');
const traceIn = dir => join(dir, 'crash_trace_solo-01.log');
const args = ['-RVInstance=solo-01'];
// 10 s per call, so a 150 s threshold is reached in 15 timer ticks.
const clock = step => { let t = 0; return () => (t += step); };

test('ends a start that stops making progress', async t => {
    const dir = tempDir(t), child = fakeChild(), killed = [], logs = [];
    writeFileSync(traceIn(dir), 'booting\n');
    const timer = watchGameServer(exeIn(dir), args, child, {
        env: {}, every: 1, now: clock(10000), state: () => 'S', cpu: () => 1,
        kill: (pid, signal) => killed.push([pid, signal]), log: msg => logs.push(msg),
    });
    t.after(() => clearInterval(timer));
    await wait(60);
    assert.deepEqual(killed, [[child.pid, 'SIGKILL']]);
    assert.match(logs.join('\n'), /no progress in its trace/);
});

test('leaves a joinable server alone while its game thread uses CPU', async t => {
    const dir = tempDir(t), child = fakeChild(), killed = [];
    writeFileSync(traceIn(dir), 'starting\n');
    const timer = watchGameServer(exeIn(dir), args, child, {
        env: {}, every: 1, now: clock(10000), state: () => 'S',
        cpu: (() => { let n = 1000; return () => (n += 50); })(),
        kill: (pid, signal) => killed.push([pid, signal]), log: () => {},
    });
    t.after(() => clearInterval(timer));
    appendFileSync(traceIn(dir), '[LISTEN] reporting joinable to the backend\n');
    await wait(60);   // 60 ticks = 600 s of server time
    assert.deepEqual(killed, []);
});

test('ends a server whose game thread stops after it was joinable', async t => {
    const dir = tempDir(t), child = fakeChild(), killed = [], logs = [];
    writeFileSync(traceIn(dir), 'starting\n');
    const timer = watchGameServer(exeIn(dir), args, child, {
        env: {}, every: 1, now: clock(10000), state: () => 'S', cpu: () => 777,
        kill: (pid, signal) => killed.push([pid, signal]), log: msg => logs.push(msg),
    });
    t.after(() => clearInterval(timer));
    appendFileSync(traceIn(dir), '[LISTEN] reporting joinable to the backend\n');
    await wait(60);
    assert.deepEqual(killed, [[child.pid, 'SIGKILL']]);
    assert.match(logs.join('\n'), /game thread has used no CPU/);
});

test('ends a server that is stopped after it was joinable', async t => {
    const dir = tempDir(t), child = fakeChild(), killed = [], logs = [];
    writeFileSync(traceIn(dir), 'starting\n');
    const timer = watchGameServer(exeIn(dir), args, child, {
        env: {}, every: 1, now: clock(10000), state: () => 'T',
        cpu: (() => { let n = 1000; return () => (n += 50); })(),
        kill: (pid, signal) => killed.push([pid, signal]), log: msg => logs.push(msg),
    });
    t.after(() => clearInterval(timer));
    appendFileSync(traceIn(dir), '[LISTEN] reporting joinable to the backend\n');
    await wait(60);
    assert.deepEqual(killed, [[child.pid, 'SIGKILL']]);
    assert.match(logs.join('\n'), /process stopped \(frozen\)/);
});

test('RV_RUN_STALL_SEC=0 turns off only the running check', async t => {
    const dir = tempDir(t), child = fakeChild(), killed = [];
    writeFileSync(traceIn(dir), 'starting\n');
    const timer = watchGameServer(exeIn(dir), args, child, {
        env: { RV_RUN_STALL_SEC: '0' }, every: 1, now: clock(10000), state: () => 'S', cpu: () => 777,
        kill: (pid, signal) => killed.push([pid, signal]), log: () => {},
    });
    t.after(() => clearInterval(timer));
    appendFileSync(traceIn(dir), '[LISTEN] reporting joinable to the backend\n');
    await wait(60);
    assert.deepEqual(killed, []);
});
