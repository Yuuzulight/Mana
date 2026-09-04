# Issue 496: Cloud Storage Sync As A Memory-Inbox Source

## Goal

Let inbox ingestion (#76) pull from Google Drive/OneDrive/Dropbox, not
just a local watched folder.

## Why

Inspired by SurfSense's cloud storage sync (Google Drive, OneDrive,
Dropbox) as ingestion sources.

## Proposed Scope

- Extend #76's inbox ingestion with cloud storage sources.
- Each provider is its own OAuth integration -- build on whatever
  credential pattern #268's credential broker scoping (or #492's social
  publishing work) settles on, rather than inventing a separate one.

## Acceptance Criteria

- At least one cloud storage provider can be configured as an inbox
  source and its files get ingested the same way local inbox files do.
- Local folder ingestion is unaffected.

## Related

#76, #268, #492
