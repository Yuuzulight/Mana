# Issue 48: Add Optional 2FA for Mobile Device Pairing

## Goal

Strengthen the mobile/remote auth surface with an optional second factor,
extending the mobile device security work already tracked in issue #14.

## Why

Inspired by odysseus's 2FA support. Mana's mobile pairing currently relies
on a passcode + session token (`node-bot/mobile-routes.js`).

## Proposed Scope

- Add an opt-in TOTP-based second factor for mobile device pairing (on top
  of the existing passcode).
- Store the TOTP secret alongside existing mobile auth config; never send
  it to the device itself except during enrollment.
- Doctor/health reporting notes whether 2FA is enabled for mobile access.

## Acceptance Criteria

- Users can optionally enable TOTP-based 2FA for mobile pairing.
- Pairing fails without a valid TOTP code when 2FA is enabled.
- 2FA is off by default and doesn't affect existing passcode-only setups.
- Coordinate with issue #14 so device list/rotation/revocation and 2FA
  share one mobile-security story rather than diverging.
