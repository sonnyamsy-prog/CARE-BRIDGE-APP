"use strict";
// Run once:  node sms-push/generate-keys.js
// Put the two values in your host's environment settings (Render: Environment tab).
const { generateVapid } = require("./push");
const k = generateVapid();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log("\nKeep the private key secret. Do not commit it to GitHub.");
