Summary
- Add token-based admin protection for mobile admin endpoints. When ADMIN_TOKEN is set, admin endpoints require Authorization: Bearer <token> or x-admin-token. If ADMIN_TOKEN is not set, behavior falls back to the prior localhost-only restriction.
- Add a small admin UI improvement to allow entering the admin token client-side for remote management.
- Add unit test node-bot/test/admin-auth.test.js validating the new admin auth behavior.
- Add a GitHub Actions workflow .github/workflows/label-on-comment.yml that adds the run/full-ci label to a PR when a collaborator comments /run/full-ci, and posts a confirmation comment.
- Update CONTRIBUTING.md with CLA filename guidance and ADMIN_TOKEN instructions.

Why
- Hardens admin endpoints for remote deployments while preserving legacy localhost-only behavior when ADMIN_TOKEN is not configured.
- Makes opt-in heavy CI easier for maintainers via a simple PR comment.
- Documents how contributors supply CLA files and how CI tests that require admin access should be configured.

Files changed
- Modified:
  - node-bot/mobile-routes.js
  - node-bot/admin/mobile_devices_ui.html
  - CONTRIBUTING.md
- Added:
  - node-bot/test/admin-auth.test.js
  - .github/workflows/label-on-comment.yml

Security & compatibility notes
- Default behavior unchanged if ADMIN_TOKEN is unset (admin endpoints remain localhost-only).
- CI and tests that exercise admin endpoints must have the ADMIN_TOKEN repo secret configured.
- The label-on-comment workflow only grants the label when the commenter has write/admin permission on the repo to avoid abuse.

How to test locally
1. Install Node (>=18).
2. Run fast tests (skips heavy model tests):
   PowerShell:
     $env:ADMIN_TOKEN = "test-admin-token"
     $env:SKIP_HEAVY_MODEL_TESTS = "1"
     cd node-bot
     npm test
3. Run the single new test:
   PowerShell:
     $env:ADMIN_TOKEN = "test-admin-token"
     node --test test/admin-auth.test.js

How to trigger heavy CI for a PR
- A collaborator with write/admin permission can comment on the PR:
  /run/full-ci
- The label-on-comment workflow will add the run/full-ci label and respond.

Requested repo secret (CI)
- ADMIN_TOKEN — value: a long random string used by CI and the server when remote admin access is desired.

Requested actions
- Create branch chore/admin-token-and-label-bot, commit changes, push, and open PR against main using the PR body above.
- Add repository secret ADMIN_TOKEN with a strong value so CI tests that require admin access will pass.
- Optionally enable auto-merge on the PR when CI is green.

Notes
- I cannot push or create the PR from this environment. Below are exact commands you can run locally to complete these steps (PowerShell Windows).