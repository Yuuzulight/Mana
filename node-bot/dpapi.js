const { spawnSync } = require("child_process");

// #645: Windows DPAPI (CurrentUser scope), the same protection the native
// launcher uses for its AdminToken (#804). Node has no DPAPI binding, so
// this goes through PowerShell like load-env.js's Credential Manager read
// -- no native npm dependency. The value travels over stdin/stdout (base64),
// never the command line. Only the same Windows account on the same PC can
// decrypt. Each call starts PowerShell (~0.5s): callers cache the result.
const DPAPI_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes($env:MANA_DPAPI_ENTROPY)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($env:MANA_DPAPI_OP -eq 'protect') { $out = [Security.Cryptography.ProtectedData]::Protect($in, $entropy, $scope) }
else { $out = [Security.Cryptography.ProtectedData]::Unprotect($in, $entropy, $scope) }
[Convert]::ToBase64String($out)
`;

function runDpapi(op, inputBase64, entropy) {
  if (process.platform !== "win32") {
    throw new Error("DPAPI needs Windows");
  }
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(DPAPI_PS, "utf16le").toString("base64")],
    {
      env: { ...process.env, MANA_DPAPI_OP: op, MANA_DPAPI_ENTROPY: entropy },
      input: inputBase64,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  const output = String(result.stdout || "").trim();
  if (result.status !== 0 || !output) {
    throw new Error(`DPAPI ${op} failed (powershell exit ${result.status ?? result.error?.code})`);
  }
  return output;
}

// Returns base64 of the DPAPI blob.
function protect(text, entropy) {
  return runDpapi("protect", Buffer.from(String(text), "utf8").toString("base64"), entropy);
}

function unprotect(blobBase64, entropy) {
  return Buffer.from(runDpapi("unprotect", blobBase64, entropy), "base64").toString("utf8");
}

module.exports = { protect, unprotect };
