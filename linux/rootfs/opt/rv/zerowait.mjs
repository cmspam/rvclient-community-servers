// Zero Wait method: how a mode keeps its next match ready.
//
//   pairs  the old way: two game servers of the mode on the mode's own port, one connected at a
//          time; this container forwards the port and switches it after the round's match reports
//          are uploaded (pairs.mjs). Needs NET_ADMIN, SYS_ADMIN, IP forwarding and a default route.
//   spare  the server kit's warm spare: a second server on the mode's spare port (by default the
//          mode's port + 100), both registered with the backend, and matchmaking sends players to
//          the one in its lobby (warmspare.mjs).
//
// One method for the whole server. The requested method is the owner's setting (web page,
// `rv swap method`, or RV_ZEROWAIT on a server's first start). The applied plan is written to
// state when the servers start: the web page and CLI read that, not a fresh probe, because a kit
// update replaces ds-supervisor.js while the old supervisor and the pairs controller still run.
import { readState, updateState } from './lib.mjs';
import { kitHasWarmSpare } from './warmspare.mjs';
import { pairsAvailable } from './pairs.mjs';

export const METHODS = ['pairs', 'spare'];
export const DEFAULT_METHOD = 'pairs';
export const KINDS = ['pairs', 'spare', 'none'];

export const methodLabel = m => m === 'spare' ? 'warm spare (two ports, the backend chooses)'
    : m === 'pairs' ? 'server pairs (one port, this container switches)' : String(m || '');
export const kindLabel = k => k === 'spare' ? 'warm spare' : k === 'pairs' ? 'server pairs'
    : k === 'none' ? 'single servers (no Zero Wait)' : String(k || '');

export function normalizeMethod(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return METHODS.includes(s) ? s : '';
}

// The owner's choice. The environment seeds a first start; once a method is chosen on the web page
// or with `rv swap method`, the state wins.
export function requestedMethod() {
    const v = normalizeMethod(readState().zeroWaitMethod) || normalizeMethod(process.env.RV_ZEROWAIT) || DEFAULT_METHOD;
    return v;
}

// The fallback rules, kept pure so they can be tested without a game server.
//   explicit or default pairs, rights missing -> warm spares, with a warning
//   pairs unavailable and no kit spare       -> single servers, with a warning
//   spare asked for, old kit                 -> pairs, with a warning (the old behavior)
export function decide({ requested, kitHasSpare, pairsOk, pairsReason }) {
    if (requested === 'pairs') {
        if (pairsOk) return { kind: 'pairs', reason: '', warned: '' };
        if (kitHasSpare) return { kind: 'spare', reason: pairsReason,
            warned: `Server pairs cannot run here: ${pairsReason}. Zero Wait uses the server kit's warm spare instead.` };
        return { kind: 'none', reason: `Server pairs cannot run here: ${pairsReason}, and the server kit has no warm spare.`,
            warned: `Server pairs cannot run here: ${pairsReason}, and the server kit has no warm spare, so Zero Wait is off (single servers).` };
    }
    // requested === 'spare'
    if (kitHasSpare) return { kind: 'spare', reason: '', warned: '' };
    if (pairsOk) return { kind: 'pairs', reason: 'The server kit has no warm spare (before 2026.10.10.1).',
        warned: 'The server kit has no warm spare (before 2026.10.10.1). Zero Wait runs as server pairs.' };
    return { kind: 'none', reason: `The server kit has no warm spare (before 2026.10.10.1), and server pairs cannot run here: ${pairsReason}.`,
        warned: `The server kit has no warm spare and server pairs cannot run here: ${pairsReason}. Zero Wait is off (single servers).` };
}

// The rights do not change while the container runs; the web page asks for status every few
// seconds, so the probe is cached.
let probed = { at: 0, value: null };
export function pairsProbe(maxAgeMs = 30000) {
    if (probed.value && Date.now() - probed.at < maxAgeMs) return probed.value;
    probed = { at: Date.now(), value: pairsAvailable() };
    return probed.value;
}

// What would run if the servers started now.
export function plan() {
    const requested = requestedMethod();
    const kitHasSpare = kitHasWarmSpare();
    let pairsOk = true, pairsReason = '';
    if (!(requested === 'spare' && kitHasSpare)) {
        const p = pairsProbe();
        pairsOk = p.ok; pairsReason = p.reason;
    }
    return { requested, kitHasSpare, ...decide({ requested, kitHasSpare, pairsOk, pairsReason }) };
}

// The plan that is running (written when the servers started). Without one (not started yet, or
// upgrading), the current plan is shown and marked not started.
export function activePlan() {
    const a = readState().zeroWaitActive;
    if (a && KINDS.includes(a.kind)) return { started: true, ...a, pending: requestedMethod() !== a.requested };
    const p = plan();
    return { started: false, kind: p.kind, requested: p.requested, reason: p.reason, warned: p.warned, pending: false };
}

export function activeKind() {
    const a = readState().zeroWaitActive;
    return a && KINDS.includes(a.kind) ? a.kind : null;
}

export function recordActive({ kind, requested, reason = '', warned = '' }) {
    const rec = { kind, requested, reason, warned, at: new Date().toISOString() };
    updateState({ zeroWaitActive: rec });
    return rec;
}

// Set from the web page or through the main process (rv swap method). The watcher in rv.mjs
// applies it when every server is empty.
export function setMethod(v) {
    const m = normalizeMethod(v);
    if (!m) throw new Error('usage: rv swap method pairs|spare');
    updateState({ zeroWaitMethod: m });
    const a = readState().zeroWaitActive;
    const pending = a && a.kind && (a.requested !== m || a.kind === 'none' && m !== 'none');
    const same = a && a.kind && a.requested === m && a.kind !== 'none';
    return `Zero Wait method: ${m}, ${methodLabel(m)}.${same ? ' It is already the method in use.'
        : pending ? ' It applies when every server is empty (at most 30 minutes).' : ''}`;
}
