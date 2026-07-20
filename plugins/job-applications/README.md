# Job Applications (Mana plugin)

Local job-application tracker plus a knowledge base of reusable answer
content (resume bullets, project descriptions, canned interview/application
Q&A), so Mana can answer "what have I applied to" or pull up a saved answer
on request.

**No LinkedIn integration.** This plugin does not read, scrape, or connect
to LinkedIn or any other third-party job/profile site -- everything is
stored locally and entered by you through the routes below.

- `GET /jobs/applications` / `POST /jobs/applications` — list / create a
  tracked application (`company`, `role` required; `status` one of
  `applied`/`interviewing`/`offer`/`rejected`/`withdrawn` (default
  `applied`), plus optional `url`, `notes`, `appliedAt`).
- `PATCH /jobs/applications/:id` / `DELETE /jobs/applications/:id` — update
  or remove a tracked application.
- `GET /jobs/answers` / `GET /jobs/answers/:key` — list saved answers, or
  fetch one by key.
- `POST /jobs/answers` — create or overwrite a saved answer by `key`
  (`content` required, `label` optional display name). Saving again under
  the same key replaces the previous content rather than duplicating it.
- `DELETE /jobs/answers/:key` — remove a saved answer.

Also contributes prompt context directly into Mana's chat replies when a
message looks job-application-related (see `textLooksLikeJobApplicationQuestion`),
surfacing a compact summary of tracked applications plus any saved answer
whose key or label the message actually mentions.

Data is stored locally in `plugins/job-applications/data/job-applications.json`
(gitignored) -- override the directory with `MANA_JOB_APPLICATIONS_DIR`.

## Dev

```bash
npm test    # pure-logic tests, no running Mana server needed
```
