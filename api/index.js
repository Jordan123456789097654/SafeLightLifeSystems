// SafeLight Central Station API  (served at /api and /api/v1)
// Storage: Upstash Redis REST if configured (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN), else memory.

const crypto = require('crypto');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'JordanDanielsGames').toLowerCase();
const SESSION_DAYS = 30;
const ONLINE_MS = 30000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TS_WINDOW_MS = 120000;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const STATE_KEY = 'safelight:state:v2';
const API_VERSION = 'v1';

let state = { users: {}, sessions: {}, facilities: {}, systems: {}, logs: [], commands: [] };
let lastSave = 0;
const buckets = new Map();   // rate limiting
const nonces = new Map();    // replay protection

function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n++;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    return { ok: b.n <= limit, retry: Math.ceil((b.reset - now) / 1000) };
}
function seenNonce(key, nonce) {
    const now = Date.now();
    for (const [k, t] of nonces) if (t < now) nonces.delete(k);
    const id = key + ':' + nonce;
    if (nonces.has(id)) return true;
    nonces.set(id, now + TS_WINDOW_MS * 2);
    return false;
}

const POSTGRES_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
let neonSql = null;
if (POSTGRES_URL) {
    try {
        const { neon } = require('@neondatabase/serverless');
        neonSql = neon(POSTGRES_URL);
    } catch (e) {
        console.error('neon init failed', e.message);
    }
}

async function redis(cmd) {
    const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
}
async function load() {
    if (neonSql) {
        try {
            await neonSql`CREATE TABLE IF NOT EXISTS safelight_state (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`;
            const rows = await neonSql`SELECT data FROM safelight_state WHERE id = ${STATE_KEY}`;
            if (rows.length && rows[0].data) state = rows[0].data;
            return;
        } catch (e) {
            console.error('postgres load failed', e.message);
        }
    }
    if (!REDIS_URL) return;
    try { const raw = await redis(['GET', STATE_KEY]); if (raw) state = JSON.parse(raw); } catch (e) { console.error('load failed', e.message); }
}
async function save(force) {
    if (!neonSql && !REDIS_URL) return;
    if (!force && Date.now() - lastSave < 15000) return;
    lastSave = Date.now();
    if (neonSql) {
        try {
            await neonSql`INSERT INTO safelight_state (id, data, updated_at) VALUES (${STATE_KEY}, ${state}, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`;
            return;
        } catch (e) {
            console.error('postgres save failed', e.message);
        }
    }
    if (!REDIS_URL) return;
    try { await redis(['SET', STATE_KEY, JSON.stringify(state)]); } catch (e) { console.error('save failed', e.message); }
}

const rid = (n) => crypto.randomBytes(n).toString('hex').toUpperCase();
const digits = () => String(Math.floor(100000 + Math.random() * 900000));
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

const SESSION_SECRET = process.env.SESSION_SECRET || 'safelight_master_jwt_secret_f839a0bc42e9';

