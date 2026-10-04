// Admin login for the web UI.
//
// A random password is created on first start and printed to the container log. The first login
// with it must set a new one. Passwords are stored only as scrypt hashes in /data/state/webui.json.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { AUTH_FILE, readJson, writeJson, ensureDirs } from '../lib.mjs';

const SESSION_HOURS = 12;
const sessions = new Map();     // token -> { expires }
const attempts = new Map();     // ip -> [timestamps]

function hash(password, salt = randomBytes(16).toString('hex')) {
    return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

// Easy to type from a log: no 0/O/1/l/I.
function randomPassword(len = 16) {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = randomBytes(len);
    return [...b].map(x => chars[x % chars.length]).join('');
}

function banner(password, why) {
    const lines = [
        '',
        '================================================================',
        `  Rumbleverse server admin password (${why}):`,
        '',
        `      ${password}`,
        '',
        '  Open the web UI (port 8080 by default) and log in with it.',
        '  You will be asked to choose your own password right away.',
        '================================================================',
        '',
    ];
    console.log(lines.join('\n'));
}

export function ensureAuth() {
    ensureDirs();
    if (existsSync(AUTH_FILE) && readJson(AUTH_FILE)?.hash) return;
    resetPassword('first start');
}

export function resetPassword(why = 'reset') {
    const password = randomPassword();
    writeJson(AUTH_FILE, { ...hash(password), mustChange: true, createdAt: new Date().toISOString() });
    sessions.clear();
    banner(password, why);
    return password;
}

export function checkPassword(password) {
    const a = readJson(AUTH_FILE);
    if (!a?.hash || typeof password !== 'string') return false;
    const got = scryptSync(password, a.salt, 64);
    const want = Buffer.from(a.hash, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
}

export function setPassword(password) {
    writeJson(AUTH_FILE, { ...hash(password), mustChange: false, changedAt: new Date().toISOString() });
}

export const mustChange = () => !!readJson(AUTH_FILE)?.mustChange;

// 10 failed tries per address per 10 minutes.
export function rateLimited(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    attempts.set(ip, list);
    return list.length >= 10;
}
export function noteFailure(ip) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); }

export function createSession() {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + SESSION_HOURS * 3600 * 1000, created: Date.now() });
    return token;
}
export function validSession(token) {
    const s = token && sessions.get(token);
    if (!s) return false;
    if (s.expires < Date.now()) { sessions.delete(token); return false; }
    // A password reset from another process (rv reset-password) ends older sessions too.
    try { if (statSync(AUTH_FILE).mtimeMs > s.created + 1000) { sessions.delete(token); return false; } } catch { return false; }
    return true;
}
export function endSession(token) { sessions.delete(token); }
export function endAllSessions() { sessions.clear(); }
