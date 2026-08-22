#!/usr/bin/env node
// Issue #48: generates a TOTP secret for the optional device-pairing 2FA.
// Usage:
//  node generate_mobile_2fa.js
// Add the printed otpauth:// URI (or the raw secret) to an authenticator
// app (Google Authenticator, Authy, etc.), then set MOBILE_TOTP_SECRET.
// Leaving MOBILE_TOTP_SECRET unset keeps 2FA off -- pairing works exactly
// as it does today.

const { generateTotpSecret, buildOtpauthUri } = require("../totp");

function main() {
  const secret = generateTotpSecret();
  const otpauthUri = buildOtpauthUri({ secretBase32: secret, label: "device-pairing", issuer: "Mana" });

  console.log("\n=== Mobile pairing 2FA (TOTP) ===");
  console.log("MOBILE_TOTP_SECRET=" + secret);
  console.log("\nAdd to an authenticator app -- either scan/paste this URI:");
  console.log(otpauthUri);
  console.log("\n...or enter the secret manually:");
  console.log(secret);

  console.log("\nPowerShell (current session):");
  console.log(`$env:MOBILE_TOTP_SECRET = "${secret}"`);

  console.log("\nWindows persistent (setx) — open a new PowerShell after running this:");
  console.log(`setx MOBILE_TOTP_SECRET "${secret}"`);

  console.log(
    "\nDone. Restart the node-bot process to pick up persistent env vars. " +
      "Device pairing will now require a current TOTP code in addition to the pairing code.",
  );
}

main();
