# Email and calendar setup

With these set up, Mana can answer "what came in overnight?" and "am I free
Thursday?", and she can add a calendar event, but only after you approve it.

You enter your own accounts in **Settings > Calendar & Email** in the native
launcher. Then click **Save and test**. It logs in right away and tells you
what went wrong if it fails.

## What Mana does with it

- **Only when you ask.** Nothing runs in the background. Each question opens
  one connection to your mail or calendar server and closes it again.
- **Your data is processed on your PC.** Mail and events come straight from
  your provider to Mana. The only thing she saves is the account settings.
- **Settings are encrypted.** Server, username, app password and feed address
  are saved in `node-bot/data/mail-calendar.json` with Windows DPAPI. Only
  your Windows account on this PC can read them. Settings never shows a saved
  password or feed address again. Leave the box blank to keep the saved one.
- **Email is read-only.** The mailbox is opened read-only, so reading a
  message doesn't mark it as read. Mana can't send, move or delete mail.
- **Email content is treated as someone else's words.** Mana summarises it
  but never follows instructions written in an email or a calendar invite.
  Adding a calendar event always shows an approval prompt, even if you chose
  "always allow" for it before.
- **Your chat only.** Mana only uses these in your own chat. Discord, Telegram
  and scheduled replies don't get them.

## Email (IMAP)

Use an **app password**, not your normal password. Most providers only give
you one after two-step verification is turned on.

| Provider | Server | Port | Username | App password |
|---|---|---|---|---|
| Gmail | `imap.gmail.com` | 993 | your full Gmail address | Google Account > Security > 2-Step Verification > App passwords (myaccount.google.com/apppasswords) |
| iCloud Mail | `imap.mail.me.com` | 993 | your iCloud email address | account.apple.com > Sign-In and Security > App-Specific Passwords |
| Fastmail | `imap.fastmail.com` | 993 | your Fastmail address | Settings > Privacy & Security > Manage app passwords (give it mail access) |
| Yahoo Mail | `imap.mail.yahoo.com` | 993 | your Yahoo address | Account Info > Account Security > Generate app password |
| Other | your provider's IMAP server | usually 993 | usually your email address | your provider's app password page |

Mailbox is `INBOX` unless you want Mana to read a different folder.

**Outlook.com / Microsoft 365 email isn't supported yet.** Microsoft no longer
accepts passwords for IMAP. It needs an OAuth sign-in, and Mana doesn't have
that yet.

## Calendar

There are two kinds of calendar.

### CalDAV: read and add events

Enter the address, username and an app password:

| Provider | Address | Username |
|---|---|---|
| iCloud | `https://caldav.icloud.com` | your Apple Account email (use an app-specific password, as above) |
| Fastmail | `https://caldav.fastmail.com/dav/calendars/user/you@fastmail.com/` | your Fastmail address (app password with calendar access) |
| Nextcloud | `https://your.server/remote.php/dav` | your Nextcloud user (app password from Settings > Security) |

A server's root address is fine. Mana finds your first calendar that takes
events. To use a different calendar, paste that calendar's own CalDAV
address instead.

### iCal feed: read-only

This is for Google Calendar and Outlook calendars. Paste the feed address and
**leave Username blank**. Anyone who has this address can read the calendar,
so it's encrypted like a password.

- **Google Calendar.** On calendar.google.com, go to Settings, pick your
  calendar on the left, then Integrate calendar. Copy the **Secret address in
  iCal format**.
- **Outlook calendar.** In Outlook on the web, go to Settings > Calendar >
  Shared calendars > Publish a calendar. Pick the calendar and "Can view all
  details", then Publish, and copy the **ICS** link.

Mana can't add events to a feed. Adding events to Google or Outlook needs an
OAuth sign-in, and Mana doesn't have that yet.

## Keeping the password in a password manager

Instead of typing the app password itself, the password box also takes a
reference, the same kind `node-bot/.env` accepts:

- `keyring:Mana/imap` reads the Windows Credential Manager entry "Mana/imap".
  To add it, open Control Panel > Credential Manager > Windows Credentials >
  Add a generic credential.
- `op://Private/Gmail app password/password` reads a 1Password item through
  the `op` CLI.

## Troubleshooting

- **"email login failed"**: check the server name, and that you used an app
  password, not your account password. For Gmail, make sure IMAP is on
  (Gmail Settings > Forwarding and POP/IMAP).
- **"calendar login failed"**: the username or app password is wrong, or the
  app password doesn't have calendar access.
- **"no calendars found at that URL"**: paste the calendar's own CalDAV
  address from your provider's settings.
- **"The saved settings can't be read on this Windows account"**: the file was
  made by another Windows account or PC. Enter the accounts again.
