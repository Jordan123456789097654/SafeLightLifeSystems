// SafeLight Central Station - In-Memory / Serverless Store with 30-Day Retention
// Supports Vercel Serverless & Node.js environments

const https = require('https');

// Persistent storage in serverless container
const storage = {
    facilities: {
        "SIMP-4100-SL": {
            site_id: "75135033352863",
            facility_id: "SIMP-4100-SL",
            name: "SafeLight Commercial Headquarters",
            api_key: "SL_SECURE_KEY_9941",
            blacklisted: false,
            created_at: new Date().toISOString()
        }
    },
    systems: {
        "SYS-F-111345": {
            system_id: "SYS-F-111345",
            facility_id: "SIMP-4100-SL",
            type: "FIRE",
            model: "Simplex 4100U",
            status: "NORMAL",
            alarms_count: 0,
            ac_power: 1,
            blacklisted: false,
            last_heartbeat: new Date().toISOString()
        },
        "SYS-S-222789": {
            system_id: "SYS-S-222789",
            facility_id: "SIMP-4100-SL",
            type: "SECURITY",
            model: "Ademco Vista 20P",
            status: "DISARMED",
            alarmed_zone: 0,
            blacklisted: false,
            last_heartbeat: new Date().toISOString()
        }
    },
    logs: [
        {
            id: 1,
            facility_id: "SIMP-4100-SL",
            system_id: "SYS-F-111345",
            system_type: "FIRE",
            event_type: "STANDBY",
            device_name: "Simplex 4100U",
            point_or_zone: "PANEL",
            details: "Simplex 4100U system initialized and supervised",
            severity: "INFO",
            created_at: new Date().toISOString()
        }
    ],
    users: {},
    commands: []
};

// Roblox Bio Fetcher
function fetchRobloxUserBio(username, callback) {
    const postData = JSON.stringify({ usernames: [username], excludeBannedUsers: true });
    const req = https.request({
        hostname: 'users.roblox.com',
        path: '/v1/usernames/users',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed.data && parsed.data.length > 0) {
                    const robloxId = parsed.data[0].id;
                    https.get(`https://users.roblox.com/v1/users/${robloxId}`, (bRes) => {
                        let bData = '';
                        bRes.on('data', chunk => bData += chunk);
                        bRes.on('end', () => {
                            try {
                                const userObj = JSON.parse(bData);
                                callback(null, { robloxId: robloxId, bio: userObj.description || '' });
                            } catch (e) { callback(e); }
                        });
                    }).on('error', err => callback(err));
                } else {
                    callback(new Error("Roblox username not found."));
                }
            } catch (e) { callback(e); }
        });
    });
    req.on('error', err => callback(err));
    req.write(postData);
    req.end();
}

const SAFEWORDS = ["apple", "cat", "fish", "safelight", "simplex", "phoenix", "falcon", "citadel", "aurora", "beacon"];
function generateChallenge() {
    const w1 = SAFEWORDS[Math.floor(Math.random() * SAFEWORDS.length)];
    const w2 = SAFEWORDS[Math.floor(Math.random() * SAFEWORDS.length)];
    const w3 = SAFEWORDS[Math.floor(Math.random() * SAFEWORDS.length)];
    return `${w1} ${w2} ${w3} ${Math.floor(100 + Math.random() * 900)}`;
}

