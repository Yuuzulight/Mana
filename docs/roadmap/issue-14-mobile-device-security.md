# Issue 14: Improve Mobile Device Security Controls

## Goal

Give Mana better control over phones and remote clients that connect to the local backend.

## Proposed Scope

- Add a device list for mobile clients.
- Support token rotation and device revocation.
- Show last-seen timestamps where possible.
- Add clearer warnings when remote access is exposed.
- Keep chat summaries and memory local by default unless the user explicitly syncs them.

## Acceptance Criteria

- Users can see known mobile devices.
- Users can revoke a mobile device token.
- Remote exposure warnings are visible in status output.
- Local memory remains the default storage path.
