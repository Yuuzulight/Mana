const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseEnv } = require("util");

// #645: a .env value can say where a secret lives instead of holding it:
//   MANA_DISCORD_BOT_TOKEN=keyring:Mana/discord          Windows Credential
//     Manager generic credential "Mana/discord" (DPAPI-encrypted per user)
//   MANA_DISCORD_BOT_TOKEN=op://Private/Discord/token    1Password secret
//     reference, read with the `op` CLI
// Resolved once here, so every reader of process.env keeps working unchanged.
// Any other non-empty value whose name ends in _TOKEN/_SECRET/_KEY/_PASSWORD
// is a plain-text secret: Doctor names them (never their values), so that
// fallback is never silent -- but not on every start (Q18).
const SECRET_NAME = /(_TOKEN|_SECRET|_KEY|_PASSWORD)$/;
const KEYRING_PREFIX = "keyring:";

// CredReadW via Add-Type: Node has no Credential Manager API, and this avoids
// a native npm dependency. One PowerShell for all targets (Add-Type costs
// ~1s); targets go in through the environment and values come out as base64
// UTF-8 so console code pages can't mangle them. "-" marks a missing entry.
const CRED_READ_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ManaCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
}
'@
foreach ($t in (ConvertFrom-Json $env:MANA_KEYRING_TARGETS)) {
  $v = [ManaCredRead]::Read($t)
  if ($null -eq $v) { '-' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) }
}
`;

// Returns one value per target: the secret, or null when there's no entry.
function readKeyringSecrets(targets) {
  if (process.platform !== "win32") {
    throw new Error("keyring: references need Windows Credential Manager");
  }
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(CRED_READ_PS, "utf16le").toString("base64")],
    {
      env: { ...process.env, MANA_KEYRING_TARGETS: JSON.stringify(targets) },
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  const lines = String(result.stdout || "").split(/\r?\n/).slice(0, targets.length);
  if (result.status !== 0 || lines.length !== targets.length) {
    throw new Error(`Credential Manager read failed (powershell exit ${result.status ?? result.error?.code})`);
  }
  return lines.map((line) => (line === "-" ? null : Buffer.from(line, "base64").toString("utf8")));
}

// `op read` may wait on a 1Password unlock prompt, hence the long timeout.
// Only op's first stderr line is ever reported; stdout is the secret.
function readOnePasswordSecret(reference) {
  const result = spawnSync("op", ["read", "--no-newline", reference], {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const reason = result.error ? result.error.code : String(result.stderr || "").trim().split(/\r?\n/)[0];
    throw new Error(`op read failed: ${String(reason).slice(0, 200)}`);
  }
  return result.stdout;
}

// node-bot/.env was documented as Mana's config file (tools/setup-mana.ps1,
// .env.sample, docs) but nothing ever loaded it -- the backend only saw
// whatever the launcher or the user's Windows environment happened to pass.
// .env values win over inherited ones on purpose: it is the file the user
// edits, and stale user-level variables (old paths, deleted models) must not
// silently override it. A missing file is fine (env-only setups keep
// working). A reference that can't be resolved leaves its key unset, with a
// warning -- never the reference text itself (the native launcher passes
// that through its own environment). Returns the keys it set.
function loadEnvFile(filePath = path.join(__dirname, ".env"), env = process.env, options = {}) {
  const {
    readKeyring = readKeyringSecrets,
    readOnePassword = readOnePasswordSecret,
    warn = console.warn,
  } = options;
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const parsed = parseEnv(text);

  const keyringKeys = Object.keys(parsed).filter((key) => parsed[key].startsWith(KEYRING_PREFIX));
  let keyringValues = null;
  if (keyringKeys.length) {
    try {
      keyringValues = readKeyring(keyringKeys.map((key) => parsed[key].slice(KEYRING_PREFIX.length)));
    } catch (e) {
      warn(`[env] ${e.message}; leaving ${keyringKeys.join(", ")} unset`);
    }
  }

  const setKeys = [];
  for (const [key, value] of Object.entries(parsed)) {
    let resolved = value;
    if (keyringKeys.includes(key)) {
      resolved = keyringValues ? keyringValues[keyringKeys.indexOf(key)] ?? null : null;
      if (resolved === null && keyringValues) {
        warn(`[env] ${key}: no Credential Manager entry "${value.slice(KEYRING_PREFIX.length)}"; leaving it unset`);
      }
    } else if (value.startsWith("op://")) {
      try {
        resolved = readOnePassword(value);
      } catch (e) {
        warn(`[env] ${key}: ${e.message}; leaving it unset`);
        resolved = null;
      }
    }
    if (resolved === null) {
      delete env[key];
      continue;
    }
    env[key] = resolved;
    setKeys.push(key);
  }
  return setKeys;
}

// Q18: the names (never the values) of secrets still written in plain text
// in .env, for Doctor. A missing file has none.
function plainTextSecretKeys(filePath = path.join(__dirname, ".env")) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [];
  }
  return Object.entries(parseEnv(text))
    .filter(([key, value]) => value && SECRET_NAME.test(key) && !value.startsWith(KEYRING_PREFIX) && !value.startsWith("op://"))
    .map(([key]) => key);
}

module.exports = { loadEnvFile, plainTextSecretKeys, readKeyringSecrets };
