const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Initialization
const dbPath = path.join(__dirname, 'safelight.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database connection error:", err);
    else console.log("Connected to SQLite Database at", dbPath);
});

// Setup Tables
db.serialize(() => {
    // 1. Facilities and Systems
    db.exec(`
        CREATE TABLE IF NOT EXISTS facilities (
            facility_id TEXT PRIMARY KEY,
            site_id TEXT,
            name TEXT NOT NULL,
            api_key TEXT NOT NULL,
            blacklisted INTEGER DEFAULT 0,
            fire_status TEXT DEFAULT 'NORMAL',
            security_status TEXT DEFAULT 'DISARMED',
            fire_alarms_count INTEGER DEFAULT 0,
            security_alarmed_zone INTEGER DEFAULT 0,
            ac_power INTEGER DEFAULT 1,
            last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS systems (
            system_id TEXT PRIMARY KEY,
            facility_id TEXT NOT NULL,
            site_id TEXT,
            type TEXT NOT NULL,
            model TEXT,
            status TEXT DEFAULT 'NORMAL',
            alarms_count INTEGER DEFAULT 0,
            alarmed_zone INTEGER DEFAULT 0,
            ac_power INTEGER DEFAULT 1,
            blacklisted INTEGER DEFAULT 0,
            last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => {
        if (err) console.error("Error creating tables:", err);
        // Ensure migration columns exist on facilities table if previously created
        db.run("ALTER TABLE facilities ADD COLUMN site_id TEXT", () => {});
        db.run("ALTER TABLE facilities ADD COLUMN blacklisted INTEGER DEFAULT 0", () => {});
    });

    // 2. 30-Day Logs Table
    db.run(`
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            facility_id TEXT NOT NULL,
            system_type TEXT NOT NULL, -- 'FIRE' or 'SECURITY'
            event_type TEXT NOT NULL,  -- 'ALARM', 'TROUBLE', 'SUPERVISORY', 'ARM', 'DISARM', 'RESET', 'SILENCE'
            device_name TEXT,
            point_or_zone TEXT,
            details TEXT,
            severity TEXT DEFAULT 'INFO', -- 'INFO', 'WARN', 'CRITICAL'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 3. User Accounts & Verification
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            roblox_user_id TEXT,
            role TEXT DEFAULT 'OPERATOR', -- 'OPERATOR', 'SUPERVISOR', 'ADMIN'
            verified INTEGER DEFAULT 0,
            bio_challenge TEXT,
            session_token TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 4. Remote Queued Commands (Web -> Roblox)
    db.run(`
        CREATE TABLE IF NOT EXISTS command_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            facility_id TEXT NOT NULL,
            system_type TEXT NOT NULL, -- 'FIRE' or 'SECURITY'
            command TEXT NOT NULL,     -- 'RESET', 'SILENCE', 'DRILL', 'ARM_AWAY', 'ARM_STAY', 'DISARM'
            payload TEXT,
            status TEXT DEFAULT 'PENDING', -- 'PENDING', 'PROCESSED'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Ensure default facility exists
    db.run(`
        INSERT OR IGNORE INTO facilities (facility_id, name, api_key)
        VALUES ('SIMP-4100-SL', 'SafeLight Life Systems Master Facility', 'SL_SECURE_KEY_9941')
    `);
});

// Helper: Verify Roblox User Bio via Roblox Web API
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
                    // Get Bio / Description
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

// Random Bio Challenge Safewords
const SAFEWORDS = [
    "apple", "cat", "fish", "safelight", "shield", "simplex", "phoenix", "bluebird",
    "falcon", "silver", "echo", "beacon", "citadel", "aurora", "summit", "nebula"
];

function generateChallenge() {
    const w1 = SAFEWORDS[Math.floor(Math.random() * SAFEWORDS.length)];
    const w2 = SAFEWORDS[Math.floor(Math.random() * SAFEWORDS.length)];
    const w3 = SAFEWORDS[Math.floor(Math.random() * SAFEWORDS.length)];
    const num = Math.floor(100 + Math.random() * 900);
    return `${w1} ${w2} ${w3} ${num}`;
}

// ==========================================
// AUTHENTICATION & BIO VERIFICATION ROUTES
// ==========================================

// 1. Request Login / Verification Challenge
app.post('/api/auth/start', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username required" });

    fetchRobloxUserBio(username, (err, robloxUser) => {
        if (err || !robloxUser) {
            return res.status(404).json({ error: "Roblox account not found" });
        }

        const challenge = generateChallenge();
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (row) {
                db.run("UPDATE users SET bio_challenge = ?, roblox_user_id = ? WHERE username = ?",
                    [challenge, robloxUser.robloxId.toString(), username], () => {
                        res.json({
                            username,
                            robloxId: robloxUser.robloxId,
                            challenge,
                            message: `Add the exact code '${challenge}' into your Roblox profile About/Bio section, then click Verify.`
                        });
                    }
                );
            } else {
                db.run("INSERT INTO users (username, roblox_user_id, bio_challenge) VALUES (?, ?, ?)",
                    [username, robloxUser.robloxId.toString(), challenge], () => {
                        res.json({
                            username,
                            robloxId: robloxUser.robloxId,
                            challenge,
                            message: `Add the exact code '${challenge}' into your Roblox profile About/Bio section, then click Verify.`
                        });
                    }
                );
            }
        });
    });
});

// 2. Complete Verification
app.post('/api/auth/verify', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username required" });

    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (!user || !user.bio_challenge) {
            return res.status(400).json({ error: "No active verification challenge found" });
        }

        fetchRobloxUserBio(username, (err, robloxUser) => {
            if (err) return res.status(500).json({ error: "Could not read Roblox bio" });

            const bioText = robloxUser.bio.toLowerCase();
            const targetWords = user.bio_challenge.toLowerCase().split(' ');
            const hasAll = targetWords.every(w => bioText.includes(w));

            if (hasAll) {
                const token = 'SL_TOKEN_' + Math.random().toString(36).substr(2) + Date.now().toString(36);
                db.run("UPDATE users SET verified = 1, session_token = ? WHERE username = ?", [token, username], () => {
                    res.json({
                        success: true,
                        username: user.username,
                        robloxId: user.roblox_user_id,
                        role: user.role,
                        token: token,
                        message: "Roblox Bio Verified! Welcome to SafeLight Central Command."
                    });
                });
            } else {
                res.status(400).json({
                    success: false,
                    error: `Bio does not contain '${user.bio_challenge}'. Please update your About section and retry.`
                });
            }
        });
    });
});

// ==========================================
// SYSTEM CREATION & GENERATION
// ==========================================
app.post('/api/system/create', (req, res) => {
    const { siteId, facilityName, systemType, modelName } = req.body;
    if (!siteId || !systemType) {
        return res.status(400).json({ error: "Roblox Game Site ID and System Type (FIRE/SECURITY) required." });
    }

    const facId = "FAC-" + Math.floor(1000 + Math.random() * 9000);
    const randNum = Math.floor(100000 + Math.random() * 900000);
    const sysId = systemType === "FIRE" ? `SYS-F-${randNum}` : `SYS-S-${randNum}`;
    const apiKey = "SL_KEY_" + Math.random().toString(36).substr(2, 9).toUpperCase();

    db.run(`
        INSERT OR IGNORE INTO facilities (facility_id, site_id, name, api_key, blacklisted)
        VALUES (?, ?, ?, ?, 0)
    `, [facId, siteId.toString(), facilityName || `SafeLight Facility ${siteId}`, apiKey], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.run(`
            INSERT OR REPLACE INTO systems (system_id, facility_id, site_id, type, model, status, blacklisted)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `, [sysId, facId, siteId.toString(), systemType.toUpperCase(), modelName || (systemType === "FIRE" ? "Simplex 4100U" : "Ademco Vista 20P"), systemType === "FIRE" ? "NORMAL" : "DISARMED"], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            res.json({
                success: true,
                facilityId: facId,
                systemId: sysId,
                siteId: siteId,
                systemType: systemType.toUpperCase(),
                apiKey: apiKey,
                instructions: `Copy System ID '${sysId}' and Facility ID '${facId}' into your Roblox Simplex_Config / SafeLight_Config.`
            });
        });
    });
});

// ==========================================
// BLACKLIST / DISABLE FACILITY & SYSTEM
// ==========================================
app.post('/api/facility/blacklist', (req, res) => {
    const { facilityId, systemId, blacklisted, reason } = req.body;
    const isBl = blacklisted !== false ? 1 : 0;

    if (facilityId) {
        db.run("UPDATE facilities SET blacklisted = ? WHERE facility_id = ?", [isBl, facilityId]);
        db.run("UPDATE systems SET blacklisted = ? WHERE facility_id = ?", [isBl, facilityId]);
    }
    if (systemId) {
        db.run("UPDATE systems SET blacklisted = ? WHERE system_id = ?", [isBl, systemId]);
    }

    db.run(`
        INSERT INTO activity_logs (facility_id, system_type, event_type, device_name, point_or_zone, details, severity)
        VALUES (?, 'ADMIN', ?, 'Central Station Admin', 'OVERRIDE', ?, 'CRITICAL')
    `, [facilityId || "ALL", isBl ? "BLACKLIST_ENGAGED" : "BLACKLIST_LIFTED", reason || (isBl ? "Facility access revoked and disabled" : "Access restored")]);

    res.json({
        success: true,
        message: `Blacklist status updated to ${isBl ? 'BLACKLISTED (SYSTEM DISABLED)' : 'ACTIVE'}`
    });
});

// ==========================================
// MASTER FACILITIES DIRECTORY
// ==========================================
app.get('/api/facilities', (req, res) => {
    db.all("SELECT * FROM facilities", [], (err, facilities) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all("SELECT * FROM systems", [], (err, systems) => {
            if (err) return res.status(500).json({ error: err.message });

            const now = Date.now();
            const result = (facilities || []).map(f => {
                const sysList = (systems || []).filter(s => s.facility_id === f.facility_id);
                const isOnline = sysList.some(s => (now - new Date(s.last_heartbeat).getTime()) < 35000) ||
                                 ((now - new Date(f.last_heartbeat).getTime()) < 35000);
                return {
                    ...f,
                    blacklisted: f.blacklisted === 1,
                    isOnline,
                    systems: sysList
                };
            });

            res.json({ facilities: result });
        });
    });
});

// ==========================================
// ROBLOX GAME CLIENT API (TELEMETRY & SYNC)
// ==========================================

// 1. Ingest Telemetry Heartbeat from Roblox
app.post('/api/facility/sync', (req, res) => {
    const { facilityId, systemId, apiKey, state, fireState, securityState } = req.body;
    if (!facilityId || !apiKey) return res.status(401).json({ error: "Facility ID and API Key required" });

    db.get("SELECT * FROM facilities WHERE facility_id = ? AND api_key = ?", [facilityId, apiKey], (err, facility) => {
        if (!facility) return res.status(403).json({ error: "Invalid Facility credentials" });

        // Blacklist check!
        if (facility.blacklisted === 1) {
            return res.json({
                success: false,
                blacklisted: true,
                disabled: true,
                message: "THIS FACILITY HAS BEEN BLACKLISTED BY SAFELIGHT CENTRAL COMMAND. SYSTEM LOCKED OUT."
            });
        }

        const fireStatus = fireState ? fireState.Mode || 'NORMAL' : facility.fire_status;
        const fireAlarms = fireState ? fireState.FireCount || 0 : facility.fire_alarms_count;
        const acPower = (fireState && fireState.ACPowerNormal !== undefined) ? (fireState.ACPowerNormal ? 1 : 0) : facility.ac_power;

        const secStatus = securityState ? securityState.CurrentMode || 'DISARMED' : facility.security_status;
        const secZone = securityState ? securityState.AlarmedZone || 0 : facility.security_alarmed_zone;

        db.run(`
            UPDATE facilities
            SET fire_status = ?, fire_alarms_count = ?, ac_power = ?, security_status = ?, security_alarmed_zone = ?, last_heartbeat = CURRENT_TIMESTAMP
            WHERE facility_id = ?
        `, [fireStatus, fireAlarms, acPower, secStatus, secZone, facilityId], () => {
            // Check for pending remote commands for this facility
            db.all("SELECT * FROM command_queue WHERE facility_id = ? AND status = 'PENDING'", [facilityId], (err, pendingCmds) => {
                if (pendingCmds && pendingCmds.length > 0) {
                    const ids = pendingCmds.map(c => c.id);
                    db.run(`UPDATE command_queue SET status = 'PROCESSED' WHERE id IN (${ids.join(',')})`);
                }
                res.json({
                    success: true,
                    facilityId: facilityId,
                    pendingCommands: pendingCmds || []
                });
            });
        });
    });
});

// 2. Ingest Logs from Roblox Systems
app.post('/api/facility/log', (req, res) => {
    const { facilityId, apiKey, systemType, eventType, deviceName, pointOrZone, details, severity } = req.body;
    if (!facilityId || !apiKey) return res.status(401).json({ error: "Authentication required" });

    db.get("SELECT * FROM facilities WHERE facility_id = ? AND api_key = ?", [facilityId, apiKey], (err, facility) => {
        if (!facility) return res.status(403).json({ error: "Unauthorized" });

        db.run(`
            INSERT INTO activity_logs (facility_id, system_type, event_type, device_name, point_or_zone, details, severity)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [facilityId, systemType || 'SYSTEM', eventType || 'INFO', deviceName || 'System', pointOrZone || 'N/A', details || '', severity || 'INFO'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, logId: this.lastID });
        });
    });
});

