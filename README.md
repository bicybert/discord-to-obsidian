# Discord to Obsidian

An Obsidian plugin that syncs Discord channel messages into your vault as markdown notes.

- **One note per channel** — `Discord/general.md` contains the whole channel
- **One heading per message** — `## Username — 2026-01-05 14:32` followed by the message content
- **Attachments are downloaded locally** — Discord CDN links expire, so images and files are saved into your vault and embedded with `![[...]]`
- **Attachment organization** — customizable root folder, with optional subfolders per channel and per file type (`images/`, `files/`)
- **Incremental sync** — the plugin remembers the last synced message per channel and only fetches what's new
- **Handles rate limits** — 429 responses are retried with Discord's `retry_after`

## Example output

```markdown
---
channel: "general"
channel-id: "123456789012345678"
server: "My Server"
synced: 2026-11-14T14:00:00.000Z
---

## alice — 2026-01-04 09:15

Check out this config

![[Discord/attachments/general/images/120938123-image.png]]

## bob — 2026-01-04 09:17

> ↩ **replying to alice:**
> Check out this config

nice, that fixed it for me too
```

## Attachment storage

Attachments are stored under the **Attachments folder** you set in the plugin settings. With both organization options on (the defaults), the layout is:

```
Discord/attachments/          ← customizable root
└── general/                  ← per-channel subfolder (toggleable)
    ├── images/               ← image attachments (toggleable)
    │   └── 120938123-image.png
    └── files/                ← PDFs, zips, everything else (toggleable)
        └── 120939456-doc.pdf
```

- **Organize attachments by channel** — each channel gets a subfolder named after it, so you always know where an image came from. Turn it off to keep everything flat in the root folder.
- **Separate images and files** — splits into `images/` and `files/` based on the attachment's content type. Turn it off to mix everything in one folder.
- Every file is prefixed with its Discord attachment ID (`120938123-image.png`), so re-syncs never overwrite or duplicate files, even across channels.

## Setup

### 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Open **Bot** → **Add Bot**, then copy the **token**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required to read message text).
4. Go to **OAuth2 → URL Generator**, check the `bot` scope, and grant these permissions:
   - View Channels
   - Read Message History
5. Open the generated URL and invite the bot to your server.

### 2. Build and install the plugin

```sh
npm install
npm run build
```

Then copy these files into your vault at `.obsidian/plugins/discord-to-obsidian/`:

- `manifest.json`
- `main.js`
- `main.css`

Enable the plugin in Obsidian's **Settings → Community plugins**.

### 3. Configure

In the plugin settings:

1. Paste your **bot token**.
2. Paste your **server (guild) ID** — enable Developer Mode in Discord (Settings → Advanced), then right-click your server → **Copy Server ID**.
3. Click **Load channel list**, then toggle the channels you want to sync.
4. Click the ribbon icon (or run **Sync selected Discord channels** from the command palette).

## Notes

- Your bot token is stored in `data.json` inside the plugin folder — **never commit it** (it's already in this repo's `.gitignore`).
- First sync pulls the most recent **Initial message limit** (default 500) messages per channel. Every sync after that only fetches new messages.
- Only regular text channels are synced (forum/thread channels are skipped in this version).
- Do **not** use a user token (self-botting) — it violates Discord's ToS and can get your account banned.

## Development

- `npm run dev` — watch mode build
- `npm run build` — typecheck + production build (`main.js`)
- Source lives in `src/`: `discord.ts` (API client), `renderer.ts` (markdown generation), `settings.ts`, `main.ts` (sync logic)
