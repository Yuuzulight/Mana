# Issue #363: third-party licensing of the built installer

Audit of what the built artifacts actually contain, as opposed to what the
repository contains, 2026-08-17.

## Headline finding

**The `desktop-client` installer bundles AGPL-3.0 code while declaring
Apache-2.0.**

`desktop-client/package.json` sets `"license": "Apache-2.0"` and its
electron-builder `extraResources` includes:

```
../tools/searxng -> tools/searxng
```

`tools/searxng/LICENSE` is the **GNU Affero General Public License,
Version 3**.

This is the exact shape the issue was filed to check, and it is real rather
than hypothetical.

## The repository is clean; the artifact is not

Worth separating, because the two are often conflated:

- `tools/searxng` is **gitignored** (`.gitignore:96`) and **untracked**
  (`git ls-files tools/searxng` returns nothing). The repo distributes no
  AGPL code.
- But `extraResources` reads from the working directory at build time, and
  that directory is present on any machine set up to run Mana. So the
  installer produced there contains SearXNG.

`windows-launcher/package.json` declares no `extraResources` at all, so the
launcher installer is unaffected. **Only `desktop-client` is in scope.**

## What this does and does not mean

Overstating this would be as wrong as ignoring it.

**It does not make Mana's own code AGPL.** SearXNG runs as a separate
process that Mana talks to over HTTP on localhost. That is the textbook
shape of *mere aggregation* rather than a derivative work: two programs
shipped together on one medium, communicating at arm's length through a
documented network interface. Mana's Apache-2.0 licensing of its own source
is not disturbed by shipping SearXNG alongside it.

**It does create real obligations for the SearXNG portion.** Distributing
an AGPL work means:

1. Shipping the AGPL-3.0 licence text with it.
2. Offering corresponding source for that component.
3. Stating whether it has been modified.

**Point 3 is the cheap part here.** `tools/searxng` has no `.git` -- it is a
plain copy, and Mana's configuration lives outside it in
`tools/mana-searxng-settings.yml`. An unmodified upstream copy is the
simplest possible compliance case: point at the upstream release.

**AGPL section 13 (the network clause) is unlikely to bite in practice.**
It triggers when users interact with the program remotely over a network.
SearXNG here binds locally and serves one user on the same machine. That
said, Mana does have a mobile companion over a Cloudflare Tunnel, so if
search were ever exposed through that path the analysis would need
revisiting.

## Everything else checked, and clean

| Bundled resource | Licence position |
| --- | --- |
| `../node-bot`, `../plugins` | Mana's own, Apache-2.0 |
| `../node-bin` | official Node.js binary, MIT |
| `../tts-service` | Mana's own Python wrappers; the heavy deps install at runtime via pip and are not bundled |
| `portable-python` | absent on this machine; CPython itself is PSF-licensed and permissive. Worth re-checking on a machine where it is populated, since what matters is which *packages* it carries |

**npm dependencies: no copyleft found.** A scan of every installed package's
declared licence in `node-bot/node_modules` for GPL/AGPL/CC-BY-NC/SSPL/BUSL
returned nothing.

**Not bundled, despite being central:** whisper.cpp, llama.cpp, GGUF model
weights, and the TTS model weights. `THIRD_PARTY.md` states this
deliberately, and `.gitignore` confirms it (`/tools/llama/`,
`tools/whisper/models/`, `tts-service/kokoro/`). Those are obtained by the
user and governed by their own terms -- notably the S1-mini weights under
CC-BY-NC-SA-4.0 and the S2-Pro weights under the Fish Audio Research
License, both non-commercial. **Neither reaches the installer, so neither
constrains it.**

## Recommendations

1. **Ship the AGPL text and a source offer** for SearXNG in the
   `desktop-client` installer. Smallest correct fix, and it resolves the
   finding without changing what Mana does.
2. **Update `THIRD_PARTY.md`.** It currently says the project "intentionally
   keeps large binaries" out of the repo -- true, and it says nothing about
   what the *installer* adds back in. That gap is what made this finding
   non-obvious.
3. **Decide whether SearXNG belongs in the installer at all.** It is the
   only copyleft component in the bundle. Shipping it as a separate,
   user-installed dependency -- the way whisper and llama already are --
   would remove the obligation entirely and make the installer uniformly
   permissive. That is a product decision, not a licensing one.
4. **Re-run the `portable-python` check** on a machine where it is
   populated, since its contents are the one unknown here.

## Note for future evaluations

The Atlas inference engine, discussed separately as a possible future
component, is **AGPL-3.0 community edition**. If it were ever bundled the
analysis above would apply again -- with one important difference: an
inference engine Mana links against or drives directly is a much weaker
mere-aggregation argument than a search service reached over HTTP.
