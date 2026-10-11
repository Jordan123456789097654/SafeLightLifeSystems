# SafeLight Central Station

Cloud monitoring portal for the SafeLight Simplex 4100U fire alarm and Vista 20P security systems in Roblox.

## How it works
1. Sign up / sign in on the website (stays signed in for 30 days via a secure cookie).
2. **Create a facility** (name + Roblox Place ID). You get a **Facility API key**.
3. Add your first system (Fire or Security). You get a **System ID** (`F-123456` / `S-123456`).
4. Paste into `Simplex_Config.WebCentralStation` in Roblox:
```lua
WebCentralStation = {
    SystemID = "F-123456",          -- fire system
    SecuritySystemID = "S-123456",  -- security system (optional)
    APIKey = "SLK_...",             -- facility API key
}
```
The portal URL is **not** in any config. It lives (XOR-encoded) in the server-only `SafeLight_Link` ModuleScript in ServerScriptService, which both scripts use. After you know your Vercel domain run `node tools/encode-url.js https://your-app.vercel.app` and paste the printed `_d` table into `SafeLight_Link`. (Obfuscation only deters casual reading; real security is the server-side API key checks.)

## Team access & alerts
Owners/managers can add registered users as Viewer (monitor), Operator (+ remote controls) or Manager (+ systems, key, team), and set a Discord webhook for alarm/trouble/restore alerts. Logs export to CSV.

## Device API security (v1)
Roblox requests carry a timestamp + unique nonce (replay protection, 2-minute window), are rate limited, and the key is compared in constant time. Web API has login/signup rate limits, origin checks and per-user limits. Errors return `{error, code, requestId}`.

## Deploy on Vercel
1. Import this repo in Vercel (framework: Other).
2. **Add storage** (Storage tab -> Upstash Redis). This sets `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`). Without it, data lives in memory and is lost on cold starts.
3. Optional env var `ADMIN_USERNAME` (default `JordanDanielsGames`): that account can see all facilities and blacklist them. **Sign up with that name first.**
4. In Roblox: Game Settings -> Security -> enable *Allow HTTP Requests*.

## Local dev
`npm install && npm start` -> http://localhost:3000 (in-memory storage).

## API
- Web (cookie auth): `/api/auth/{signup,login,logout,me}`, `/api/facilities[/:id[/systems|logs|control|blacklist|regenerate-key]]`
- Roblox (API key auth): `POST /api/device/sync`, `POST /api/device/log`
