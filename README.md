# CARE-BRIDGE-APP
Here is the description at exactly 150 characters:  Post-discharge recovery app: nurses monitor patients at home, patients do daily check-ins, and warning signs trigger alerts. Phones and desktop ready.
<img width="192" height="192" alt="icon-192" src="https://github.com/user-attachments/assets/4aebc574-3ccf-4c01-92a2-7f721917c202" />
# CareBridge

Post-discharge recovery monitoring for hospitals and patients, built as an installable Progressive Web App (PWA).

After a patient goes home, they answer four yes/no questions each day. CareBridge scores the answers, flags risk, and puts the patients who need a call at the top of the nurse's list. Nurses make every clinical decision; the app only helps them prioritise.

<p align="center"><img src="icon-512.png" alt="CareBridge icon" width="128"></p>

## Project files

| File | Purpose |
| --- | --- |
| `index.html` | The whole front end: markup, CSS and JavaScript in one file, no build step or dependencies. |
| `manifest.webmanifest` | PWA manifest: name, theme colours, standalone display, icons. |
| `sw.js` | Service worker for offline fallback and installability. |
| `icon-512.png` | App icon (512×512, white cross on teal `#0E6B68`). |
| `icon-192.png` | **Missing.** Referenced by `index.html`, the manifest and the service worker. See [Before you deploy](#before-you-deploy). |

Expected layout, served from the site root:

```
/
├── index.html
├── manifest.webmanifest
├── sw.js
├── icon-192.png
├── icon-512.png
└── api/            ← your backend (not included here)
```

How it works

Roles
- **Nurse / staff** sign in with a Staff ID and PIN. They get three tabs: Patients, Alerts, Register. Staff with the `admin` flag can also create staff accounts.
- **Patient** signs in with a code (for example `CB-1001`) and PIN given at discharge. They get three tabs: Today, History, Messages.

Daily check-in
Patients answer four questions, stored as `a: { meds, sw, br, fv }` (booleans), plus an optional free-text note:

1. Took your medicine today? (`meds`)
2. New swelling in feet or legs? (`sw`)
3. Short of breath, or extra pillows to sleep? (`br`)
4. Fever or chills? (`fv`)

Risk rules
The client scores each check-in like this:

| Answer | Points |
| --- | --- |
| Missed medicine (`meds === false`) | 1 |
| Swelling | 2 |
| Short of breath | 3 |
| Fever | 2 |

- **Red (Urgent):** emergency flag (`em`) is set, or shortness of breath is reported, or the score is 4 or more.
- **Amber (Needs a call):** any other score above 0.
- **Green (On track):** score of 0.

Patients with no check-in show as "No check-in". The patient list sorts red, then amber, then no check-in, then green. Unacknowledged amber and red check-ins appear on the Alerts tab until a nurse acknowledges them.

To change the thresholds, edit the `risk()` function near the top of the script in `index.html`.

Backend API contract

The front end calls `/api/*` with `Content-Type: application/json` and, once signed in, `Authorization: Bearer <token>`. **The backend is not in this repo**, so you need to implement these endpoints. They are inferred from the client code.

| Method | Endpoint | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/login` | `{ role: "staff" \| "patient", id, pin }` | `{ token, role, user, admin, pid }` (`role` is `"nurse"` or `"patient"`) |
| POST | `/api/logout` | none | any |
| GET | `/api/patients` | none | array of patients (a patient sees only their own record) |
| POST | `/api/patients` | `{ name, age, phone, dx, ward, dd, meds }` | `{ pin, patient }` where `patient` includes `code` and `name` |
| POST | `/api/patients/:id/checkins` | `{ a: { meds, sw, br, fv }, note }` | any |
| POST | `/api/patients/:id/checkins/:index/ack` | none | any |
| POST | `/api/patients/:id/status` | `{ status: "monitoring" \| "closed" }` | any |
| POST | `/api/patients/:id/resetpin` | none | `{ pin }` |
| POST | `/api/patients/:id/log` | `{ text }` | any |
| POST | `/api/staff` | `{ id, name, pin }` | any (admin only) |

Patient objects are expected to look like:

```json
{
  "id": 1,
  "code": "CB-1001",
  "name": "Full Name",
  "age": "64",
  "phone": "+254...",
  "dx": "Heart failure",
  "ward": "Ward 3",
  "meds": "Medicines and instructions",
  "dd": "2026-10-20",
  "status": "monitoring",
  "checkins": [
    { "d": "2026-10-26", "t": "09:14", "a": { "meds": true, "sw": false, "br": false, "fv": false }, "note": "", "em": false, "ack": false }
  ],
  "log": [
    { "by": "Nurse Grace", "role": "nurse", "text": "Please come in on Friday.", "ts": "2026-10-26 09:30" }
  ]
}
```

Error handling the client expects:
- On failure, respond with a non-2xx status and `{ "error": "message" }`. The message is shown to the user.
- A `401` clears the session and shows "Session ended. Please sign in again."
- If the server is unreachable, the user sees "Cannot reach the server. Check your connection."

PWA details

- **Manifest:** `display: standalone`, portrait, `start_url` and `scope` of `/`, theme colour `#0E6B68`, background `#EEF3F2`. Both icons are marked `any maskable`.
- **Service worker:** registered from `index.html` at `/sw.js`.
  - On install it pre-caches `/`, `/manifest.webmanifest` and `/icon-192.png`.
  - Fetches are network-first. Successful responses are cached, and on failure the cached copy (or `/`) is served.
  - Non-GET requests and anything under `/api/` bypass the worker, so patient data is never cached by it.
  - Bump `C="carebridge-v1"` in `sw.js` whenever you ship a change you want clients to pick up cleanly. Old caches are deleted on activate.
- **Session:** the token and basic user info are kept in `localStorage` under `carebridge_session`. Nothing else is stored locally.
- **Theming:** light and dark colour schemes follow the device setting through CSS variables on `:root`.

Run locally

Service workers need `http://localhost` or HTTPS, and the app expects the API on the same origin, so serve everything from one server.

```bash
# Static files only (UI loads, sign-in fails until /api exists)
python3 -m http.server 8000
# open http://localhost:8000
```

For real development, run your backend so it serves these static files **and** handles `/api/*` on the same port, or put a reverse proxy in front of both.

To test installability, open the page in Chrome, then DevTools → Application → Manifest and Service Workers.

Before you deploy

1. **Add `icon-192.png`.** It is referenced in three places and not included. A missing file makes `addAll` fail during install, which stops the service worker from installing at all. Export a 192×192 version of `icon-512.png`, for example:
   ```bash
   convert icon-512.png -resize 192x192 icon-192.png
   ```
2. **Serve over HTTPS.** Required for service workers and install prompts (localhost is exempt).
3. **Implement the backend** from the API contract above, with real authentication, hashed PINs, rate limiting on `/api/login`, and role checks so patients can only read and write their own records.
4. **Protect patient data.** This is health information. Follow the data-protection rules that apply to your hospital and country (in Kenya, the Data Protection Act, 2019), and add audit logging and backups.
5. **Test the emergency path.** Confirm that red check-ins surface immediately for staff and that patients are told to seek emergency care for chest pain, fainting or trouble breathing.

Safety note

CareBridge is a decision-support and communication tool. It is not medical advice and does not replace a clinician. Warning signs must always be routed to a nurse.
{
  "name": "carebridge-server",
  "version": "0.1.0",
  "description": "CareBridge API and static file server (no npm dependencies)",
  "private": true,
  "license": "MIT",
  "main": "server.js",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node server.js",
    "test": "node --test",
    "backup": "node scripts/backup.js"
  }
## Server

`server.js` is a single-file Node.js server with **zero npm dependencies**. It serves the web app from `public/` and provides the JSON API under `/api/`. Requires Node.js 18 or newer.

### Run

```bash
ADMIN_PIN=choose-a-long-pin node server.js
```

Open http://localhost:3000 and sign in as **Staff** with ID `admin` and the PIN you set.

If `ADMIN_PIN` is not set, the server generates a random 6-digit PIN on first run and prints it once in the console. Save it then.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. Hosts such as Render set this for you. |
| `HOST` | `0.0.0.0` | Address to bind to. |
| `DATA_DIR` | `./data` | Folder for the database file (`db.json`). Point this at a persistent disk in production. |
| `TZ_NAME` | `Africa/Nairobi` | Time zone for check-in dates and times. |
| `ADMIN_PIN` | random | PIN for the first-run `admin` account. Used on first run only. |

### Folder layout

```
server.js        # API and static file server
public/          # index.html, manifest.webmanifest, sw.js, icons
data/db.json     # created on first run (do not commit)
```

### Data and security

- **Storage:** one JSON file, written atomically (temp file, then rename).
- **PINs:** hashed with scrypt and a per-user salt. They are never stored in plain text.
- **Sessions:** random 32-byte tokens, stored as SHA-256 hashes and valid for 12 hours.
- **Login limit:** 10 failed attempts per IP address in 10 minutes, then HTTP 429.
- **Roles:** patients can read and write only their own record. Staff can see all patients. Only the admin can create staff accounts.
- **Input:** request bodies are capped at 100 KB and text fields are length-limited.

### API

All endpoints except login need the header `Authorization: Bearer <token>`. Errors return `{ "error": "message" }`.

| Method | Endpoint | Who | Body | Result |
| --- | --- | --- | --- | --- |
| POST | `/api/login` | anyone | `{ role: "staff" \| "patient", id, pin }` | `{ token, role, user, admin, pid }` |
| POST | `/api/logout` | signed in | none | `{}` |
| GET | `/api/patients` | signed in | none | Staff get all patients; a patient gets their own record. |
| POST | `/api/patients` | staff | `{ name, dx, age, phone, ward, meds, dd }` | `{ patient, pin }`. `name` and `dx` are required. The PIN is shown once. |
| POST | `/api/patients/:id/checkins` | that patient | `{ a: { meds, sw, br, fv }, note }` | Updated patient |
| POST | `/api/patients/:id/checkins/:n/ack` | staff | none | Updated patient |
| POST | `/api/patients/:id/log` | staff or that patient | `{ text }` | Updated patient |
| POST | `/api/patients/:id/status` | staff | `{ status: "monitoring" \| "closed" }` | Updated patient |
| POST | `/api/patients/:id/resetpin` | staff | none | `{ pin }` |
| POST | `/api/staff` | admin | `{ id, name, pin }` | `{ ok: true }`. The ID needs 3-30 characters; the PIN needs 6 or more. |

### Risk flagging

A check-in is flagged **red (urgent)** when the note mentions an emergency phrase (such as "chest pain", "faint" or "kifua"), when the patient reports shortness of breath, or when the symptom score is 4 or more. Scores are: missed medicine 1, swelling 2, shortness of breath 3, fever 2. Anything else is not flagged. Nurses make every clinical decision.

### Deploying (for example on Render)

1. Put `server.js` and `public/` in the same folder, with `package.json` next to them.
2. Build command: `npm install`. Start command: `node server.js`.
3. Set `ADMIN_PIN`, and set `DATA_DIR` to a persistent disk path such as `/var/data`. Without a persistent disk, data is lost on every restart.
