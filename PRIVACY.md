# Privacy and Data Protection Notes

CareBridge stores **health information**, which most data-protection laws treat as sensitive personal data. This document explains what the software stores and what the organisation running it must do. **It is a practical guide, not legal advice.** Check your obligations with a lawyer or your data protection regulator.

## What CareBridge stores

| Data | Where | Notes |
|---|---|---|
| Patient name, age, phone, diagnosis, ward, medicines, discharge date | `db.json` in `DATA_DIR`, or the PostgreSQL database if `DATABASE_URL` is set | Entered by nurses at registration |
| Daily check-in answers and free-text notes | `db.json` | Sent by the patient |
| Messages between nurse and patient | `db.json` | |
| Patient and staff PINs | `db.json` | Stored only as salted scrypt hashes; patient PINs are shown once at registration or reset |
| Audit log (who did what, when) | `audit.log` | Records actions and record IDs, never PINs or message text |
| Sign-in session | Browser `localStorage` (token, role, name) | Tokens expire after `SESSION_HOURS` |
| Cached app files | Browser cache via the service worker | `/api/` responses are never cached |

CareBridge sends no data to third parties, loads no external scripts or fonts, and has no analytics or advertising.

## SMS and push alerts

If you turn on SMS, phone numbers are sent to your SMS provider (Africa's Talking) to deliver messages. SMS texts contain only a patient code, never a name or health details. Push notifications carry no content. Only register a phone number for patients who agreed to receive SMS.

## Responsibilities of the hospital or clinic running it

You decide why and how patient data is used, so you are normally the **data controller**. In Kenya, the Data Protection Act, 2019 and the Office of the Data Protection Commissioner (ODPC) set the rules; check current requirements for registration, lawful basis, and breach reporting.

Before going live, make sure you have:

- [ ] A **lawful basis** for processing, and informed **consent** from patients (or their caregivers) for remote monitoring, explained in plain language and in a language they understand
- [ ] **Registration** with the data protection regulator, if required for your organisation
- [ ] A written **retention rule**: how long records are kept after monitoring ends, and how they are deleted
- [ ] A process for **patient rights**: access, correction and deletion requests
- [ ] **Role-based access**: only staff who need records get a staff account; remove accounts when people leave
- [ ] A **breach response plan**, including who to notify and the regulator's reporting deadline (the Kenyan Act sets a short deadline; confirm the current one)
- [ ] An agreement with any hosting provider that processes the data on your behalf
- [ ] Encrypted disks and backups, HTTPS only, and regular reviews of `audit.log`

## Technical safeguards in the software

- PINs are hashed (scrypt); sign-in is throttled and locks after repeated failures
- Patients can read only their own record; the server enforces this
- Only the owner can create nurse accounts
- Security headers (CSP, no framing, no sniffing) and `no-store` on API responses
- An audit log of sign-ins, registrations, check-ins, alert acknowledgements, messages, status changes and PIN resets

## What it does not do yet

- No encryption of `db.json` at rest (use full-disk encryption)
- No automatic deletion after a retention period
- No built-in patient data export or deletion tool
- Sessions are held in memory, so a restart signs everyone out
- Messages are not end-to-end encrypted; staff and the server can read them

## Using real patient data

Do not use real patient data in testing, demos, screenshots or bug reports. Use made-up records only.

## Contact

Data protection contact for this deployment: **privacy@YOUR-DOMAIN** (replace with the real contact of the organisation running CareBridge).
