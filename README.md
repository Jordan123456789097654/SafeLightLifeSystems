# SafeLight Central Station

Cloud monitoring portal for the SafeLight Simplex 4100U fire alarm, commercial sprinkler riser, and Vista 20P security systems in Roblox.

Live portal: https://safe-light-life-systems.vercel.app/

---

## Supported Life Safety Systems

### 1. 🔥 Fire Alarm System (`FIRE` / `F-XXXXXX`)
* **Simplex 4100U Life Safety Master System**
* Real-time transponder telemetry: Status (`NORMAL`, `ALARM`, `SILENCED`, `TROUBLE`, `SUPERVISORY`), Active alarms, AC power / 24V battery status.
* Remote controls: Fire Ack, Horn Silence, System Reset, Evacuation Drill, Lamp Test, Walk-Test.
* Digital Voice Evacuation: Evac Message, All-Clear, Standby, Severe Weather (WX).
* Mass Notification: Federal Signal Thunderbolt 1003A Siren (Alert, Attack, Hi-Lo Pulse, Growl Test, Cancel).
* Motorized Fire Shutters: Remote deploy / retract.
* Sprinkler Interlink: Flow Switch Test, Ack, Reset, Drain, Refill (inhibited if panel sync is disabled in game).

### 2. 🌊 Commercial Sprinkler System (`SPRINKLER` / `SP-XXXXXX`)
* **Wet Pipe Main Riser & Waterflow Monitoring System**
* Real-time hydraulic telemetry: Static water pressure (`PSI`), active flowing heads count, and main riser charge status (`CHARGED` vs `DRAINED`).
* Riser controls: Flow Switch Test, Acknowledge Alarm, System Reset, Drain Main Riser (2" main drain), Refill City Water (municipal main).
* OS&Y Valve Supervision: Supervisory tamper toggles for OS&Y valves #1 through #5.
* 5-second thermal fire particle burst threshold.

### 3. 🛡️ Security System (`SECURITY` / `S-XXXXXX`)
* **Ademco / Honeywell Vista 20P Commercial Intrusion System**
* Real-time partition telemetry: Arming status (`ARMED_AWAY`, `ARMED_STAY`, `DISARMED`), Alarmed zones.
* Remote controls: Arm Away, Arm Stay, Disarm, Chime Toggle.
* Emergency Panics: Police Panic, Fire Panic, Medical Emergency.

---

## Setup & Roblox Configuration

1. Sign up or log in at [SafeLight Central Station](https://safe-light-life-systems.vercel.app/).
2. **Create a facility** (Facility Name + Roblox Game / Place ID). You will receive a **Facility API Key** (`SLK_...`).
3. Add your systems using the **+ Add System** wizard:
   * **Fire alarm** -> generates System ID `F-XXXXXX`
   * **Sprinkler** -> generates System ID `SP-XXXXXX`
   * **Security** -> generates System ID `S-XXXXXX`
4. Paste credentials into your Roblox config scripts:

### For Simplex 4100U (`ReplicatedStorage.Simplex_FireSystem.Simplex_Config`):
```lua
WebCentralStation = {
    Enabled = true,
    SystemID = "F-XXXXXX",
    APIKey = "SLK_XXXXXX",
}
```

### For Sprinkler System (`ReplicatedStorage.Sprinkler_System.Sprinkler_Config`):
```lua
WebCentralStation = {
    Enabled = true,
    SprinklerSystemID = "SP-XXXXXX",
    APIKey = "SLK_XXXXXX",
    PollInterval = 3.0,
}
```

### For Security System (`ReplicatedStorage.SafeLightSecurity.Security_Config`):
```lua
WebCentralStation = {
    Enabled = true,
    SecuritySystemID = "S-XXXXXX",
    APIKey = "SLK_XXXXXX",
}
```

---

## Team Roles & Permissions
* **Viewer:** Read-only telemetry monitoring and event log access.
* **Operator:** Telemetry monitoring + remote control button execution.
* **Manager:** + Add/remove systems, rotate API keys, configure Discord webhook, manage team members.
* **Owner:** Full ownership, delete facility, transfer permissions.

---

## Discord Webhook Alerts
Connect a Discord webhook URL in your facility settings. Real-time embeds are delivered for:
* Active Fire Alarms & Waterflow trips
* OS&Y valve tamper & supervisory signals
* AC power loss / battery backup failovers
* Intrusion alarms & panic buttons
* Remote operator commands & restoral confirmations

---

## Vercel Deployment & Database Persistence
1. Fork or import repository to Vercel (Preset: Other).
2. Connect **Upstash Redis** under **Storage** -> **Connect Database** -> **Upstash Redis**.
3. Set optional environment variable `ADMIN_USERNAME` (default `JordanDanielsGames`).
4. In Roblox Studio: **Home** -> **Game Settings** -> **Security** -> Enable **Allow HTTP Requests**.
