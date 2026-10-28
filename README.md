<p align="center">
  <img src="public/icon-512.png" alt="CareBridge icon" width="120">
</p>

<h1 align="center">CareBridge</h1>

<p align="center">Post-discharge recovery monitoring for hospitals and patients.<br>An installable, offline-tolerant Progressive Web App (PWA).</p>

---

## What it does

- **Patients** sign in with a code and PIN and answer four daily yes/no questions: medicine taken, swelling, breathlessness, fever. They can add a free-text note and message their nurse.
- **Nurses** register discharged patients, see a risk-sorted patient list, review and acknowledge alerts, reply to messages, reset PINs and close monitoring.
- **Owner/admin** can also create nurse (staff) accounts and **organizations** (hospitals or clinics).
- **Organizations** sign in with an organization code (for example `ORG-K7M3QX`) and a PIN. They add their own nurses and see an overview of their patients. Nurses an organization adds only see that organization's patients.
- Warning signs (for example "chest pain" or "faint" in a note) raise an urgent alert. Nurses make every clinical decision; the app only flags and routes.

## Project structure

```
carebridge/
├── public/                    # Front end, served at /
│   ├── index.html             # Single-file UI (HTML + CSS + JS, no build step)
│   ├── manifest.webmanifest   # PWA manifest
│   ├── sw.js                  # Service worker (network-first, cache fallback)
│   ├── icon-192.png
│   └── icon-512.png
├── server/                    # Back end: Node.js (one npm package, pg, only for PostgreSQL)
│   ├── server.js              # API + static file server
│   ├── lib/risk.js            # Risk rules and emergency-phrase detection
│   ├── lib/auth.js            # PIN hashing, sessions, login throttling
│   ├── lib/store.js           # JSON-file storage and audit log
│   ├── scripts/backup.js      # npm run backup
│   └── test/                  # node:test suites
├── .github/                   # CI workflow, Dependabot, issue and PR templates
├── .env.example               # Configuration reference
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  PRIVACY.md  LICENSE
└── README.md
```

## Quick start

You need **Node.js 20 or newer**. To run with the default file storage there is nothing to install. To use PostgreSQL, run `npm install` once in the `server` folder.

```bash
cd server
OWNER_ID=owner OWNER_PIN=choose-a-long-pin npm start
```

Open http://localhost:3000 and sign in as **Staff** with the owner ID and PIN. The owner account is created on the first run only. Then:

1. Create an organization in the **Orgs** tab (owner only). You get an organization code and a one-time 6-digit PIN to give to the hospital. It signs in under **Organization** and adds its own nurses. (You can also create nurse accounts yourself in the **Staff** tab; those nurses are not tied to an organization.)
2. Register a discharged patient in **Register**. You get a patient code and a one-time 6-digit PIN to give to the patient.
3. The patient signs in with that code and PIN and does the daily check-in.

Run the tests with `npm test`. See `.env.example` for all settings (port, data folder, time zone, proxy, HSTS).

## How risk is flagged

| Answer | Points |
|---|---|
| Did not take medicine | 1 |
| New swelling | 2 |
| Fever or chills | 2 |
| Short of breath | 3 |

A check-in is **Urgent (red)** if the patient reports shortness of breath, writes an emergency phrase (such as "chest pain" or "kuzimia"), or scores 4 or more. It is **Needs a call (amber)** with any other warning sign, and **On track (green)** with none. These rules only flag; nurses make every clinical decision. The rules live in `server/lib/risk.js` and in `public/index.html`, and a test keeps both identical. Have a clinician review them before real use.

## API

All routes are under `/api`, JSON in and out, with `Authorization: Bearer <token>`. Errors return `{ "error": "message" }`.

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | `/login` | anyone | `{role: "staff"\|"patient"\|"org", id, pin}` returns `{token, role, user, admin, pid}`. For `org`, `id` is the organization code |
| POST | `/logout` | signed in | End the session |
| GET | `/patients` | staff: all; patient: own record | List patients |
| POST | `/patients` | staff | Register a patient; returns `{pin, patient}` (PIN shown once) |
| POST | `/patients/:id/checkins` | that patient | Daily check-in `{a: {meds, sw, br, fv}, note}` |
| POST | `/patients/:id/checkins/:i/ack` | staff | Acknowledge an alert |
| POST | `/patients/:id/log` | staff or that patient | Send a message `{text}` |
| POST | `/patients/:id/status` | staff | `monitoring` or `closed` |
| POST | `/patients/:id/resetpin` | staff | New PIN; the old PIN and its sessions stop working |
| POST | `/staff` | owner or organization | Create a nurse `{id, name, pin}` (PIN 6+ characters). An organization's nurses belong to it |
| GET | `/staff` | owner or organization | List nurses (an organization sees only its own) |
| POST | `/orgs` | owner | Create an organization `{name}`; returns `{pin, org: {id, code, name}}` (PIN shown once) |
| GET | `/orgs` | owner | List organizations with patient and nurse counts |
| POST | `/orgs/:id/resetpin` | owner | New organization PIN; the old PIN and its sessions stop working |

