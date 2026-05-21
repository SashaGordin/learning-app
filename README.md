# Learning Backlog — self-hosted

A personal learning-curation system with three pieces:

1. **PWA frontend** (`frontend/`) — your sequenced learning path and backlog. Installable on iOS / Android home screens.
2. **Docker stack** (`docker-compose.yml`) — Caddy serves the local copy at `http://localhost:8080`, and a cron container runs the daily brief, weekly brief, and weekly backlog curator.
3. **Supabase backend** — a single table (`learning_state`) keyed by a sync code. Phone and laptop share the same row so progress stays in sync.

## What runs when

| Job | Schedule | What it does | Output |
|---|---|---|---|
| `daily_brief.js` | Weekdays 6:30 AM | ~5 min read of the past 24-48 hrs in AI/agentic engineering | Email |
| `weekly_brief.js` | Sunday 5:00 PM | ~15-20 min deep synthesis of the past week | Email |
| `curator.js` | Sunday 8:00 PM | Adds 0-3 high-signal items to the backlog SEED, prunes stale ones | Email summary + rewrites `frontend/index.html` |

The schedules are defined in `cron/scheduler.js`. Edit there if you want different times.

## One-time setup

### 1. Get the four required credentials

- **Anthropic API key** — https://console.anthropic.com/settings/keys. Used by the cron container.
- **Resend API key** — https://resend.com (free tier is 100 emails/day, no card required). For email delivery.
- **Supabase project** — already provisioned (`learning-backlog`, URL and anon key are pre-filled in `.env.example`).
- **Cloudflare account** — https://dash.cloudflare.com/sign-up. Free. For hosting the phone PWA.

### 2. Configure environment

```bash
cd learning-app/
cp .env.example .env
# Edit .env — fill in ANTHROPIC_API_KEY, RESEND_API_KEY, RECIPIENT_EMAIL.
# Supabase values are already filled in.
```

### 3. Start the Docker stack

```bash
docker compose up -d --build
```

This brings up:
- `caddy` on `http://localhost:8080` — open in your browser to use the PWA locally.
- `cron` — the Node scheduler that triggers the briefs and curator.

Check it's healthy:

```bash
docker compose ps
docker compose logs -f cron     # should print "[scheduler] started (TZ=…)"
```

Smoke-test by manually running a brief:

```bash
docker compose exec cron node daily_brief.js
```

If your Anthropic key, Resend key, and recipient email are set, you should see the brief land in your inbox within ~30 seconds.

## Phone install (the "as an app" part)

The phone version is hosted on Cloudflare Pages — free, real HTTPS, installable.

### 1. First-time Cloudflare Pages setup

In the Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git** → pick the `learning-app` repo. In build settings:

- **Framework preset:** None
- **Build command:** (leave empty)
- **Build output directory:** `frontend`
- **Root directory:** `/`

Save and deploy. Cloudflare gives you a URL like `https://learning-app-3w5.pages.dev`. Every `git push` to `main` triggers a fresh deploy automatically.

The Supabase URL and anon publishable key are committed in `frontend/index.html`'s `<meta>` tags, so no environment variables are needed in Cloudflare. (The anon key is publishable by design — RLS + `SECURITY DEFINER` RPCs gate actual access.)

The legacy `./deploy.sh` script still works for one-off manual deploys via `wrangler` if you ever want to bypass GitHub, but the GitHub integration is the primary path.

### 2. Install on iOS (Safari)

