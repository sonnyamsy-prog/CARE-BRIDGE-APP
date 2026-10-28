# Contributing to CareBridge

Thanks for helping. CareBridge supports post-discharge care, so small mistakes can affect patients. Please read this before opening a pull request.

## Ground rules

- **Never post real patient data**, anywhere: issues, pull requests, screenshots, logs or tests. Use made-up names and numbers.
- **Security problems go to [SECURITY.md](SECURITY.md)**, not to public issues.
- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Nurses make every clinical decision. Changes to the risk rules need a clear reason and, ideally, review by a clinician.

## Set up

You need Node.js 20 or newer. The only npm dependency is `pg`, used for PostgreSQL. Run `npm install` in `server` if you want to run the Postgres tests (set `TEST_DATABASE_URL` to an empty test database; they are skipped otherwise).

```bash
cd server
OWNER_ID=owner OWNER_PIN=choose-a-long-pin npm start   # then open http://localhost:3000
npm test                                                # run all tests
```

The owner account is created on the first run. Data is stored in `server/data/` (ignored by git).

## Making a change

1. Fork the repo and create a branch: `git checkout -b fix-short-description`.
2. Make a focused change. One topic per pull request.
3. Add or update tests in `server/test/`. Fixing a bug? Add a test that fails without your fix.
4. Run `npm test` in `server/` and make sure everything passes.
5. Open a pull request and fill in the template.

## Code guidelines

- **Keep dependencies at zero where possible.** Every package is code we trust with patient data. If you must add one, explain why in the pull request.
- **The risk rules live in two places:** `server/lib/risk.js` and `risk()` in `public/index.html`. Change both. A test fails if they drift apart.
- Check access on the server. Never rely on the front end hiding a button.
- Never log or return PINs, tokens or hashes. The audit log records who did what, not secrets.
- Escape all text shown in the UI (use the existing `esc()` helper).
- Keep `public/` buildless: plain HTML, CSS and JavaScript.
- If you change a file that the service worker caches, bump the cache name in `public/sw.js`.

## Reporting bugs and suggesting features

Use the issue templates. For a bug, include steps to reproduce, what you expected, what happened, and your device and browser.
