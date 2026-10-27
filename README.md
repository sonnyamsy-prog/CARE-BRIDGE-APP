<p align="center">
  <img src="public/icon-512.png" alt="CareBridge icon" width="120">
</p>

<h1 align="center">CareBridge</h1>

<p align="center">Post-discharge recovery monitoring for hospitals and patients.<br>An installable, offline-tolerant Progressive Web App (PWA).</p>

---

## What it does

- **Patients** sign in with a code and PIN and answer four daily yes/no questions: medicine taken, swelling, breathlessness, fever. They can add a free-text note and message their nurse.
- **Nurses** register discharged patients, see a risk-sorted patient list, review and acknowledge alerts, reply to messages, reset PINs and close monitoring.
- **Owner/admin** can also create nurse (staff) accounts.
- Warning signs (for example "chest pain" or "faint" in a note) raise an urgent alert. Nurses make every clinical decision; the app only flags and routes.

## Project structure

```
carebridge/
├── public/
│   ├── index.html            # Single-file UI (HTML + CSS + JS, no build step)
│   ├── manifest.webmanifest  # PWA manifest (name, colors, icons, standalone display)
│   ├── sw.js                 # Service worker (network-first, cache fallback)
│   ├── icon-192.png          # PWA icon 192x192 (also favicon / apple-touch-icon)
│   └── icon-512.png          # PWA icon 512x512
├── server/                   # Backend serving /api/* (not included yet)
└── README.md
```

## Files explained

| File | Role |
|---|---|
| `index.html` | The whole front end. Talks to the backend through `fetch("/api/...")` with a Bearer token. Stores only the session (`token`, `role`, `user`, `admin`, `pid`) in `localStorage`. Registers the service worker on load. |
| `manifest.webmanifest` | Makes the app installable. `display: standalone`, portrait, theme `#0E6B68`, background `#EEF3F2`, icons marked `any maskable`. |
| `sw.js` | Cache name `carebridge-v1`. Precaches `/`, the manifest and `icon-192.png`. For GET requests it tries the network first, updates the cache, and falls back to cache (then `/`) when offline. Requests to `/api/` are never cached. |
| `icon-512.png` / `icon-192.png` | White cross on teal (`#0E6B68`). Both are referenced by the manifest. |

## API contract used by the front end

All routes are under `/api`, JSON in and out, `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/login` | Body `{role: "staff"\|"patient", id, pin}`; returns `{token, role, user, admin, pid}` |
| POST | `/logout` | End session |
| GET | `/patients` | List patients (staff: all, patient: own record) |
| POST | `/patients` | Register a patient; returns generated `code` and `pin` |
| POST | `/patients/:id/checkins` | Submit daily check-in `{a, note}` |
| POST | `/patients/:id/checkins/:i/ack` | Acknowledge an alert |
| POST | `/patients/:id/log` | Add a message `{text}` |
| POST | `/patients/:id/status` | Set `monitoring` or `closed` |
| POST | `/patients/:id/resetpin` | Issue a new PIN |
| POST | `/staff` | Create a nurse account `{id, name, pin}` (owner only) |

## Run locally

PWAs and service workers need **HTTP(S) from the site root**, not `file://`.

1. Start the backend so it serves `public/` at `/` and handles `/api/*`.
2. Open `http://localhost:<port>/`.
3. In Chrome DevTools, use **Application → Manifest** to check installability and **Application → Service Workers** to test offline mode.

To change cached files, bump `C` in `sw.js` (for example `carebridge-v2`) so old caches are removed on activate.

## Dependencies

**Front end (`public/`): none.** There are no npm packages, frameworks, CDN scripts, web fonts or other external requests. Everything is served from your own origin, so there is nothing to patch and patient devices never contact a third party.

**Back end (`server/`):** add your runtime and packages here once the server code is in the repo. Keep the list short and commit the lockfile.

| Item | Version | Purpose |
|---|---|---|
| Runtime (Node.js / Python / other) | _fill in_ | Runs the API |
| Web framework | _fill in_ | Routing for `/api/*` |
| PIN hashing (bcrypt or Argon2) | _fill in_ | Stores PINs safely |
| Database driver | _fill in_ | Patient and staff data |

**Install**

```bash
cd server
npm ci          # Node: installs exactly what package-lock.json lists
# or: pip install -r requirements.txt
```

**Keeping dependencies safe**

- Commit `package-lock.json` (or a pinned `requirements.txt`) so installs are repeatable.
- Dependabot is configured in `.github/dependabot.yml` and opens pull requests for security and version updates weekly.
- Run `npm audit` (or `pip-audit`) before each release and apply security fixes promptly.
- Do not add a package for something small; every dependency is code you trust with patient data.

