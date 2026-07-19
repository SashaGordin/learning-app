# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this repo is

A single-user, self-hosted learning-backlog system. Three pieces, all in this repo:

- `frontend/` — a static PWA (one big `index.html` + service worker). No build step, no framework, no bundler. Served locally by Caddy at `http://localhost:8080` and publicly by Cloudflare Pages, which auto-deploys from the GitHub `main` branch with **Build output directory = `frontend`**.
- `cron/` — a Node 20 ESM container. `scheduler.js` runs `memory.js` on weekday mornings, `grade_memory.js` every two minutes, and `curator.js` weekly via `node-cron`. The newsletter-style daily and weekly briefs were intentionally removed. AI calls use `lib/claude.js`; curator/failure emails use `lib/email.js`.
- A Supabase project providing two `SECURITY DEFINER` RPCs — `get_state(p_sync_id)` and `set_state(p_sync_id, p_state)` — that gate access to a `learning_state` table keyed by sync code. RLS is on; there are no direct table policies. The schema lives in the Supabase project, not in this repo.

There are no tests, no linter, no TypeScript, and no package manager lockfile in the frontend.

## Non-obvious architecture

**The curator rewrites `frontend/index.html` in place.** `cron/curator.js` reads the file, locates the `// SEED_START` / `// SEED_END` and `// CHANGELOG_START` / `// CHANGELOG_END` comment markers, parses the two JS arrays between them via `vm.runInContext`, asks Codex for additions/removals, then splices the regenerated arrays back between the markers. **Never remove or rename those markers** — the regex match in `curator.js:16-18` will throw and the run will fail.

**Supabase config is committed into `frontend/index.html`.** The `<meta name="supabase-url">` and `<meta name="supabase-anon-key">` tags hold real values in the source. The anon key is a Supabase *publishable* key (`sb_publishable_…`) — it's designed to be public and is safe to commit; RLS + the two `SECURITY DEFINER` RPCs are what gate access. The legacy `deploy.sh` script substitutes these tags from `.env` and is no longer the primary deploy path (see next point), but it still works if you ever need to deploy without a public commit.

**Sync model.** First page load generates a random `sync_id`, persists it to `localStorage`, then debounces writes (800ms) to `set_state` and polls `get_state` every 30s (and on tab focus). Per-item merge uses `updatedAt` timestamps — last-write-wins per row, not per document, so two devices can edit different items concurrently without clobbering. The sync code is the only auth; anyone with it can read/write that row.

**Docker volume mounts matter.** `docker-compose.yml` mounts `./frontend` read-write into the cron container so the curator can write back to `index.html`, and mounts `./cron` over the image's `/app/cron` for live iteration. Editing files on the host updates the container immediately; no rebuild needed for code changes (only for `package.json`).

**The Anthropic wrapper is intentionally thin.** `cron/lib/claude.js` calls `client.messages.create` with the `web_search_20250305` tool. Web search runs server-side, so the final response already contains the synthesized text — there is no client-side tool loop to maintain. Default model is `claude-opus-4-7`; override with `CLAUDE_MODEL`.

## Commands

```bash
# Local dev (Docker)
docker compose up -d --build           # bring up caddy + cron
docker compose logs -f cron            # watch scheduler / job output
docker compose restart cron            # apply changes to scheduler.js or prompts
docker compose down                    # stop everything

# Manually invoke jobs (inside the cron container)
docker compose exec cron node memory.js --force
docker compose exec cron node grade_memory.js
docker compose exec cron node sync_concepts_to_state.js
docker compose exec cron node curator.js

# Deploy the PWA — just push. Cloudflare Pages auto-builds from `main`.
git push                               # triggers a deploy at https://learning-app-3w5.pages.dev
./deploy.sh                            # legacy: manual wrangler deploy from .env (rarely needed)
```

There is no `npm test`, no `npm run lint`, no build step. Iterate by running the scripts directly.

## When making changes

- **Editing prompts or schedules in `cron/`** — change the file, then `docker compose restart cron`. For a one-shot test, `docker compose exec cron node <script>.js`.
- **Editing the PWA** — refresh `localhost:8080`. The service worker (`sw.js`) bumps cache via `CACHE_VERSION`; bump it if you change the cached shell. Cloudflare auto-deploys on `git push` to `main`.
- **Adding a SEED item by hand** — edit between the `// SEED_START` / `// SEED_END` markers in `frontend/index.html`. Keep the `const SEED = [ ... ];` shape intact so the curator's parser doesn't choke.
- **Adding a Supabase column or RPC** — schema is not in this repo; use the Supabase MCP tools or dashboard. After schema changes that affect sync, the frontend's `loadFromServer` / `saveToServer` logic in `index.html` (~line 600-640) is the only client.
- **Adding a new cron job** — add a script under `cron/`, register it in `scheduler.js`, and `docker compose restart cron`. Don't add a `npm` script unless you actually need it; the container's CMD is `node scheduler.js`.
- **Concept note privacy** — `concepts/*.md` stays gitignored/private. `analyze_bookmarks.js` stores full note content in sync-protected `state.insights[].content`; never copy the notes into public `frontend/` assets.

## Active redesign — read PLAN.md first

There is an ongoing phased redesign turning this from a frontier-news machine into a real learning system: multiple mastery paths, spaced recall, an interest stream from X bookmarks, build challenges, and feedback. Newsletter briefs are explicitly out of scope. Phase 2 is PWA-first via `cron/memory.js`; later outputs should surface in the app rather than recurring news emails.

**Before suggesting architectural changes or starting new work, read `PLAN.md` at the repo root.** It contains locked decisions (so they don't get re-asked), the phase-by-phase status, conventions specific to this work that aren't in this file, and a deployment cheatsheet. The TL;DR is that user preferences are committed for: split storage (mastery in JSONB, bookmarks in their own table), 1/7/30/90/180-day review cadence, async-first audio, dual feedback channels, and Codex-in-Chrome scraping for X bookmarks.

## Conventions

- Node 20, ESM only (`"type": "module"` in `cron/package.json`). Use `import`, top-level await is fine.
- Frontend is plain HTML/CSS/JS, no framework. Keep it that way — the file is meant to be inspectable in a browser without tooling.
- Markdown → HTML in curator/failure emails goes through `marked` and `wrapHtml` in `cron/lib/email.js`. Don't add a different renderer.
- Do not reintroduce daily or weekly newsletter jobs. New recurring outputs should close a learning loop in the PWA.
