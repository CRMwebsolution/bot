# Agent updates

Shared handoff for Codex, Antigravity, Grok, and later agents. Append a new entry when changes are pushed. Do not rewrite older entries.

## 2026-10-15 9:45 AM EDT — Grok (Grok 4.7)

### What it did

Built the local n8n Bot Hub PWA in this folder. It was not committed or pushed.

- `server.js` stores bots and messages in SQLite, accepts image and audio uploads, forwards outgoing messages to each bot's n8n webhook as multipart form data, and publishes changes on `GET /api/events`.
- `public/` is the installable dark chat UI: channel drawer, composer, Markdown, image paste/preview, voice notes, inline buttons, and the per-channel webhook snippet modal.
- Tailwind source is `public/tailwind.css`. Compiled CSS is `public/styles.css`.

### Database changes

- Local SQLite file `data/hub.sqlite`, created automatically on startup. Not a hosted Supabase database.
- Tables: `bots`, `messages`. Index: `idx_messages_bot_time`. `user_version` is 1.
- No hosted migration, RLS policy, or storage bucket.

### Other relevant changes

- Run with `npm install` and `npm start`. The app listens on `0.0.0.0:3000`.
- Rebuild CSS with `npm run build:css` after changing `public/tailwind.css` or class names.
- `data/*` and `uploads/*` are gitignored. Uploaded media is served from `/uploads`.
- Outgoing n8n fields: `botId`, `messageId`, `timestamp`, `type`, `text`, `file`, plus `action`, `data`, and `sourceMessageId` for button presses.
- Incoming n8n calls `POST /api/webhook/:botId` with JSON or multipart. A Respond to Webhook body can include `text`, `imageUrl`, and `buttons`. The default `{ "message": "Workflow was started" }` ack is ignored.
- There is no login. Keep the hub on a private network.
- Microphone recording and home-screen install need localhost or HTTPS. Plain HTTP on a LAN IP still supports text and image upload.
- Message times render in America/New_York.
- Push status: not pushed.

## 2026-10-15 10:20 AM EDT — Grok (Grok 4.7)

### What it did

Pushed the initial n8n Bot Hub to `https://github.com/CRMwebsolution/bot.git` on `main`.

The commit includes `server.js`, the PWA in `public/`, `package.json`, `package-lock.json`, and `.gitignore`.

### Database changes

- None in this push. SQLite is created locally at runtime and is not in the repository.

### Other relevant changes

- Remote: `origin` `https://github.com/CRMwebsolution/bot.git`
- Branch: `main`
- `node_modules/`, `data/hub.sqlite`, and `uploads/*` were not committed.
- No production deploy.
