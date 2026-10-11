# SafeLight Life Systems — Central Station Telemetry Portal & Database

<p align="center">
  <strong>Next-Generation Cloud Monitoring, Real-Time Telemetry & Lockout Engine for Roblox Life Safety Systems</strong><br>
  Built for the <em>Simplex 4100U Fire Alarm Suite</em> & <em>Ademco Vista 20P Security Suite</em>
</p>

---

## 🌟 Overview

**SafeLight Central Station** is an external monitoring portal and audit logging system designed for Roblox life safety and intrusion security installations. It bridges in-game alarm panels with an external web dashboard and RESTful API hosted on **Vercel** or any Node.js environment.

---

## 🚀 Key Features

1. **Vercel Serverless Architecture:**
   - Serverless REST API in `api/index.js` conforming to Vercel standards.
   - Zero-configuration deployment via `vercel.json`.
   - Standalone fallback mode in `server.js` with SQLite database.

2. **System ID & Facility Generator:**
   - Input your Roblox Game / Place ID (e.g. `75135033352863`).
   - Select either **Fire Alarm System** or **Security System**.
   - Generates a unique **Facility ID** (`FAC-XXXX`), **System ID** (`SYS-F-XXXXXX` / `SYS-S-XXXXXX`), and cryptographic **API Key**.
   - Outputs a ready-to-paste Luau configuration block with one-click copy.

3. **Facility Directory & Remote Blacklist Engine:**
   - Supervise all linked facilities across Roblox games.
   - Master account (`JordanDanielsGames`) has one-click Blacklist authority.
   - **Real-time lockout:** When blacklisted, the Roblox in-game systems cut off telemetry, lock the physical panel displays (`ACCESS REVOKED / FACILITY BLACKLISTED`), sound trouble alarms, and prohibit operator interaction.

4. **30-Day Audit Logging Engine:**
   - Rolling 30-day retention filter for all alarm activations, supervisory trips, troubles, restorals, and operator commands.
   - Filterable by `ALL`, `FIRE`, `SECURITY`, or `ADMIN`.

5. **Roblox Account Authentication with Biometric Safewords:**
   - Log in using your real Roblox account.
   - Portal generates a dynamic 3-word challenge (e.g. `apple cat fish 994`).
   - Verifies the user's Roblox profile bio in real-time via official Roblox Web APIs (`users.roblox.com`).
   - Master user `JordanDanielsGames` is automatically granted `MASTER_ADMIN` status.

6. **Two-Way Remote Controls:**
   - **Simplex 4100U Fire Controls:** 🔥 Acknowledge Alarm, 🔕 Silence NACs, 🔄 System Reset, 🚒 Evacuation Drill.
   - **Vista 20P Security Controls:** 🏃 Arm Away, 🏠 Arm Stay, 🔓 Disarm (Off), 🚨 Duress Panic.

7. **In-Game Web Monitoring Toggle:**
   - Players can toggle cloud telemetry synchronization on/off directly from Tab 3 of the in-game Simplex Annunciator HUD (`StarterGui.Simplex_AnnunciatorHUD`).

---

## 🌐 Deploying to Vercel

1. Push or fork this repository to GitHub:
   ```bash
   git remote add origin https://github.com/Jordan123456789097654/SafeLightLifeSystems.git
   git push -u origin main
   ```
2. Open [vercel.com](https://vercel.com) and click **"Add New Project"**.
3. Import the `SafeLightLifeSystems` GitHub repository.
4. Keep all build settings default (Framework Preset: **Other**, Root Directory: `./`).
5. Click **Deploy**. Your live central monitoring station will be active at `https://safelight-life-systems.vercel.app` (or your assigned Vercel URL).

---

## ⚙️ Roblox Studio Configuration

### Fire Alarm System (`ReplicatedStorage.Simplex_FireSystem.Simplex_Config`)
```lua
Config.WebCentralStation = {
    Enabled = true,                               -- Master In-Game Toggle
    PortalURL = "https://your-vercel-domain.vercel.app",
    FacilityID = "SIMP-4100-SL",                  -- Generated Facility ID
    SystemID = "SYS-F-111345",                    -- Unique System ID
    APIKey = "SL_SECURE_KEY_9941",                -- Security Key
    SyncInterval = 3,                             -- Heartbeat (seconds)
    RetentionDays = 30,                           -- Audit retention
}
```

### Security System (`ServerScriptService.SafeLightSecurity.SafeLight_AutomationDriver`)
```lua
local WebCentralStation = {
    Enabled = true,
    PortalURL = "https://your-vercel-domain.vercel.app",
    FacilityID = "SIMP-4100-SL",
    SystemID = "SYS-S-222789",
    APIKey = "SL_SECURE_KEY_9941",
    SyncInterval = 3
}
```

---

## 📡 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/system/create` | `POST` | Generates a new unique System ID, Facility ID, and API Key for a Roblox Place ID. |
| `/api/facilities` | `GET` | Returns list of all registered facilities, system status, and blacklist states. |
| `/api/facility/blacklist` | `POST` | Toggles blacklist state for a facility. Locks out in-game panels. |
| `/api/facility/sync` | `POST` | Roblox telemetry heartbeat. Returns pending web commands and blacklist state. |
| `/api/facility/log` | `POST` | Ingests alarms, troubles, and events into the 30-day retention database. |
| `/api/logs/:facilityId` | `GET` | Retrieves up to 30 days of audit logs (filterable by system). |
| `/api/status/:facilityId` | `GET` | Returns real-time health, fire alarms count, AC power, and security mode. |
| `/api/auth/start` | `POST` | Generates bio safewords challenge for a Roblox username. |
| `/api/auth/verify` | `POST` | Verifies user's Roblox profile description against challenge. |
| `/api/control` | `POST` | Queues remote operator commands for verified Roblox accounts. |

---

## 🛡️ Master Administrator
- **Master Account:** `JordanDanielsGames`
- **Role:** `MASTER_ADMIN`
- **Permissions:** Unrestricted Blacklist Authority, Remote Fire Panel Reset/Silence, Security Arm/Disarm.