## Deploy checklist

- [ ] Serve over HTTPS
- [ ] Serve `public/` from `/` (manifest `start_url` and `scope` are `/`)
- [ ] Confirm `icon-192.png` is deployed (the manifest and service worker reference it)
- [ ] Send `Cache-Control: no-cache` for `sw.js`
- [ ] Rate-limit `/api/login` and store PINs hashed
- [ ] Set up backups for patient data

## Safety and privacy

CareBridge supports clinicians and does not replace them. Patient health data is sensitive: use HTTPS, hashed PINs, access logging, and follow your hospital's and your country's data-protection rules (for example Kenya's Data Protection Act, 2019).

## Roadmap

- SMS and voice check-ins (including Swahili)
- Hospital-specific care plans
- Push notifications for urgent alerts
const express = require("express");
const Organization = require("../models/Organization");
const User = require("../models/User");
const auth = require("../middleware/auth"); // your existing auth middleware
const orgAdmin = require("../middleware/orgAdmin");

const router = express.Router();
router.use(auth);

// Create an organization. The creator becomes its first admin.
router.post("/", async (req, res, next) => {
  try {
    const { name, type, email, phone, address } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Organization name is required." });
    }

    const org = await Organization.create({
      name, type, email, phone, address,
      createdBy: req.user.id,
      members: [{ user: req.user.id, role: "admin" }],
    });

    await User.findByIdAndUpdate(req.user.id, { $addToSet: { organizations: org._id } });
    res.status(201).json(org);
  } catch (err) {
    next(err);
  }
});

// List organizations the signed-in user belongs to.
router.get("/mine", async (req, res, next) => {
  try {
    const orgs = await Organization.find({ "members.user": req.user.id }).sort({ name: 1 });
    res.json(orgs);
  } catch (err) {
    next(err);
  }
});

// Join an organization with its invite code.
router.post("/join", async (req, res, next) => {
  try {
    const code = (req.body.inviteCode || "").trim().toUpperCase();
    const org = await Organization.findOne({ inviteCode: code });
    if (!org) return res.status(404).json({ message: "That invite code isn't valid." });

    if (org.members.some((m) => m.user.toString() === req.user.id)) {
      return res.status(409).json({ message: "You're already a member of this organization." });
    }

    org.members.push({ user: req.user.id, role: "member" });
    await org.save();
    await User.findByIdAndUpdate(req.user.id, { $addToSet: { organizations: org._id } });
    res.json(org);
  } catch (err) {
    next(err);
  }
});

// Admin: add an existing user by email.
router.post("/:id/members", orgAdmin, async (req, res, next) => {
  try {
    const user = await User.findOne({ email: (req.body.email || "").toLowerCase() });
    if (!user) return res.status(404).json({ message: "No user found with that email." });

    if (req.org.members.some((m) => m.user.equals(user._id))) {
      return res.status(409).json({ message: "That person is already a member." });
    }

    req.org.members.push({ user: user._id, role: req.body.role === "admin" ? "admin" : "member" });
    await req.org.save();
    await User.findByIdAndUpdate(user._id, { $addToSet: { organizations: req.org._id } });
    res.status(201).json(req.org);
  } catch (err) {
    next(err);
  }
});

// Admin: change a member's role.
router.patch("/:id/members/:userId", orgAdmin, async (req, res, next) => {
  try {
    const member = req.org.members.find((m) => m.user.toString() === req.params.userId);
    if (!member) return res.status(404).json({ message: "Member not found." });

    const admins = req.org.members.filter((m) => m.role === "admin");
    if (member.role === "admin" && req.body.role === "member" && admins.length === 1) {
      return res.status(400).json({ message: "An organization needs at least one admin." });
    }

    member.role = req.body.role === "admin" ? "admin" : "member";
    await req.org.save();
    res.json(req.org);
  } catch (err) {
    next(err);
  }
});

// Admin: remove a member.
router.delete("/:id/members/:userId", orgAdmin, async (req, res, next) => {
  try {
    const target = req.org.members.find((m) => m.user.toString() === req.params.userId);
    if (!target) return res.status(404).json({ message: "Member not found." });

    const admins = req.org.members.filter((m) => m.role === "admin");
    if (target.role === "admin" && admins.length === 1) {
      return res.status(400).json({ message: "You can't remove the only admin." });
    }

    req.org.members = req.org.members.filter((m) => m.user.toString() !== req.params.userId);
    await req.org.save();
    await User.findByIdAndUpdate(req.params.userId, { $pull: { organizations: req.org._id } });
    res.json(req.org);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
