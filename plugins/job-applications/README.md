# Job Applications (Mana plugin)

Local job-application tracker plus a knowledge base of reusable answer
content (resume bullets, project descriptions, canned interview/application
Q&A), so Mana can answer "what have I applied to" or pull up a saved answer
on request. Also matches a pasted job posting against that knowledge base
and drafts a tailored resume + cover letter.

**No LinkedIn integration, no scraping, no auto-submission.** This plugin
does not read, scrape, or connect to LinkedIn or any other third-party
job/profile site, and it never submits an application anywhere. Job postings
are pasted in by you; tailored materials are staged locally for you to
review and submit yourself.

- `GET /jobs/applications` / `POST /jobs/applications` — list / create a
  tracked application (`company`, `role` required; `status` one of
  `ready_to_apply`/`applied`/`interviewing`/`offer`/`rejected`/`withdrawn`
  (default `applied`), plus optional `url`, `notes`, `appliedAt`).
- `PATCH /jobs/applications/:id` / `DELETE /jobs/applications/:id` — update
  or remove a tracked application.
- `GET /jobs/answers` / `GET /jobs/answers/:key` — list saved answers, or
  fetch one by key.
- `POST /jobs/answers` — create or overwrite a saved answer by `key`
  (`content` required, `label` optional display name). Saving again under
  the same key replaces the previous content rather than duplicating it.
- `DELETE /jobs/answers/:key` — remove a saved answer.
- `POST /jobs/match` — paste in a job posting (`postingText` required, plus
  optional `company`/`role`/`url` overrides) and Mana tailors a resume and
  cover letter from your saved answers, then stages the result as a tracked
  application with `status: "ready_to_apply"` (`fitSummary`,
  `tailoredResume`, `tailoredCoverLetter` fields, plus the original
  `postingText`). Nothing is submitted anywhere -- update the application's
  `status` yourself (e.g. to `applied`) once you've actually sent it. Needs
  a local model configured (`context.synthesizeJobMatch`); returns 503
  otherwise.

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