// ==========================================
// WEB PORTAL MONITORING & CONTROL APIS
// ==========================================

// 1. Get Live Status of Facility
app.get('/api/status/:facilityId', (req, res) => {
    const { facilityId } = req.params;
    db.get("SELECT * FROM facilities WHERE facility_id = ?", [facilityId], (err, facility) => {
        if (!facility) return res.status(404).json({ error: "Facility not found" });

        // Check if facility is online (within last 35 seconds)
        const lastSeen = new Date(facility.last_heartbeat).getTime();
        const now = Date.now();
        const isOnline = (now - lastSeen) < 35000;

        res.json({
            facilityId: facility.facility_id,
            name: facility.name,
            isOnline: isOnline,
            lastHeartbeat: facility.last_heartbeat,
            fire: {
                status: facility.fire_status,
                alarmsCount: facility.fire_alarms_count,
                acPower: facility.ac_power === 1 ? "NORMAL" : "BATTERY BACKUP"
            },
            security: {
                status: facility.security_status,
                alarmedZone: facility.security_alarmed_zone
            }
        });
    });
});

// 2. Get Logs (Filtered up to 30 Days)
app.get('/api/logs/:facilityId', (req, res) => {
    const { facilityId } = req.params;
    const { systemType, limit } = req.query;

    let query = `
        SELECT * FROM activity_logs
        WHERE facility_id = ?
        AND created_at >= datetime('now', '-30 days')
    `;
    const params = [facilityId];

    if (systemType && systemType !== 'ALL') {
        query += " AND system_type = ?";
        params.push(systemType);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(parseInt(limit) || 200);

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ logs: rows || [] });
    });
});

