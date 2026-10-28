# SMS and push alerts

This folder adds two kinds of alerts to CareBridge. Both are optional and use only Node's
built-in modules (no new packages). Nothing is sent until you configure it.

| File | What it does |
|---|---|
| `index.js` | Decides who is alerted and when. `server.js` calls it after every check-in. |
| `sms.js` | Sends SMS through Africa's Talking. Cleans phone numbers (0712 345 678 becomes +254712345678). |
| `push.js` | Sends web push notifications to nurses' and organizations' devices (VAPID, no payload). |
| `generate-keys.js` | Creates your push keys. Run once. |

## What triggers an alert

An **urgent check-in** (a red result: trouble breathing, an emergency word in the note, or a high score) sends:

- **Push** to the owner, the nurses of the patient's organization, and that organization. Not to other organizations.
- **SMS** to the organization's *alert phone* (set when the owner creates the organization). If the patient has no organization, or the organization has no alert phone, the SMS goes to the numbers in `ALERT_SMS_TO`.
- At most **one SMS per patient every 30 minutes**, so repeated check-ins do not cost you money.

**Privacy by design:** the SMS contains only the patient code (for example "CB-1004"), never a name or health details. The push notification has no content at all; the app shows a generic "urgent check-in" message, so nothing about a patient passes through the browser vendor's push service.

**Daily reminders (optional):** if `REMINDER_HOUR` is set, patients who have a phone number, are still being monitored and have not checked in today get one SMS reminder after that hour. Only register a phone number for patients who agreed to receive SMS.

## Set it up

### SMS (Africa's Talking)

1. Create an account at africastalking.com and, for a real sender, an API key.
2. Add these in Render, under your service's **Environment** tab:
   - `AT_USERNAME` (use `sandbox` while testing, with `AT_SANDBOX=1`)
   - `AT_API_KEY`
   - `AT_SENDER_ID` (optional, only if approved for your account)
   - `ALERT_SMS_TO` (optional fallback numbers, comma separated)
   - `REMINDER_HOUR` (optional, for example `8`)
3. Test in the sandbox first. SMS to real numbers costs money.

### Push alerts

1. Run `node sms-push/generate-keys.js` in the `server` folder and put the two values in the Environment tab as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Also set `VAPID_SUBJECT` to `mailto:` plus your email.
   If you skip the keys, CareBridge makes its own and saves them in `db.json`. That is fine on a server with a persistent disk. Without one, the keys are lost on every redeploy and everyone must turn alerts on again.
2. Nurses and organizations open **Alerts** (nurses) or **Overview** (organizations), tap **Turn on alerts**, and allow notifications. Signing out turns alerts off for that device.
3. On iPhone, push only works after you add CareBridge to the home screen (iOS 16.4 or later).

## What was tested

The automated tests (`npm test`) cover phone cleaning, SMS sending with a fake provider, the push signing, who is alerted (and who is not), the 30 minute limit, removal of expired devices, and the reminder rules. They use fake transports, so they never contact a real provider. **Test with the Africa's Talking sandbox and a real phone before you rely on this for patients.**
