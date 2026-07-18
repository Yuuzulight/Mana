# Mana API Authentication

Mana supports multi-account access via API keys. Each account can be assigned a role (admin or user) and gets a unique API key for authentication.

## Setup

When Mana starts for the first time, an admin account is automatically created. Check `node-bot/data/auth/SETUP.txt` for your initial admin API key. Save this key somewhere safe — it will not be shown again.

## Using the Memory API

Access your consolidated memory via `GET /api/memory` on any device:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" http://mana-machine:5005/api/memory
```

Returns a markdown file with your memory summary, key facts, and cross-session connections. Perfect for feeding into Obsidian or any markdown reader.

### Local Network

If your phone is on the same WiFi as Mana, just use the local IP:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" http://192.168.1.x:5005/api/memory
```

### From Outside Your Network

You'll need a secure tunnel (SSH, VPN) or run Mana behind a reverse proxy with HTTPS.

## OpenAI-Compatible API

Mana exposes a standard OpenAI-shaped API so external tools that support a "Custom" OpenAI
provider (Obsidian Copilot, etc.) can talk to Mana directly, using the same API key as the
Memory API above.

- `POST /v1/chat/completions` — proxies straight through to Mana's local model (via the
  persistent `llama-server`), including `stream: true` for SSE. Requires `MANA_LLAMA_SERVER`
  to be enabled (it is by default whenever `LLAMA_SERVER_BIN`/`LLAMA_MODEL` are configured).
- `POST /v1/embeddings` — computes embeddings using Mana's own local sentence-transformers
  model, the same one its memory retriever uses. Requires the local embedder to be running
  (see below).
- `GET /v1/models` — lists the configured chat and embedding model IDs.

All three require `Authorization: Bearer YOUR_API_KEY`, same as `/api/memory`.

```bash
curl http://mana-machine:5005/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'

curl http://mana-machine:5005/v1/embeddings \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "some text to embed"}'
```

### Setting up the local embedder

`/v1/embeddings` (and Mana's own memory retriever, when `USE_EMBEDDINGS` is on) needs the
local embedder service running. The Windows launcher starts and stops it automatically
alongside the rest of Mana's services (same lifecycle as the retriever and SearXNG), and
sets `USE_EMBEDDINGS=1`/`RETRIEVER_EMBEDDER_URL` on the backend for you — you only need to
install its dependencies once:

```bash
pip install fastapi uvicorn sentence-transformers
```

(into `venv/` at the repo root if you have one there — the launcher prefers it, falling back
to plain `python` otherwise.) Set `MANA_START_EMBEDDER=0` to opt out if you don't want it
running (e.g. to save the ~100MB model load), or `USE_EMBEDDINGS=0` to keep it running but
unused. To run it manually instead (e.g. running node-bot outside the launcher):

```bash
python node-bot/tools/local_embedder.py --port 9001 --model all-MiniLM-L6-v2
```

and set `USE_EMBEDDINGS=1`/`RETRIEVER_EMBEDDER_URL=http://127.0.0.1:9001` before starting
`node-bot` yourself. Without `USE_EMBEDDINGS=1` or with the embedder unreachable,
`/v1/embeddings` returns a `503` rather than silently returning empty vectors.

### Connecting Obsidian Copilot

In Obsidian Copilot's settings, add a Custom OpenAI-compatible provider for both the chat
model and the embedding model:

- **Base URL**: `http://localhost:5005/v1` (or `http://mana-machine:5005/v1` from another device)
- **API Key**: your Mana API key
- **Chat model name**: any value — Mana's `/v1/models` reports the actual loaded model, but
  `/v1/chat/completions` doesn't look at the `model` field in the request, it always uses
  whatever `llama-server` currently has loaded.
- **Embedding model name**: same Base URL/API key, model name can also be anything — Mana
  always uses its configured local embedder.

Once both are configured, point Copilot's Memory Bank (vault QA/RAG index) at the embedding
provider above and build the index from your vault — Mana will handle every embedding call.

## Admin Dashboard

Easiest way to manage accounts: open `http://mana-machine:5005/admin/accounts-ui` in your browser and log in with your admin API key.

The dashboard lets you:
- Create new user accounts and see their keys in a copyable modal
- View all active accounts
- Revoke accounts (immediate revocation, key becomes useless)

**Account management is local-only by default.** Unlike `/api/memory` (deliberately
remote-accessible via API key), creating/listing/revoking accounts additionally requires
either a request from `mana-machine` itself, or a matching `ADMIN_TOKEN` — an admin API key
alone isn't enough from another device or over a tunnel. To manage accounts remotely, set an
`ADMIN_TOKEN` environment variable on the server and send it as the `x-admin-token` header
(same pattern the existing `/mobile/*` admin endpoints use).

### Via curl (CLI)

Alternatively, manage accounts from the command line (run locally, or add
`-H "x-admin-token: YOUR_ADMIN_TOKEN"` if calling remotely with `ADMIN_TOKEN` configured):

**Create a User Account:**

```bash
curl -X POST http://mana-machine:5005/admin/accounts \
  -H "Authorization: Bearer ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "friend@example.com", "role": "user"}'
```

Response includes the new user's API key (shown once only):

```json
{
  "userId": "...",
  "email": "friend@example.com",
  "role": "user",
  "apiKey": "...",
  "message": "Save your API key somewhere safe; it will not be shown again"
}
```

**List All Accounts:**

```bash
curl -H "Authorization: Bearer ADMIN_KEY" http://mana-machine:5005/admin/accounts
```

**Revoke an Account:**

```bash
curl -X DELETE http://mana-machine:5005/admin/accounts/USER_ID \
  -H "Authorization: Bearer ADMIN_KEY"
```

## Account Roles

- **admin**: Can create accounts, list accounts, revoke accounts, and access the memory API.
- **user**: Can access the memory API. No admin privileges (can't create/list/revoke accounts).

Mana is a single local AI companion with one shared memory store — there is no per-account
memory partitioning. Any valid key, admin or user, sees the same consolidated memory via
`/api/memory`; the role only controls whether the key can also manage accounts. Only give a
user-role key to someone you're comfortable having read access to that memory.

## Security Notes

- API keys are hashed before storage; raw keys are never logged.
- Always transmit keys over HTTPS or a secure tunnel (SSH).
- Keep your admin key safe — it can create and revoke all accounts. It's not the only thing
  standing between an attacker and account management, though: `/admin/*` also requires the
  request to be local or carry a matching `ADMIN_TOKEN`, so a leaked admin key alone can't be
  used to manage accounts from an arbitrary network origin.
- Each user should store their own key securely (password manager recommended).
- Revoking a user-role account immediately cuts off their memory access (see Admin Dashboard above).
