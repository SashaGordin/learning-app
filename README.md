# Learning Backlog — self-hosted

A personal learning-curation system with three pieces:

1. **PWA frontend** (`frontend/`) — multiple sequenced learning paths over one shared resource backlog. Installable on iOS / Android home screens.
2. **Docker stack** (`docker-compose.yml`) — Caddy serves the local copy at `http://localhost:8080`, and a cron container generates spaced-recall questions and runs the weekly backlog curator.
3. **Supabase backend** — a single table (`learning_state`) keyed by a sync code. Phone and laptop share the same row so progress stays in sync.

## Learning paths

The PWA currently includes Agentic Engineering, LLM Foundations, and Claude Code Mastery. Paths are curriculum views over the same resources: completing an item, adding a takeaway, or scheduling a recall review applies everywhere that item appears.

The original `tier`, `order`, and `prereqs` fields in `SEED` define the backward-compatible Agentic Engineering path. Additional curricula live in `LEARNING_PATHS` and `PATH_PLACEMENTS` in `frontend/index.html`, so a resource can have path-specific ordering and prerequisites without being duplicated. The weekly curator continues adding resources to the default path unless a specialized path is edited intentionally.

## What runs when

| Job | Schedule | What it does | Output |
|---|---|---|---|
| `memory.js` | Weekdays 6:25 AM | Generates one due active-recall question plus answer rubric | PWA recall card |
| `grade_memory.js` | Every 2 minutes | Grades submitted explanations and updates mastery, review timing, and path recommendations | PWA feedback + learner profile |
| `curator.js` | Sunday 8:00 PM | Adds 0-3 high-signal items to the backlog SEED, prunes stale ones | Email summary + rewrites `frontend/index.html` |

Daily and weekly newsletter briefs were intentionally removed: they duplicated a normal AI newsletter without improving the learning loop. The schedules are defined in `cron/scheduler.js`.

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
- `cron` — the Node scheduler that triggers spaced recall and the curator.

Check it's healthy:

```bash
docker compose ps
docker compose logs -f cron     # should print "[scheduler] started (TZ=…)"
```

Smoke-test the recall pipeline after marking an item Done through the PWA:

```bash
docker compose exec cron node memory.js --force
```

The generated question should appear above the PWA tabs. Choosing Remembered, Fuzzy, or Forgot opens an explanation prompt; only the submitted answer can update mastery and the next review date. The grader normally returns feedback within two minutes.

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
- Recall responses are merged by review id so a browser edit cannot replace a remotely graded answer with an older pending copy.
- The sync code is the secret. Anyone with it can read/write that row. The data is low-stakes (which podcasts you've listened to), so this is fine — but don't share your sync code.

The Supabase table has RLS enabled with no direct policies; all access is gated through two `SECURITY DEFINER` RPCs that require the sync code. There's no way to enumerate other sync codes from the table.

## Common operations

```bash
# Tail recall and curator output
docker compose logs -f cron

# Manually trigger recall or a curator run
docker compose exec cron node memory.js --force
docker compose exec cron node grade_memory.js
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
│   ├── scheduler.js        node-cron — runs recall generation/grading + curator
│   ├── memory.js           spaced-recall question + rubric generator
│   ├── grade_memory.js     explanation grader + mastery/path updater
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

- **Anthropic**: each completed recall uses one small no-search request to generate the question and one to grade the explanation; the weekly curator uses web search. Bookmark analysis is manual/on-demand and is the largest variable cost.
- **Supabase**: free tier easily covers this — you'll have one row of a few KB.
- **Resend**: free up to 100 emails/day, far more than this needs.
- **Cloudflare Pages**: free.

## Troubleshooting

**The PWA loads but the sync pill says "Sync disabled"**
The `<meta name="supabase-url">` and `<meta name="supabase-anon-key">` tags at the top of `frontend/index.html` are empty. The committed values should be present — if they got wiped, restore them from `.env.example`.

**Recall cards aren't appearing**
```bash
docker compose exec cron node memory.js --force
```
The item must be Done; legacy Done rows are migrated from their item `updatedAt` when selected. Also verify `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `LEARNING_SYNC_ID` point to the active project.

**Sync conflicts**
Last-write-wins per item. If you mark something done on device A while offline, then mark it skipped on device B, the later one wins when both reconnect. Worst case, use the Export JSON button in Settings before reconciling.

**Cron isn't firing**
Verify the timezone: `docker compose exec cron node -e 'console.log(new Date().toString())'`. If it shows UTC, set `TZ` in `.env` to your zone (e.g. `America/New_York`) and `docker compose up -d`.
