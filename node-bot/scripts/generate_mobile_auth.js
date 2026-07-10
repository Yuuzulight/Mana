#!/usr/bin/env node
// Usage:
//  node generate_mobile_auth.js [passcode]
// If passcode is omitted, you'll be prompted.

const readline = require('readline');
const { hashPasscode } = require('../mobile-auth');
const crypto = require('crypto');

function prompt(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  let passcode = process.argv[2];
  if (!passcode) {
    passcode = (await prompt('Enter desired mobile passcode (e.g. 2468): ')).trim();
  }
  if (!passcode) {
    console.error('Passcode required');
    process.exit(2);
  }

  const passcodeHash = hashPasscode(passcode);
  const sessionSecret = crypto.randomBytes(32).toString('base64url');

  console.log('\n=== Mobile auth values ===');
  console.log('MOBILE_PASSCODE_HASH=' + passcodeHash);
  console.log('MOBILE_SESSION_SECRET=' + sessionSecret);

  console.log('\nPowerShell (current session):');
  console.log(`$env:MOBILE_PASSCODE_HASH = "${passcodeHash}"`);
  console.log(`$env:MOBILE_SESSION_SECRET = "${sessionSecret}"`);

  console.log('\nWindows persistent (setx) — open a new PowerShell after running these:');
  console.log(`setx MOBILE_PASSCODE_HASH "${passcodeHash}"`);
  console.log(`setx MOBILE_SESSION_SECRET "${sessionSecret}"`);

  console.log('\nDone. Restart the node-bot process to pick up persistent env vars.');
}

main().catch((e) => { console.error(e); process.exit(1); });
