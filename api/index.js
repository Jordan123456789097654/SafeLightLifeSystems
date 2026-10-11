// SafeLight Central Station API (Vercel serverless / Express compatible)
// Storage: Upstash Redis REST if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set
// (Vercel Marketplace -> Upstash Redis). Otherwise in-memory (resets on cold start).

const crypto = require('crypto');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'JordanDanielsGames').toLowerCase();
const SESSION_DAYS = 30;
const ONLINE_MS = 30000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const STATE_KEY = 'safelight:state:v2';

let state = { users: {}, sessions: {}, facilities: {}, systems: {}, logs: [], commands: [] };
let lastSave = 0;

async function redis(cmd) {
    const r = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd)
    });
    return (await r.json()).result;
}
async function load() {
    if (!REDIS_URL) return;
    try {
        const raw = await redis(['GET', STATE_KEY]);
        if (raw) state = JSON.parse(raw);
    } catch (e) { console.error('load failed', e.message); }
}
async function save(force) {
    if (!REDIS_URL) return;
    if (!force && Date.now() - lastSave < 15000) return;
    lastSave = Date.now();
    try { await redis(['SET', STATE_KEY, JSON.stringify(state)]); } catch (e) { console.error('save failed', e.message); }
}

const rid = (n) => crypto.randomBytes(n).toString('hex').toUpperCase();
const digits = () => String(Math.floor(100000 + Math.random() * 900000));

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(p => {
        const i = p.indexOf('=');
        if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}
function setSession(req, res, token, maxAgeSec) {
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sl_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
function currentUser(req) {
    const tok = parseCookies(req).sl_session;
    const s = tok && state.sessions[tok];
    if (!s || s.expires < Date.now()) return null;
    return state.users[s.username] || null;
}
const isAdmin = (u) => u && u.username.toLowerCase() === ADMIN_USERNAME;
const canAccess = (u, f) => f && u && (f.owner === u.username || isAdmin(u));

function purgeLogs() {
    const cutoff = Date.now() - RETENTION_MS;
    state.logs = state.logs.filter(l => l.ts > cutoff).slice(0, 5000);
}
function addLog(facilityId, systemId, systemType, eventType, device, point, details, severity) {
    state.logs.unshift({
        facility_id: facilityId, system_id: systemId || null, system_type: systemType,
        event_type: eventType, device_name: device || 'System', point_or_zone: point || '',
        details: details || '', severity: severity || 'INFO',
        ts: Date.now(), created_at: new Date().toISOString()
    });
    purgeLogs();
}

function publicSystem(s) {
    return {
        system_id: s.system_id, facility_id: s.facility_id, type: s.type, name: s.name,
        state: s.state || {}, blacklisted: !!s.blacklisted, last_seen: s.last_seen || null,
        online: !!s.last_seen && Date.now() - s.last_seen < ONLINE_MS
    };
}
function publicFacility(f, withKey) {
    const systems = Object.values(state.systems).filter(s => s.facility_id === f.facility_id).map(publicSystem);
    const out = {
        facility_id: f.facility_id, name: f.name, site_id: f.site_id, owner: f.owner,
        blacklisted: !!f.blacklisted, blacklist_reason: f.blacklist_reason || '',
        created_at: f.created_at, systems, online: systems.some(s => s.online)
    };
    if (withKey) out.api_key = f.api_key;
    return out;
}

const COMMANDS = {
    FIRE: ['FIRE_ACK', 'ALARM_SILENCE', 'SYSTEM_RESET', 'DRILL'],
    SECURITY: ['ARM_AWAY', 'ARM_STAY', 'DISARM', 'PANIC_POLICE']
};

module.exports = async (req, res) => {
    const send = (code, obj) => res.status(code).json(obj);
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
        const parts = path.split('/').filter(Boolean);
        const method = req.method;
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

        await load();

        // ================= DEVICE (Roblox) ENDPOINTS: authenticated by facility API key =================
        if (parts[0] === 'device' && method === 'POST') {
            const fac = Object.values(state.facilities).find(f => f.api_key && f.api_key === body.apiKey);
            if (!fac) return send(403, { error: 'Invalid API key' });
            const sys = state.systems[body.systemId];
            if (!sys || sys.facility_id !== fac.facility_id) return send(403, { error: 'System ID does not belong to this facility' });

            if (fac.blacklisted || sys.blacklisted) {
                return send(200, { success: false, blacklisted: true, disabled: true, message: fac.blacklist_reason || 'Facility blacklisted by SafeLight Central Command' });
            }

            if (parts[1] === 'sync') {
                const prevStatus = sys.state && sys.state.status;
                const st = body.state || {};
                sys.state = {
                    status: st.status || (sys.type === 'FIRE' ? 'NORMAL' : 'DISARMED'),
                    alarms: st.alarms || 0,
                    zone: st.zone || 0,
                    acPower: st.acPower !== false
                };
                const wasOnline = sys.last_seen && Date.now() - sys.last_seen < ONLINE_MS;
                sys.last_seen = Date.now();
                const pending = state.commands.filter(c => c.system_id === sys.system_id && c.status === 'PENDING');
                pending.forEach(c => c.status = 'SENT');
                state.commands = state.commands.filter(c => c.status === 'PENDING' || Date.now() - c.ts < 3600000);
                if (!wasOnline) addLog(fac.facility_id, sys.system_id, sys.type, 'ONLINE', sys.name, 'LINK', 'System connected to Central Station', 'INFO');
                await save(!!pending.length || prevStatus !== sys.state.status || !wasOnline);
                return send(200, { success: true, blacklisted: false, commands: pending.map(c => ({ id: c.id, command: c.command })) });
            }
            if (parts[1] === 'log') {
                addLog(fac.facility_id, sys.system_id, sys.type, body.eventType || 'INFO', body.deviceName, body.pointOrZone, body.details, body.severity);
                await save(true);
                return send(200, { success: true });
            }
            return send(404, { error: 'Unknown device route' });
        }

        // ================= AUTH =================
        if (parts[0] === 'auth') {
            if (parts[1] === 'signup' && method === 'POST') {
                const username = String(body.username || '').trim();
                const password = String(body.password || '');
                if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return send(400, { error: 'Username must be 3-20 letters, numbers or underscores.' });
                if (password.length < 8) return send(400, { error: 'Password must be at least 8 characters.' });
                if (state.users[username.toLowerCase()] || Object.values(state.users).some(u => u.username.toLowerCase() === username.toLowerCase()))
                    return send(409, { error: 'That username is already taken.' });
                const salt = crypto.randomBytes(16).toString('hex');
                state.users[username] = { username, salt, hash: hashPw(password, salt), created_at: new Date().toISOString() };
                const token = crypto.randomBytes(32).toString('hex');
                state.sessions[token] = { username, expires: Date.now() + SESSION_DAYS * 864e5 };
                setSession(req, res, token, SESSION_DAYS * 86400);
                await save(true);
                return send(200, { user: { username, admin: isAdmin({ username }) } });
            }
            if (parts[1] === 'login' && method === 'POST') {
                const u = Object.values(state.users).find(x => x.username.toLowerCase() === String(body.username || '').toLowerCase());
                if (!u || hashPw(String(body.password || ''), u.salt) !== u.hash) return send(401, { error: 'Invalid username or password.' });
                const token = crypto.randomBytes(32).toString('hex');
                state.sessions[token] = { username: u.username, expires: Date.now() + SESSION_DAYS * 864e5 };
                for (const [t, s] of Object.entries(state.sessions)) if (s.expires < Date.now()) delete state.sessions[t];
                setSession(req, res, token, SESSION_DAYS * 86400);
                await save(true);
                return send(200, { user: { username: u.username, admin: isAdmin(u) } });
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

        // ================= EVERYTHING BELOW REQUIRES LOGIN =================
        const user = currentUser(req);
        if (!user) return send(401, { error: 'Please sign in.' });

        if (parts[0] === 'facilities') {
            // List
            if (parts.length === 1 && method === 'GET') {
                const all = url.searchParams.get('all') === '1' && isAdmin(user);
                const list = Object.values(state.facilities).filter(f => all || f.owner === user.username).map(f => publicFacility(f, !all || f.owner === user.username));
                return send(200, { facilities: list, admin: isAdmin(user) });
            }
            // Create facility
            if (parts.length === 1 && method === 'POST') {
                const name = String(body.name || '').trim().slice(0, 60);
                const siteId = String(body.siteId || '').trim().replace(/[^0-9]/g, '');
                if (!name) return send(400, { error: 'Facility name is required.' });
                if (!siteId) return send(400, { error: 'Roblox Game / Place ID is required (numbers only).' });
                const id = 'FAC-' + digits();
                state.facilities[id] = {
                    facility_id: id, name, site_id: siteId, owner: user.username,
                    api_key: 'SLK_' + rid(16), blacklisted: false, created_at: new Date().toISOString()
                };
                addLog(id, null, 'ADMIN', 'FACILITY_CREATED', user.username, 'PORTAL', `Facility "${name}" created`, 'INFO');
                await save(true);
                return send(200, { facility: publicFacility(state.facilities[id], true) });
            }

            const fac = state.facilities[parts[1]];
            if (!fac) return send(404, { error: 'Facility not found.' });
            if (!canAccess(user, fac)) return send(403, { error: 'You do not have access to this facility.' });
            const owner = fac.owner === user.username;

            if (parts.length === 2 && method === 'GET') return send(200, { facility: publicFacility(fac, owner) });

            if (parts.length === 2 && method === 'DELETE') {
                Object.keys(state.systems).forEach(k => { if (state.systems[k].facility_id === fac.facility_id) delete state.systems[k]; });
                delete state.facilities[fac.facility_id];
                await save(true);
                return send(200, { success: true });
            }

            if (parts[2] === 'regenerate-key' && method === 'POST') {
                if (!owner) return send(403, { error: 'Only the owner can rotate the key.' });
                fac.api_key = 'SLK_' + rid(16);
                addLog(fac.facility_id, null, 'ADMIN', 'API_KEY_ROTATED', user.username, 'PORTAL', 'Facility API key rotated', 'WARN');
                await save(true);
                return send(200, { api_key: fac.api_key });
            }

            if (parts[2] === 'systems' && method === 'POST') {
                const type = String(body.type || '').toUpperCase();
                if (!COMMANDS[type]) return send(400, { error: 'System type must be FIRE or SECURITY.' });
                const count = Object.values(state.systems).filter(s => s.facility_id === fac.facility_id).length;
                if (count >= 20) return send(400, { error: 'System limit reached (20 per facility).' });
                const name = String(body.name || '').trim().slice(0, 60) || (type === 'FIRE' ? 'Fire Alarm Panel' : 'Security Panel');
                let sid;
                do { sid = (type === 'FIRE' ? 'F-' : 'S-') + digits(); } while (state.systems[sid]);
                state.systems[sid] = { system_id: sid, facility_id: fac.facility_id, type, name, state: {}, blacklisted: false, created_at: new Date().toISOString() };
                addLog(fac.facility_id, sid, type, 'SYSTEM_CREATED', user.username, 'PORTAL', `${type} system "${name}" registered`, 'INFO');
                await save(true);
                return send(200, { system: publicSystem(state.systems[sid]) });
            }

            if (parts[2] === 'systems' && parts[3] && method === 'DELETE') {
                const s = state.systems[parts[3]];
                if (!s || s.facility_id !== fac.facility_id) return send(404, { error: 'System not found.' });
                delete state.systems[parts[3]];
                await save(true);
                return send(200, { success: true });
            }

            if (parts[2] === 'logs' && method === 'GET') {
                const t = url.searchParams.get('type');
                const sid = url.searchParams.get('system');
                let logs = state.logs.filter(l => l.facility_id === fac.facility_id);
                if (t && t !== 'ALL') logs = logs.filter(l => l.system_type === t);
                if (sid) logs = logs.filter(l => l.system_id === sid);
                return send(200, { logs: logs.slice(0, 200) });
            }

            if (parts[2] === 'control' && method === 'POST') {
                if (fac.blacklisted) return send(403, { error: 'Facility is blacklisted.' });
                const s = state.systems[body.systemId];
                if (!s || s.facility_id !== fac.facility_id) return send(404, { error: 'System not found.' });
                if (!COMMANDS[s.type].includes(body.command)) return send(400, { error: 'Invalid command for this system type.' });
                state.commands.push({ id: rid(6), system_id: s.system_id, command: body.command, status: 'PENDING', ts: Date.now() });
                addLog(fac.facility_id, s.system_id, s.type, 'WEB_COMMAND', user.username, 'PORTAL', `Remote command ${body.command} sent`, 'WARN');
                await save(true);
                return send(200, { success: true, message: `${body.command} queued. It will run on the next sync (about 3 seconds).` });
            }

            if (parts[2] === 'blacklist' && method === 'POST') {
                if (!isAdmin(user)) return send(403, { error: 'Administrators only.' });
                fac.blacklisted = body.blacklisted !== false;
                fac.blacklist_reason = fac.blacklisted ? String(body.reason || 'Blacklisted by SafeLight Central Command').slice(0, 200) : '';
                addLog(fac.facility_id, null, 'ADMIN', fac.blacklisted ? 'BLACKLIST_ENGAGED' : 'BLACKLIST_LIFTED', user.username, 'ADMIN', fac.blacklist_reason || 'Access restored', 'CRITICAL');
                await save(true);
                return send(200, { success: true, blacklisted: fac.blacklisted });
            }
        }

        return send(404, { error: 'API route not found' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Server error' });
    }
};