## SMS and push alerts

Urgent check-ins can alert nurses and organizations by push notification and by SMS, and patients can get a daily SMS reminder. The code is in `server/sms-push/` and everything is off until you add the settings listed in `.env.example`. See `server/sms-push/README.md` for setup.

## Organizations and storage

Organizations are stored in `db.json` (in `DATA_DIR`) next to patients and staff, as `{ id, code, name, pin (hashed), createdAt }`. Organization PINs are hashed with the same scrypt scheme as every other PIN, and the code and PIN of a new organization are shown only once. Staff and patients created under an organization carry its `orgId`. Older `db.json` files are upgraded automatically on start: an empty `orgs` list is added and existing patients and nurses keep working. An organization can see each patient's name, diagnosis and latest risk status, but not their messages or full check-in history. Organization actions are written to `audit.log` (`org_created`, `org_pin_reset`, `login`).

## Dependencies

**One:** `pg`, the standard PostgreSQL driver, used only when `DATABASE_URL` is set. Everything else uses Node.js built-in modules, and the front end has no scripts, fonts or external requests. Keep Node and `pg` up to date; Dependabot and `npm audit` in CI will alert you to problems.

## Deploy on Render

1. Push this project to GitHub with the folders exactly as shown above. `server/package.json` must exist in the repo (check on github.com before deploying).
2. In Render choose **New → Web Service** and connect the repo.
3. Use these settings:

| Setting | Value |
|---|---|
| Language | **Node** |
| Branch | `main` |
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `npm start` |

4. Add environment variables: `OWNER_ID`, `OWNER_PIN` (a long, unique PIN), `TZ_NAME` (for example `Africa/Nairobi`), `TRUST_PROXY=1` and `HSTS=1`. Render supplies `PORT` itself.
5. Click **Create Web Service**. When the build finishes, open the URL Render gives you and sign in as **Staff** with your owner ID and PIN.

**Keep your data:** on Render's free plan the disk is wiped on every restart, spin-down or redeploy, which would delete all patients and check-ins. Use PostgreSQL (below), or a paid plan with a persistent disk mounted at `/var/data` and `DATA_DIR=/var/data`.

## Storage: PostgreSQL (recommended for real use)

Set `DATABASE_URL` and CareBridge stores everything in PostgreSQL instead of `db.json`. Nothing else changes. Tables are created automatically on first start.

- **How it saves:** each patient, nurse, organization and push subscription is one row. Each change is written in one transaction, and the app says "saved" only after the database has committed it. If the database is down, the user sees "Could not save your changes. Please try again." and the app keeps retrying in the background. The audit log goes to the `cb_audit` table.
- **Run one copy of the server.** Data is also held in memory for speed, so two copies would not see each other's changes.
- **Moving old data:** `DATABASE_URL=... npm run import:pg -- ./data` copies `db.json` and `audit.log` into an empty database. It refuses to overwrite existing data.
- **Backups:** `DATABASE_URL=... npm run backup:pg` writes `db.json` and `audit.log` files you can encrypt and keep off-site. You can also use your database provider's own backups.
- **SSL:** connections to a database on another host are encrypted. `DATABASE_SSL=verify` also checks the server certificate; `DATABASE_SSL=0` turns SSL off.
- **Free databases expire.** Render's free Postgres is deleted 30 days after creation and has no backups. Use a paid database for real patients.

**Common build errors**

| Error | Cause and fix |
|---|---|
| `Root directory "server" does not exist` | The `server/` folder is not on GitHub. Upload it, then redeploy. |
| `Could not read package.json` at `/src/package.json` | Root Directory is empty or wrong. Set it to `server`. |
| `go build` or `Using Go version` in the log | The service was created with the wrong Language. Create a new service with **Node**. |

## Run in production

- [ ] Run behind HTTPS (for example Caddy or Nginx) and set `HSTS=1` and, if behind a proxy, `TRUST_PROXY=1`
- [ ] Use PostgreSQL (`DATABASE_URL`) on a paid plan with backups on, or set `DATA_DIR` to an encrypted disk outside the repo. Schedule `npm run backup` (or `npm run backup:pg`) with encrypted off-site copies
- [ ] Use a long, unique `OWNER_PIN`, then remove it from the environment after the first run
- [ ] Keep Node.js updated; run the server as a non-root user
- [ ] Review `audit.log` regularly
- [ ] Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) and complete their checklists

The JSON-file storage suits a pilot or a single clinic. Move to a proper database before wider use.

## Safety and privacy

CareBridge supports clinicians and does not replace them. Patient health data is sensitive: use HTTPS, hashed PINs, access logging, and follow your hospital's and your country's data-protection rules (for example Kenya's Data Protection Act, 2019).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Roadmap

- Swahili in the main app (the demo already has it)
- SMS and voice check-ins for patients without smartphones
- Hospital-specific care plans
- Push notifications for urgent alerts
- Patient data export and automatic deletion after the retention period
- A real database for larger deployments

## License

[MIT](LICENSE)