module.exports = (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname.replace(/^\/api/, '');

    // Parse JSON body helper
    let body = req.body || {};
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e){}
    }

    // ==========================================
    // 1. SYSTEM CREATION & GENERATION (Gives you a unique System ID)
    // ==========================================
    if (pathname === '/system/create' && req.method === 'POST') {
        const { siteId, facilityName, systemType, modelName } = body;
        if (!siteId || !systemType) {
            return res.status(400).json({ error: "Roblox Game Site ID and System Type (FIRE/SECURITY) required." });
        }

        const facId = "FAC-" + Math.floor(1000 + Math.random() * 9000);
        const randNum = Math.floor(100000 + Math.random() * 900000);
        const sysId = systemType === "FIRE" ? `SYS-F-${randNum}` : `SYS-S-${randNum}`;
        const apiKey = "SL_KEY_" + Math.random().toString(36).substr(2, 9).toUpperCase();

        if (!storage.facilities[facId]) {
            storage.facilities[facId] = {
                site_id: siteId.toString(),
                facility_id: facId,
                name: facilityName || `SafeLight Facility ${siteId}`,
                api_key: apiKey,
                blacklisted: false,
                created_at: new Date().toISOString()
            };
        }

        storage.systems[sysId] = {
            system_id: sysId,
            facility_id: facId,
            site_id: siteId.toString(),
            type: systemType.toUpperCase(),
            model: modelName || (systemType === "FIRE" ? "Simplex 4100U" : "Ademco Vista 20P"),
            status: systemType === "FIRE" ? "NORMAL" : "DISARMED",
            alarms_count: 0,
            ac_power: 1,
            blacklisted: false,
            last_heartbeat: new Date().toISOString()
        };

        return res.json({
            success: true,
            facilityId: facId,
            systemId: sysId,
            siteId: siteId,
            systemType: systemType.toUpperCase(),
            apiKey: apiKey,
            instructions: `Copy System ID '${sysId}' and Facility ID '${facId}' into your Roblox Simplex_Config / SafeLight_Config.`
        });
    }

    // ==========================================
    // 2. BLACKLIST / DISABLE FACILITY & SYSTEM
    // ==========================================
    if (pathname === '/facility/blacklist' && req.method === 'POST') {
        const { facilityId, systemId, blacklisted, reason } = body;
        if (facilityId && storage.facilities[facilityId]) {
            storage.facilities[facilityId].blacklisted = blacklisted !== false;
            // Also update all systems in facility
            Object.values(storage.systems).forEach(s => {
                if (s.facility_id === facilityId) s.blacklisted = blacklisted !== false;
            });
        }
        if (systemId && storage.systems[systemId]) {
            storage.systems[systemId].blacklisted = blacklisted !== false;
        }

        storage.logs.unshift({
            id: storage.logs.length + 1,
            facility_id: facilityId || "ALL",
            system_id: systemId || "ALL",
            system_type: "ADMIN",
            event_type: blacklisted !== false ? "BLACKLIST_ENGAGED" : "BLACKLIST_LIFTED",
            device_name: "Central Station Admin",
            point_or_zone: "OVERRIDE",
            details: reason || (blacklisted !== false ? "Facility access revoked and disabled" : "Access restored"),
            severity: "CRITICAL",
            created_at: new Date().toISOString()
        });

        return res.json({
            success: true,
            message: `Blacklist status updated to ${blacklisted !== false ? 'BLACKLISTED (SYSTEM DISABLED)' : 'ACTIVE'}`
        });
    }

    // ==========================================
    // 3. LIST ALL FACILITIES & SYSTEMS
    // ==========================================
    if (pathname === '/facilities' && req.method === 'GET') {
        const now = Date.now();
        const list = Object.values(storage.facilities).map(f => {
            const sysList = Object.values(storage.systems).filter(s => s.facility_id === f.facility_id);
            const isOnline = sysList.some(s => (now - new Date(s.last_heartbeat).getTime()) < 35000);
            return {
                ...f,
                isOnline,
                systems: sysList
            };
        });
        return res.json({ facilities: list });
    }

    // ==========================================
    // 4. ROBLOX INGESTION & SYNC (Heartbeat)
    // ==========================================
    if (pathname === '/facility/sync' && req.method === 'POST') {
        const { facilityId, systemId, apiKey, state } = body;
        const fac = storage.facilities[facilityId];
        const sys = storage.systems[systemId];

        // Check if blacklisted
        if ((fac && fac.blacklisted) || (sys && sys.blacklisted)) {
            return res.json({
                success: false,
                blacklisted: true,
                disabled: true,
                message: "THIS FACILITY HAS BEEN BLACKLISTED BY SAFELIGHT CENTRAL COMMAND. SYSTEM LOCKED OUT."
            });
        }

        if (sys) {
            sys.last_heartbeat = new Date().toISOString();
            if (state) {
                if (state.Mode) sys.status = state.Mode;
                if (state.CurrentMode) sys.status = state.CurrentMode;
                if (state.FireCount !== undefined) sys.alarms_count = state.FireCount;
                if (state.AlarmedZone !== undefined) sys.alarmed_zone = state.AlarmedZone;
                if (state.ACPowerNormal !== undefined) sys.ac_power = state.ACPowerNormal ? 1 : 0;
            }
        }

        // Return pending commands
        const pending = storage.commands.filter(c => (c.system_id === systemId || c.facility_id === facilityId) && c.status === 'PENDING');
        pending.forEach(p => p.status = 'PROCESSED');

        return res.json({
            success: true,
            blacklisted: false,
            disabled: false,
            pendingCommands: pending
        });
    }

    // ==========================================
    // 5. LOG INGESTION (With 30-Day Auto Retention)
    // ==========================================
    if (pathname === '/facility/log' && req.method === 'POST') {
        const { facilityId, systemId, systemType, eventType, deviceName, pointOrZone, details, severity } = body;

        const newLog = {
            id: storage.logs.length + 1,
            facility_id: facilityId || "SIMP-4100-SL",
            system_id: systemId || "SYS-000",
            system_type: systemType || "FIRE",
            event_type: eventType || "INFO",
            device_name: deviceName || "System",
            point_or_zone: pointOrZone || "N/A",
            details: details || "",
            severity: severity || "INFO",
            created_at: new Date().toISOString()
        };

        storage.logs.unshift(newLog);

        // 30-Day Retention Filter
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        storage.logs = storage.logs.filter(l => new Date(l.created_at).getTime() > thirtyDaysAgo);
        if (storage.logs.length > 2000) storage.logs = storage.logs.slice(0, 2000);

        return res.json({ success: true, logId: newLog.id });
    }

    // ==========================================
    // 6. GET STATUS (Live Telemetry)
    // ==========================================
    if (pathname.startsWith('/status') && req.method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        const facId = parts[1] || url.searchParams.get('facilityId') || "SIMP-4100-SL";
        const fac = storage.facilities[facId] || { name: `Facility ${facId}`, blacklisted: false };

        const fireSys = Object.values(storage.systems).find(s => s.facility_id === facId && s.type === 'FIRE') || {
            status: "NORMAL",
            alarms_count: 0,
            ac_power: 1,
            last_heartbeat: new Date().toISOString()
        };
        const secSys = Object.values(storage.systems).find(s => s.facility_id === facId && s.type === 'SECURITY') || {
            status: "DISARMED",
            alarmed_zone: 0,
            last_heartbeat: new Date().toISOString()
        };

        const now = Date.now();
        const lastSeen = Math.max(new Date(fireSys.last_heartbeat).getTime(), new Date(secSys.last_heartbeat).getTime());
        const isOnline = (now - lastSeen) < 35000;

        return res.json({
            facilityId: facId,
            name: fac.name,
            blacklisted: fac.blacklisted,
            isOnline,
            fire: {
                status: fireSys.status,
                alarmsCount: fireSys.alarms_count,
                acPower: fireSys.ac_power === 1 ? "NORMAL (240V)" : "BATTERY BACKUP"
            },
            security: {
                status: secSys.status,
                alarmedZone: secSys.alarmed_zone
            }
        });
    }

    // ==========================================
    // 7. GET LOGS (Filtered up to 30 Days)
    // ==========================================
    if (pathname.startsWith('/logs') && req.method === 'GET') {
        const parts = pathname.split('/').filter(Boolean);
        const facId = parts[1] || url.searchParams.get('facilityId');
        const sysType = url.searchParams.get('systemType');
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

        let filtered = storage.logs.filter(l => new Date(l.created_at).getTime() > thirtyDaysAgo);
        if (facId && facId !== 'ALL') filtered = filtered.filter(l => l.facility_id === facId);
        if (sysType && sysType !== 'ALL') filtered = filtered.filter(l => l.system_type === sysType);

        return res.json({ logs: filtered.slice(0, 150) });
    }

    // ==========================================
    // 7. ROBLOX BIO VERIFICATION AUTH
    // ==========================================
    if (pathname === '/auth/start' && req.method === 'POST') {
        const { username } = body;
        if (!username) return res.status(400).json({ error: "Username required" });

        fetchRobloxUserBio(username, (err, rUser) => {
            if (err || !rUser) return res.status(404).json({ error: "Roblox username not found" });

            const challenge = generateChallenge();
            storage.users[username] = {
                username,
                robloxId: rUser.robloxId,
                challenge,
                verified: false,
                role: (username.toLowerCase() === "jordandanielsgames") ? "MASTER_ADMIN" : "OPERATOR"
            };

            return res.json({
                username,
                challenge,
                message: `Add '${challenge}' into your Roblox About/Bio, then verify.`
            });
        });
        return;
    }

    if (pathname === '/auth/verify' && req.method === 'POST') {
        const { username } = body;
        const u = storage.users[username];
        if (!u) return res.status(400).json({ error: "No active challenge found" });

        fetchRobloxUserBio(username, (err, rUser) => {
            if (err) return res.status(500).json({ error: "Could not fetch bio from Roblox" });

            const hasAll = u.challenge.toLowerCase().split(' ').every(w => rUser.bio.toLowerCase().includes(w));
            if (hasAll) {
                u.verified = true;
                const token = "SL_TOKEN_" + Math.random().toString(36).substr(2) + Date.now().toString(36);
                u.token = token;
                return res.json({
                    success: true,
                    username,
                    role: u.role,
                    token,
                    message: "Identity Verified via Roblox Bio!"
                });
            } else {
                return res.status(400).json({
                    success: false,
                    error: `Bio does not contain '${u.challenge}'. Please save on Roblox and retry.`
                });
            }
        });
        return;
    }

    // ==========================================
    // 8. REMOTE CONTROL DISPATCH
    // ==========================================
    if (pathname === '/control' && req.method === 'POST') {
        const { facilityId, systemId, command, systemType, token } = body;
        const validUser = Object.values(storage.users).find(u => u.token === token && u.verified);
        if (!validUser) return res.status(401).json({ error: "Unauthorized: Verified login required." });

        storage.commands.push({
            id: storage.commands.length + 1,
            facility_id: facilityId || "SIMP-4100-SL",
            system_id: systemId || "",
            system_type: systemType || "FIRE",
            command: command,
            status: "PENDING",
            created_at: new Date().toISOString()
        });

        storage.logs.unshift({
            id: storage.logs.length + 1,
            facility_id: facilityId || "SIMP-4100-SL",
            system_id: systemId || "",
            system_type: systemType || "FIRE",
            event_type: "WEB_COMMAND",
            device_name: validUser.username,
            point_or_zone: "WEB PORTAL",
            details: `Dispatched remote '${command}' to ${systemType}`,
            severity: "WARN",
            created_at: new Date().toISOString()
        });

        return res.json({
            success: true,
            message: `Remote command '${command}' transmitted to site.`
        });
    }

    // Default fallback
    return res.status(404).json({ error: "API route not found" });
};
