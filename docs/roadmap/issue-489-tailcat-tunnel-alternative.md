# Issue 489: Evaluate A Tailcat-Style Account-Free Tunnel

## Goal

Give the mobile PWA a remote-access path that doesn't require a
Cloudflare account and domain.

## Why

`docs/mobile_pwa_cloudflare.md` requires a Cloudflare account, an owned
domain, and a Cloudflare Access application. Per #470, this isn't even
configured yet -- it's a real setup barrier, not just a hardening gap.
tailscale/tailcat is a point-to-point WireGuard tunnel needing no account
and no control plane: a server generates a connection token, clients use
it to connect, with STUN NAT hole-punching and DERP relay fallback, no
root/admin required.

## Proposed Scope

- Evaluate tailcat (or the same underlying approach) as an alternative
  path for exposing the mobile PWA backend.
- Keep the existing Cloudflare Tunnel path available for users who want
  Cloudflare Access's identity-provider integration (per #470).

## Acceptance Criteria

- A documented setup path reaches the mobile PWA from a phone without a
  Cloudflare account or domain.
- Existing Cloudflare Tunnel path is unaffected for users who already use
  or prefer it.

## Related

#470
