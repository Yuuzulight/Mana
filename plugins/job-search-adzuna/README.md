# Job Search: Adzuna (Mana plugin)

Live job postings via the [Adzuna Job Search API](https://developer.adzuna.com/)
(free tier), so Mana can find open roles matching a query. Search-only --
no auto-apply, no scraping, no LinkedIn.

- `GET /jobs/search?what=...` — search postings. `what` (keywords) is
  required; optional `where` (location), `page` (default 1), `resultsPerPage`
  (default 10, capped at 20). Returns `{ source: "Adzuna", count, listings }`
  where each listing has `id`, `title`, `company`, `location`, `description`
  (HTML stripped), `url`, `createdAt`, `salaryMin`, `salaryMax`.

To get a tailored resume/cover letter for a result, copy its `description`
into the job-applications plugin's `POST /jobs/match` yourself -- this
plugin doesn't call that one directly, they're independent and just work
well together.

Requires `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` (free registration at
developer.adzuna.com). Without both, `/health` reports "unconfigured" and
`GET /jobs/search` returns `503` rather than failing. Optional env vars:
`ADZUNA_COUNTRY` (default `us` -- Adzuna scopes each search to one country,
see their docs for supported codes), `ADZUNA_BASE_URL`, `ADZUNA_CACHE_MS`
(default 5 minutes).

## Dev

```bash
npm test    # pure-logic tests, no running Mana server needed
```