function signSession(username, isAdminUser, maxAgeDays = SESSION_DAYS) {
    const payload = {
        u: username,
        adm: !!isAdminUser,
        exp: Date.now() + maxAgeDays * 864e5,
        iat: Date.now()
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
}

function verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [b64, sig] = parts;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (!safeEq(sig, expected)) return null;
    try {
        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
        if (!payload || !payload.u || !payload.exp || payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
    return out;
}
function setSession(req, res, token, maxAgeSec) {
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sl_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
function currentUser(req) {
    const cookieTok = parseCookies(req).sl_session;
    const authHeader = req.headers.authorization || '';
    const bearerTok = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const tok = cookieTok || bearerTok;
    if (!tok) return null;

    // 1. Stateless cryptographic verification (persists across cold starts and server restarts)
    const verified = verifySession(tok);
    if (verified) {
        let u = Object.values(state.users).find(x => x.username.toLowerCase() === verified.u.toLowerCase());
        if (!u) {
            u = { username: verified.u, created_at: new Date(verified.iat || Date.now()).toISOString() };
            state.users[verified.u] = u;
        }
        return u;
    }

    // 2. In-memory session fallback
    const s = state.sessions[tok];
    if (s && s.expires > Date.now()) {
        return state.users[s.username] || null;
    }
    return null;
}
const isAdmin = (u) => u && u.username.toLowerCase() === ADMIN_USERNAME;

// ---- roles: viewer < operator < manager < owner ----
const LEVEL = { viewer: 1, operator: 2, manager: 3, owner: 4 };
function roleOf(u, f) {
    if (!u || !f) return null;
    if (f.owner === u.username) return 'owner';
    const m = (f.members || {})[u.username];
    if (m) return m;
    return isAdmin(u) ? 'owner' : null;
}
const has = (u, f, min) => { const r = roleOf(u, f); return !!r && LEVEL[r] >= LEVEL[min]; };

function purgeLogs() {
    const cutoff = Date.now() - RETENTION_MS;
    state.logs = state.logs.filter(l => l.ts > cutoff).slice(0, 5000);
}
function addLog(facilityId, systemId, systemType, eventType, device, point, details, severity) {
    state.logs.unshift({ facility_id: facilityId, system_id: systemId || null, system_type: systemType, event_type: eventType, device_name: device || 'System', point_or_zone: point || '', details: details || '', severity: severity || 'INFO', ts: Date.now(), created_at: new Date().toISOString() });
    purgeLogs();
}

async function notify(f, title, desc, color) {
    if (!f.webhook) return;
    try {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
        await fetch(f.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: c.signal, body: JSON.stringify({ username: 'SafeLight Central Station', embeds: [{ title, description: desc, color, timestamp: new Date().toISOString(), footer: { text: 'SafeLight Central Station • ' + f.name } }] }) });
        clearTimeout(t);
    } catch (e) { /* ignore webhook failures */ }
}
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function publicSystem(s) {
    return { system_id: s.system_id, facility_id: s.facility_id, type: s.type, name: s.name, state: s.state || {}, blacklisted: !!s.blacklisted, last_seen: s.last_seen || null, online: !!s.last_seen && Date.now() - s.last_seen < ONLINE_MS };
}
function publicFacility(f, u) {
    const role = roleOf(u, f);
    const systems = Object.values(state.systems).filter(s => s.facility_id === f.facility_id).map(publicSystem);
    const manager = LEVEL[role] >= LEVEL.manager;
    const out = {
        facility_id: f.facility_id, name: f.name, site_id: f.site_id, owner: f.owner, my_role: role,
        blacklisted: !!f.blacklisted, blacklist_reason: f.blacklist_reason || '', created_at: f.created_at,
        systems, online: systems.some(s => s.online), member_count: Object.keys(f.members || {}).length
    };
    if (manager) { out.api_key = f.api_key; out.members = f.members || {}; out.webhook = f.webhook || ''; }
    return out;
}

const COMMANDS = { FIRE: ['FIRE_ACK', 'ALARM_SILENCE', 'SYSTEM_RESET', 'DRILL'], SECURITY: ['ARM_AWAY', 'ARM_STAY', 'DISARM', 'PANIC_POLICE'] };
const SEVERITIES = ['INFO', 'WARN', 'CRITICAL'];
const clip = (v, n) => String(v ?? '').slice(0, n);

module.exports = async (req, res) => {
    const reqId = rid(4);
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('X-SafeLight-Api', API_VERSION);
    res.setHeader('Cache-Control', 'no-store');
    const send = (code, obj) => res.status(code).json(code >= 400 ? { ...obj, requestId: reqId } : obj);
    const fail = (code, errCode, message) => send(code, { error: message, code: errCode });
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const path = url.pathname.replace(/^(\/api)?(\/v1)?(?=\/|$)/, '').replace(/\/+$/, '') || '/';
        const parts = path.split('/').filter(Boolean);
        const method = req.method;
        const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

        if (path === '/health') return send(200, { ok: true, version: API_VERSION, storage: neonSql ? 'postgres' : (REDIS_URL ? 'redis' : 'memory'), time: Date.now() });

        await load();

        // ================= DEVICE (Roblox) =================
        if (parts[0] === 'device' && method === 'POST') {
            const key = String(body.apiKey || '');
            const rl = rateLimit('dev:' + ip + ':' + key.slice(0, 12), 90, 60000);
            if (!rl.ok) { res.setHeader('Retry-After', rl.retry); return fail(429, 'RATE_LIMITED', 'Too many requests.'); }
            const ts = Number(body.ts);
            if (!ts || Math.abs(Date.now() - ts * 1000) > TS_WINDOW_MS) return fail(400, 'BAD_TIMESTAMP', 'Request timestamp missing or out of range.');
            if (!body.nonce || String(body.nonce).length < 8 || seenNonce(key.slice(0, 16), String(body.nonce))) return fail(400, 'REPLAY', 'Invalid or reused nonce.');
            const fac = key && Object.values(state.facilities).find(f => f.api_key && safeEq(f.api_key, key));
            if (!fac) return fail(403, 'BAD_KEY', 'Invalid API key.');
            const sys = state.systems[body.systemId];
            if (!sys || sys.facility_id !== fac.facility_id) return fail(403, 'BAD_SYSTEM', 'System ID does not belong to this facility.');

            if (fac.blacklisted || sys.blacklisted) {
                return send(200, { success: false, blacklisted: true, disabled: true, message: fac.blacklist_reason || 'Facility blacklisted by SafeLight Central Command', serverTime: Date.now() });
            }

            if (parts[1] === 'sync') {
                const prev = sys.state && sys.state.status;
                const st = body.state || {};
                sys.state = { status: clip(st.status || (sys.type === 'FIRE' ? 'NORMAL' : 'DISARMED'), 32), alarms: Math.max(0, Number(st.alarms) || 0), zone: Number(st.zone) || 0, acPower: st.acPower !== false };
                const wasOnline = sys.last_seen && Date.now() - sys.last_seen < ONLINE_MS;
                sys.last_seen = Date.now();
                const pending = state.commands.filter(c => c.system_id === sys.system_id && c.status === 'PENDING');
                pending.forEach(c => c.status = 'SENT');
                state.commands = state.commands.filter(c => c.status === 'PENDING' || Date.now() - c.ts < 3600000);

                const changed = prev && prev !== sys.state.status;
                if (!wasOnline) { addLog(fac.facility_id, sys.system_id, sys.type, 'ONLINE', sys.name, 'LINK', 'System connected to Central Station', 'INFO'); await notify(fac, '🟢 System online', `**${sys.name}** (${sys.system_id}) connected.`, 3066993); }
                if (changed) {
                    const s = sys.state.status;
                    const bad = /ALARM|PANIC|DURESS/.test(s), warn = /TROUBLE|SUPERVISORY/.test(s);
                    addLog(fac.facility_id, sys.system_id, sys.type, 'STATUS_CHANGE', sys.name, 'PANEL', `${prev} → ${s}`, bad ? 'CRITICAL' : warn ? 'WARN' : 'INFO');
                    if (bad || warn) await notify(fac, bad ? '🚨 ALARM' : '⚠️ TROUBLE', `**${sys.name}** (${sys.system_id}) is now **${s}**`, bad ? 15158332 : 16763904);
                    else await notify(fac, '✅ Restored', `**${sys.name}** returned to **${s}**`, 3066993);
                }
                await save(!!pending.length || !!changed || !wasOnline);
                return send(200, { success: true, blacklisted: false, commands: pending.map(c => ({ id: c.id, command: c.command })), serverTime: Date.now(), pollInterval: 3 });
            }
            if (parts[1] === 'log') {
                const sev = SEVERITIES.includes(body.severity) ? body.severity : 'INFO';
                addLog(fac.facility_id, sys.system_id, sys.type, clip(body.eventType || 'INFO', 40), clip(body.deviceName, 60), clip(body.pointOrZone, 40), clip(body.details, 300), sev);
                if (sev === 'CRITICAL') await notify(fac, `🚨 ${clip(body.eventType, 40)}`, `${clip(body.details, 300)}\n*${sys.name}*`, 15158332);
                await save(true);
                return send(200, { success: true });
            }
            return fail(404, 'NOT_FOUND', 'Unknown device route.');
        }

        // ================= AUTH =================
        if (parts[0] === 'auth') {
            if (parts[1] === 'signup' && method === 'POST') {
                const rl = rateLimit('signup:' + ip, 5, 3600000);
                if (!rl.ok) return fail(429, 'RATE_LIMITED', 'Too many signups from this network. Try later.');
                const username = String(body.username || '').trim();
                const password = String(body.password || '');
                if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail(400, 'BAD_USERNAME', 'Username must be 3-20 letters, numbers or underscores.');
                if (password.length < 8) return fail(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters.');
                if (Object.values(state.users).some(u => u.username.toLowerCase() === username.toLowerCase())) return fail(409, 'USERNAME_TAKEN', 'That username is already taken.');
                const salt = crypto.randomBytes(16).toString('hex');
                state.users[username] = { username, salt, hash: hashPw(password, salt), created_at: new Date().toISOString() };
                const token = signSession(username, isAdmin({ username }), SESSION_DAYS);
                state.sessions[token] = { username, expires: Date.now() + SESSION_DAYS * 864e5 };
                setSession(req, res, token, SESSION_DAYS * 86400);
                await save(true);
                return send(200, { user: { username, admin: isAdmin({ username }) }, token });
            }
            if (parts[1] === 'login' && method === 'POST') {
                const rl = rateLimit('login:' + ip, 10, 60000);
                if (!rl.ok) { res.setHeader('Retry-After', rl.retry); return fail(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute.'); }
                const u = Object.values(state.users).find(x => x.username.toLowerCase() === String(body.username || '').toLowerCase());
                if (!u || !safeEq(hashPw(String(body.password || ''), u.salt), u.hash)) return fail(401, 'BAD_CREDENTIALS', 'Invalid username or password.');
                const token = signSession(u.username, isAdmin(u), SESSION_DAYS);
                for (const [t, s] of Object.entries(state.sessions)) if (s.expires < Date.now()) delete state.sessions[t];
                state.sessions[token] = { username: u.username, expires: Date.now() + SESSION_DAYS * 864e5 };
                setSession(req, res, token, SESSION_DAYS * 86400);
                await save(true);
                return send(200, { user: { username: u.username, admin: isAdmin(u) }, token });
            }
            if (parts[1] === 'logout' && method === 'POST') {
                const tok = parseCookies(req).sl_session;
                if (tok) delete state.sessions[tok];
                setSession(req, res, '', 0);
                await save(true);
                return send(200, { success: true });
            }
            if (parts[1] === 'me' && method === 'GET') {
                const u = currentUser(req);
                return send(200, { user: u ? { username: u.username, admin: isAdmin(u) } : null });
            }
        }

        // ================= LOGIN REQUIRED =================
        const user = currentUser(req);
        if (!user) return fail(401, 'UNAUTHENTICATED', 'Please sign in.');
        const urate = rateLimit('user:' + user.username, 240, 60000);
        if (!urate.ok) return fail(429, 'RATE_LIMITED', 'Slow down.');
        if (method !== 'GET' && req.headers.origin && req.headers.host && new URL(req.headers.origin).host !== req.headers.host) return fail(403, 'BAD_ORIGIN', 'Cross-site request blocked.');

        if (parts[0] === 'facilities') {
            if (parts.length === 1 && method === 'GET') {
                const all = url.searchParams.get('all') === '1' && isAdmin(user);
                const list = Object.values(state.facilities).filter(f => all || roleOf({ username: user.username }, f) && (f.owner === user.username || (f.members || {})[user.username]));
                return send(200, { facilities: list.map(f => publicFacility(f, user)), admin: isAdmin(user) });
            }
            if (parts.length === 1 && method === 'POST') {
                const mine = Object.values(state.facilities).filter(f => f.owner === user.username).length;
                if (mine >= 10) return fail(400, 'LIMIT', 'Facility limit reached (10).');
                const name = clip(body.name, 60).trim();
                const siteId = String(body.siteId || '').trim().replace(/[^0-9]/g, '');
                if (!name) return fail(400, 'BAD_NAME', 'Facility name is required.');
                if (!siteId) return fail(400, 'BAD_SITE', 'Roblox Game / Place ID is required (numbers only).');
                const id = 'FAC-' + digits();
                state.facilities[id] = { facility_id: id, name, site_id: siteId, owner: user.username, members: {}, api_key: 'SLK_' + rid(16), blacklisted: false, created_at: new Date().toISOString() };
                addLog(id, null, 'ADMIN', 'FACILITY_CREATED', user.username, 'PORTAL', `Facility "${name}" created`, 'INFO');
                await save(true);
                return send(200, { facility: publicFacility(state.facilities[id], user) });
            }

            const fac = state.facilities[parts[1]];
            if (!fac) return fail(404, 'NOT_FOUND', 'Facility not found.');
            if (!has(user, fac, 'viewer')) return fail(403, 'FORBIDDEN', 'You do not have access to this facility.');
            const need = (min) => has(user, fac, min);
            const deny = () => fail(403, 'FORBIDDEN', 'Your role does not allow this action.');

            if (parts.length === 2 && method === 'GET') return send(200, { facility: publicFacility(fac, user) });

            if (parts.length === 2 && method === 'DELETE') {
                if (!need('owner')) return deny();
                Object.keys(state.systems).forEach(k => { if (state.systems[k].facility_id === fac.facility_id) delete state.systems[k]; });
                delete state.facilities[fac.facility_id];
                await save(true);
                return send(200, { success: true });
            }

            if (parts[2] === 'regenerate-key' && method === 'POST') {
                if (!need('manager')) return deny();
                fac.api_key = 'SLK_' + rid(16);
                addLog(fac.facility_id, null, 'ADMIN', 'API_KEY_ROTATED', user.username, 'PORTAL', 'Facility API key rotated', 'WARN');
                await save(true);
                return send(200, { api_key: fac.api_key });
            }

            if (parts[2] === 'webhook' && method === 'POST') {
                if (!need('manager')) return deny();
                const w = String(body.url || '').trim();
                if (w && !WEBHOOK_RE.test(w)) return fail(400, 'BAD_WEBHOOK', 'Must be a Discord webhook URL (https://discord.com/api/webhooks/...).');
                fac.webhook = w;
                addLog(fac.facility_id, null, 'ADMIN', 'WEBHOOK_UPDATED', user.username, 'PORTAL', w ? 'Discord webhook set' : 'Discord webhook removed', 'INFO');
                if (w) await notify(fac, '✅ Webhook connected', 'SafeLight alerts will be delivered here.', 3066993);
                await save(true);
                return send(200, { success: true });
            }

            if (parts[2] === 'members') {
                if (method === 'POST') {
                    if (!need('manager')) return deny();
                    const target = Object.values(state.users).find(u => u.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
                    const role = String(body.role || 'viewer');
                    if (!target) return fail(404, 'NO_SUCH_USER', 'No registered user with that username. They need to create an account first.');
                    if (!['viewer', 'operator', 'manager'].includes(role)) return fail(400, 'BAD_ROLE', 'Role must be viewer, operator or manager.');
                    if (target.username === fac.owner) return fail(400, 'IS_OWNER', 'That user already owns this facility.');
                    if (role === 'manager' && !need('owner')) return fail(403, 'FORBIDDEN', 'Only the owner can grant manager access.');
                    fac.members = fac.members || {};
                    fac.members[target.username] = role;
                    addLog(fac.facility_id, null, 'ADMIN', 'MEMBER_SET', user.username, 'PORTAL', `${target.username} is now ${role}`, 'INFO');
                    await save(true);
                    return send(200, { success: true, members: fac.members });
                }
                if (method === 'DELETE' && parts[3]) {
                    const name = parts[3];
                    const self = name === user.username;
                    if (!self && !need('manager')) return deny();
                    if (!(fac.members || {})[name]) return fail(404, 'NOT_FOUND', 'Not a member.');
                    if (!self && fac.members[name] === 'manager' && !need('owner')) return deny();
                    delete fac.members[name];
                    addLog(fac.facility_id, null, 'ADMIN', 'MEMBER_REMOVED', user.username, 'PORTAL', `${name} removed`, 'INFO');
                    await save(true);
                    return send(200, { success: true });
                }
            }

            if (parts[2] === 'systems' && method === 'POST') {
                if (!need('manager')) return deny();
                const type = String(body.type || '').toUpperCase();
                if (!COMMANDS[type]) return fail(400, 'BAD_TYPE', 'System type must be FIRE or SECURITY.');
                if (Object.values(state.systems).filter(s => s.facility_id === fac.facility_id).length >= 20) return fail(400, 'LIMIT', 'System limit reached (20 per facility).');
                const name = clip(body.name, 60).trim() || (type === 'FIRE' ? 'Fire Alarm Panel' : 'Security Panel');
                let sid; do { sid = (type === 'FIRE' ? 'F-' : 'S-') + digits(); } while (state.systems[sid]);
                state.systems[sid] = { system_id: sid, facility_id: fac.facility_id, type, name, state: {}, blacklisted: false, created_at: new Date().toISOString() };
                addLog(fac.facility_id, sid, type, 'SYSTEM_CREATED', user.username, 'PORTAL', `${type} system "${name}" registered`, 'INFO');
                await save(true);
                return send(200, { system: publicSystem(state.systems[sid]) });
            }

            if (parts[2] === 'systems' && parts[3] && method === 'DELETE') {
                if (!need('manager')) return deny();
                const s = state.systems[parts[3]];
                if (!s || s.facility_id !== fac.facility_id) return fail(404, 'NOT_FOUND', 'System not found.');
                delete state.systems[parts[3]];
                await save(true);
                return send(200, { success: true });
            }

            if (parts[2] === 'logs' && method === 'GET') {
                const t = url.searchParams.get('type'), sid = url.searchParams.get('system');
                let logs = state.logs.filter(l => l.facility_id === fac.facility_id);
                if (t && t !== 'ALL') logs = logs.filter(l => l.system_type === t);
                if (sid) logs = logs.filter(l => l.system_id === sid);
                if (url.searchParams.get('format') === 'csv') {
                    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
                    const csv = ['time,system_type,system_id,event,source,point,details,severity', ...logs.map(l => [l.created_at, l.system_type, l.system_id, l.event_type, l.device_name, l.point_or_zone, l.details, l.severity].map(q).join(','))].join('\n');
                    res.setHeader('Content-Type', 'text/csv');
                    res.setHeader('Content-Disposition', `attachment; filename="${fac.facility_id}-logs.csv"`);
                    return res.status(200).send(csv);
                }
                return send(200, { logs: logs.slice(0, 200) });
            }

            if (parts[2] === 'control' && method === 'POST') {
                if (!need('operator')) return deny();
                if (fac.blacklisted) return fail(403, 'BLACKLISTED', 'Facility is blacklisted.');
                const s = state.systems[body.systemId];
                if (!s || s.facility_id !== fac.facility_id) return fail(404, 'NOT_FOUND', 'System not found.');
                if (!COMMANDS[s.type].includes(body.command)) return fail(400, 'BAD_COMMAND', 'Invalid command for this system type.');
                state.commands.push({ id: rid(6), system_id: s.system_id, command: body.command, status: 'PENDING', ts: Date.now() });
                addLog(fac.facility_id, s.system_id, s.type, 'WEB_COMMAND', user.username, 'PORTAL', `Remote command ${body.command} sent`, 'WARN');
                await save(true);
                return send(200, { success: true, message: `${body.command} queued. It will run on the next sync (about 3 seconds).` });
            }

            if (parts[2] === 'blacklist' && method === 'POST') {
                if (!isAdmin(user)) return fail(403, 'FORBIDDEN', 'Administrators only.');
                fac.blacklisted = body.blacklisted !== false;
                fac.blacklist_reason = fac.blacklisted ? clip(body.reason || 'Blacklisted by SafeLight Central Command', 200) : '';
                addLog(fac.facility_id, null, 'ADMIN', fac.blacklisted ? 'BLACKLIST_ENGAGED' : 'BLACKLIST_LIFTED', user.username, 'ADMIN', fac.blacklist_reason || 'Access restored', 'CRITICAL');
                await save(true);
                return send(200, { success: true, blacklisted: fac.blacklisted });
            }
        }

        return fail(404, 'NOT_FOUND', 'API route not found.');
    } catch (e) {
        console.error(reqId, e);
        return res.status(500).json({ error: 'Server error', code: 'INTERNAL', requestId: reqId });
    }
};
