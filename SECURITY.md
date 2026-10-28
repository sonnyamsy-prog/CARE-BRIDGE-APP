# Security Policy

CareBridge handles sensitive patient health information, so we take security reports seriously. Thank you for helping keep patients and clinicians safe.

## Supported versions

Only the latest release on the `main` branch receives security fixes.

| Version | Supported |
|---|---|
| Latest (`main`) | Yes |
| Older releases | No |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for security problems.**

Report privately by either of these routes:

1. **Email:** `security@YOUR-DOMAIN` (replace with your real address before publishing)
2. **GitHub:** use the repository's **Security → Report a vulnerability** button (private advisory), if enabled

Please include:

- A description of the issue and its potential impact
- Steps to reproduce, or a proof of concept
- The affected route or file (for example `/api/login` or `public/sw.js`)
- Your browser, device and app version, if relevant

**Never include real patient data in a report.** Use made-up test records only.

## What to expect

| Step | Target time |
|---|---|
| Acknowledge your report | 3 business days |
| Initial assessment and severity rating | 7 days |
| Fix or mitigation for critical and high issues | 30 days |
| Public disclosure, after a fix is available | Coordinated with you |

We will keep you updated and credit you in the release notes if you wish. We do not currently offer a paid bounty.

## Scope

**In scope**

- Authentication and session handling (patient code and PIN login, staff login, Bearer tokens)
- Access control: a patient reading another patient's record, a nurse acting outside their role, or a non-owner creating staff accounts
- Injection and cross-site scripting (XSS) in `index.html` and the `/api/*` routes
- Service worker caching of private data (`sw.js` must never cache `/api/` responses)
- Exposure of patient data through logs, errors, backups or storage
- Weak PIN handling, such as plain-text storage, missing rate limiting or guessable PINs

**Out of scope**

- Attacks that need physical access to an unlocked device
- Social engineering of staff or patients
- Denial-of-service through sheer traffic volume
- Missing security headers with no demonstrated impact
- Vulnerabilities in third-party services or browsers
- Issues in unsupported versions

## Safe harbour

If you act in good faith, follow this policy, avoid privacy violations and service disruption, and give us reasonable time to fix the issue before disclosure, we will not pursue legal action against you.

## Security practices for deployers

If you host CareBridge, you are responsible for protecting your patients' data. At a minimum:

- [ ] Serve everything over **HTTPS** only
- [ ] **Hash** PINs (for example with bcrypt or Argon2); never store them in plain text
- [ ] **Rate-limit** `/api/login` and lock accounts after repeated failures
- [ ] Use long, random, expiring session tokens and invalidate them on logout
- [ ] Enforce server-side checks so each patient can only see their own record
- [ ] Restrict `POST /api/staff` to the owner account
- [ ] Never cache `/api/` responses (already enforced in `sw.js`) and send `Cache-Control: no-store` on API replies
- [ ] Send `Cache-Control: no-cache` for `sw.js` so updates reach users
- [ ] Add a Content-Security-Policy and other standard security headers
- [ ] Encrypt backups and keep access logs for staff actions
- [ ] Change all demo and default credentials before going live
- [ ] Follow your country's data-protection law (for example Kenya's Data Protection Act, 2019) and your hospital's policies

## Data breach response

If you believe patient data has been exposed, notify the hospital's data protection officer immediately and report it to us using the channels above. Affected organisations may have legal duties to notify regulators and patients within strict deadlines.

## Medical disclaimer

CareBridge supports clinicians and does not replace them. A security issue that could cause a missed or hidden urgent alert is treated as **high severity**, because it can affect patient safety.