// 3. Web Control Dispatch (Queue command to Roblox game)
app.post('/api/control', (req, res) => {
    const { facilityId, token, systemType, command, payload } = req.body;
    if (!facilityId || !command) return res.status(400).json({ error: "Facility ID and command required" });

    // Validate User Token
    db.get("SELECT * FROM users WHERE session_token = ? AND verified = 1", [token], (err, user) => {
        if (!user) return res.status(401).json({ error: "Unauthorized: Verified session required" });

        db.run(`
            INSERT INTO command_queue (facility_id, system_type, command, payload)
            VALUES (?, ?, ?, ?)
        `, [facilityId, systemType || 'FIRE', command, typeof payload === 'object' ? JSON.stringify(payload) : payload || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });

            // Also record into audit log
            db.run(`
                INSERT INTO activity_logs (facility_id, system_type, event_type, device_name, point_or_zone, details, severity)
                VALUES (?, ?, 'WEB_COMMAND', ?, 'PORTAL', ?, 'WARN')
            `, [facilityId, systemType, user.username, `Executed ${command} from Web Portal`, 'WARN']);

            res.json({
                success: true,
                queueId: this.lastID,
                command: command,
                message: `Command '${command}' queued and will execute on Roblox site.`
            });
        });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` SafeLight Central Station Web & Database Server Online`);
    console.log(` Port: http://localhost:${PORT}`);
    console.log(` Database: SQLite with 30-Day Auto Retention`);
    console.log(`=======================================================`);
});
