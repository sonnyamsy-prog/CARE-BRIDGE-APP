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