1. Open the Pages URL in **Safari** (not Chrome — Chrome on iOS can't install PWAs).
2. Tap the share icon → **Add to Home Screen**.
3. The icon appears on your home screen. It opens in full-screen mode and feels like a native app.

### 3. Install on Android (Chrome)

1. Open the Pages URL in Chrome.
2. You'll see an "Add to home screen" banner, or tap the three-dot menu → **Install app**.
3. Same deal — icon on home screen, opens standalone.

### 4. Pair the devices

Both devices need to share the same sync code:

1. On your laptop (`http://localhost:8080`), tap **Settings**. You'll see your sync code — copy it.
2. On your phone, open the PWA, tap **Settings**, paste the code into "Pair another device", tap **Pair**. The page reloads with the laptop's progress.
3. From now on, marking something done on one device shows up on the other within ~30 seconds.

If you'd rather use the phone's code, do the reverse direction.

## How the curator updates the deployed PWA

The curator container writes to `frontend/index.html` (via the mounted volume). That updates the **local** copy immediately. To push those updates to the **cloud** copy (and therefore to your phone), commit and push the change — Cloudflare Pages auto-deploys on push to `main`.

You can wire this up to auto-commit/push after each curator run by appending a `git` step to `cron/curator.js`, but you'd need to mount a credential into the cron container. Easier: review the curator's email summary and `git add frontend/index.html && git commit && git push` from the host when you like the changes.

…and mounting `deploy.sh` into the cron container in `docker-compose.yml`. Skipped here to keep the v1 simple; deploy by hand after curator runs (the curator emails you a summary, so you'll know when there's something to deploy).

## How sync actually works

- The PWA generates a random sync code on first load and saves it to `localStorage` as `sync_id`.
- Every state change calls Supabase RPC `set_state(p_sync_id, p_state)` after an 800ms debounce.
- The page polls `get_state(p_sync_id)` every 30 seconds and on tab focus.
- Server state and local state are merged per-item using `updatedAt` timestamps (last write wins per row), so concurrent edits on different devices don't clobber each other.
- The sync code is the secret. Anyone with it can read/write that row. The data is low-stakes (which podcasts you've listened to), so this is fine — but don't share your sync code.

The Supabase table has RLS enabled with no direct policies; all access is gated through two `SECURITY DEFINER` RPCs that require the sync code. There's no way to enumerate other sync codes from the table.

## Common operations

```bash
# Tail cron logs (briefs and curator output appear here)
docker compose logs -f cron

# Manually trigger a brief or curator run
docker compose exec cron node daily_brief.js
docker compose exec cron node weekly_brief.js
docker compose exec cron node curator.js

# Restart after editing scheduler.js or prompts
docker compose restart cron

# Pull latest images and rebuild
docker compose down
docker compose up -d --build

# Redeploy the PWA after a curator run or HTML edit
git add frontend/index.html && git commit -m "Curator update" && git push
```

## File map

```
learning-app/
├── frontend/
│   ├── index.html          PWA — SEED items + Supabase sync via RPC + service worker
│   ├── manifest.json       PWA manifest
│   ├── sw.js               Service worker (offline shell)
│   ├── icon-192.png
│   └── icon-512.png
├── cron/
│   ├── Dockerfile
│   ├── package.json
│   ├── scheduler.js        node-cron — runs the three scripts on schedule
│   ├── daily_brief.js
│   ├── weekly_brief.js
│   ├── curator.js
│   └── lib/
│       ├── claude.js       Anthropic API wrapper (uses web_search tool)
│       └── email.js        Resend wrapper with Markdown → HTML
├── Caddyfile               Static server config for the local copy
├── docker-compose.yml
├── deploy.sh               Legacy manual wrangler deploy (GitHub auto-deploy supersedes)
├── .env.example
└── README.md
```

## Cost expectations

- **Anthropic**: each daily brief = roughly 5-7 web searches + a few thousand output tokens. Estimate ~$0.10/day. Weekly brief ~$0.30. Curator ~$0.20. Round numbers: under $10/month.
- **Supabase**: free tier easily covers this — you'll have one row of a few KB.
- **Resend**: free up to 100 emails/day, far more than this needs.
- **Cloudflare Pages**: free.

## Troubleshooting

**The PWA loads but the sync pill says "Sync disabled"**
The `<meta name="supabase-url">` and `<meta name="supabase-anon-key">` tags at the top of `frontend/index.html` are empty. The committed values should be present — if they got wiped, restore them from `.env.example`.

**Briefs aren't arriving**
```bash
docker compose exec cron node daily_brief.js
```
If it prints `[email] RESEND_API_KEY not set`, your `.env` isn't being read. If you get a Resend 4xx, your sender domain isn't verified — use `briefs@resend.dev` until you add a domain to your Resend account.

**Sync conflicts**
Last-write-wins per item. If you mark something done on device A while offline, then mark it skipped on device B, the later one wins when both reconnect. Worst case, use the Export JSON button in Settings before reconciling.

**Cron isn't firing**
Verify the timezone: `docker compose exec cron node -e 'console.log(new Date().toString())'`. If it shows UTC, set `TZ` in `.env` to your zone (e.g. `America/New_York`) and `docker compose up -d`.
