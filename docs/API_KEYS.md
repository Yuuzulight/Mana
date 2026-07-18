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

## Admin Dashboard

Easiest way to manage accounts: open `http://mana-machine:5005/admin/accounts-ui` in your browser and log in with your admin API key.

The dashboard lets you:
- Create new user accounts and see their keys in a copyable modal
- View all active accounts
- Revoke accounts (immediate revocation, key becomes useless)

### Via curl (CLI)

Alternatively, manage accounts from the command line:

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
- **user**: Can only access their own consolidated memory via `/api/memory`. No admin privileges.

Each user (including other people) can only read their own memory, not anyone else's.

## Security Notes

- API keys are hashed before storage; raw keys are never logged.
- Always transmit keys over HTTPS or a secure tunnel (SSH).
- Keep your admin key safe — it can create and revoke all accounts.
- Each user should store their own key securely (password manager recommended).
