# Learning system — phased roadmap & handoff

This doc captures the active redesign of the learning-backlog from "AI news machine" into a real learning system. It exists so a fresh Claude conversation (or a future me) can pick up without re-litigating decisions already made. **If you're a new Claude session: read this top to bottom before suggesting changes.**

## The vision

Sasha wants this system to be ultra-tailored to him — not a generic AI newsletter. The goal is twofold:

1. **Stay current** on AI / agentic engineering / Claude Code / coding agents / open models — the existing brief and curator already do this well.
2. **Gradually deepen** understanding by surfacing primary literature and foundational evergreens, reinforcing what's already been read, and capturing real learning (not just intake) over years.

The original v1 (built in a day, used for one day) optimized only for #1. This redesign adds #2 as a first-class concern.

## Architectural model: two streams + memory + audio

Three layered ideas:

**Two streams.** A *mastery* stream (the existing tiered SEED + a new Tier 6 Evergreens) holds foundational content Sasha commits to learning deeply — primary papers, canonical books, top-tier articles. An *interest* stream (new, fed by X bookmarks) holds curiosity-driven items he's bumped into. The interest stream is noisy, ephemeral, mostly never gets "promoted." But it serves as a **discovery signal for the mastery track**: the curator inspects the interest stream weekly and proposes foundational items that would resolve recurring curiosities.

**Memory loop.** Done items aren't binary — each one captures a one-sentence takeaway + optional rating. A spaced-recall cron job (memory.js) picks the most-overdue Done each morning, generates an active-recall question grounded in the takeaway, and surfaces it in both the daily brief and a PWA banner. Three response buttons (Remembered / Fuzzy / Forgot) advance the schedule: 1d → 7d → 30d → 90d → 180d (cap), halve on fuzzy, reset on forgot.

**Audio path.** Sasha has a 1.5–2 hr commute. The daily brief becomes a TTS-generated MP3 served via a private podcast RSS, listenable hands-free. A "Continue this conversation" affordance in the PWA opens an async chat with the day's brief preloaded as context — voice-in via browser SpeechRecognition. Realtime two-way voice is deferred — async-first, decide on realtime after the async UX proves the demand.

## Locked decisions (don't re-ask)

These were committed by Sasha during the planning phase. Don't surface them as open questions.

- **Storage split.** Mastery items stay in the existing `learning_state.state.items` JSONB blob. Bookmarks (interest stream) live in their own table `bookmarks` for indexable filtering. Other future tables (feedback, build_journal, memory_reviews) wait until their phases — JSONB shape decided per-phase.
- **Review cadence.** Simple 1/7/30/90/180-day intervals, halve on fuzzy, reset on forgot. Not SM-2.
- **Audio modality.** Build async first (MP3 podcast + tap-to-chat with browser SpeechRecognition). Realtime two-way voice is a possible Phase 7 if async proves the demand.
- **Feedback channels.** Both PWA thumbs-up/down AND Resend inbound webhook for substantive replies.
- **Bookmark sync mechanism.** Claude in Chrome scraping the logged-in X session at /i/bookmarks. **First run** does a deep-scroll bootstrap to capture as much history as the X UI will load; **subsequent runs** are incremental and dedupe against what's already in the `bookmarks` table. X archives do not include bookmarks (verified 2026-05-24), so there is no archive bootstrap path — `cron/import_bookmarks.js` is retained but unused for X; it remains usable for any other JSON dump source. X API ($200/mo) was rejected as overkill for personal use.

## Phase status

Six phases planned. Tasks 1–13 in the task list map 1:1 to the sub-items below.

**Phase 1 — Memory foundation. ✅ Built and deployed.**
- 1.1 Supabase: new `bookmarks` table (composite PK `(sync_id, id)`, RLS on, no direct policies, four SECURITY DEFINER RPCs: `get_bookmarks`, `upsert_bookmark`, `bulk_upsert_bookmarks`, `update_bookmark_status`). Per-item memory fields land inside the existing `state.items` JSONB — no schema change for those.
- 1.2 PWA: mark-done modal captures one-sentence takeaway + 1–5 star rating. Cmd/Ctrl+Enter saves, Esc cancels. Inline note rendering on path and backlog. Color-based dim for completed items so takeaway cards stay vivid. SW cache `v2`.
- 1.3 Briefs: new `cron/lib/state.js` parses SEED from `frontend/index.html` and reads state via `get_state`. Both briefs now inject a `## RECENT LEARNING CONTEXT` block (last 7 Dones daily, last 12 weekly) and instruct Claude to connect today's news to what Sasha just learned. Best-effort degradation if state is unreachable.

**Phase 2 — Spaced recall. ✅ Built. Awaiting user verification.**
- `cron/memory.js` runs at 6:25 AM weekdays (5 min before daily brief), picks one due Done, asks Claude (no web search, cheap and grounded) for one active-recall question, writes to `state.pendingMemory`. Idempotent. `--force` flag for testing.
- `cron/scheduler.js` updated with the new schedule.
- `cron/daily_brief.js` prepends a `## Memory` section when `pendingMemory.generatedFor === today`.
- `cron/lib/state.js` gained `saveState` (with optimistic-concurrency via `if_unchanged_since`) and `getItemById`. Hidden `__rowUpdatedAt` on loaded state for the OCC token.
- `cron/lib/claude.js` got a `noSearch: true` option to omit the web_search tool.
- Frontend: yellow recall banner above tabs with three response buttons. `respondToRecall(outcome)` advances `reviewStep` + `nextReviewAt`, clears `pendingMemory`. `mergeStates` updated to carry `pendingMemory` with outer-updatedAt collision handling. Initial review at +1 day (Ebbinghaus). SW cache `v3`.

**Phase 3 — Audio. ⏳ Pending.**
- 3a: TTS pipeline (provider TBD — compare OpenAI tts-1-hd vs Cartesia Sonic vs ElevenLabs at start of phase). MP3 to Cloudflare R2. Tiny Worker exposes a signed-URL private podcast RSS. Subscribe in Overcast.
- 3b: In-PWA chat surface, opened by a "Continue this conversation" button on brief items in the PWA reader. Loads with the day's brief Markdown injected as system context. Browser SpeechRecognition for voice-in. Persists conversations per-brief.

**Phase 4 — Evergreens + curator broadening. ⏳ Pending.**
- Add Tier 6: Evergreens to SEED (DDIA, Crafting Interpreters, Attention Is All You Need, GPT-3 paper, FlashAttention, InstructGPT/RLHF paper, CSAPP, CRDT primer, Postgres internals). `evergreen: true` flag — curator skips on removals.
- Broaden `cron/curator.js` source list: HF Daily Papers (filtered), Hamel Husain, Eugene Yan, one skeptic.
- Wire `rereadEvery` (days) so items with cadence re-enter the queue automatically.

**Phase 5 — Build loop + feedback. ⏳ Pending.**
- 5.1: New `build` item type. `cron/build_challenge.js` runs Saturday morning, picks a 60–90 min challenge matched to recent Dones, emails it. Separate `build_journal` array in state.
- 5.2: PWA thumbs up/down per brief item → small `feedback` table keyed by brief date + item index. Resend inbound webhook → Cloudflare Worker / Supabase Edge Function → Claude parses replies → stored as feedback, fires deep-dive responses for substantive asks. Both signals inject into the next brief's prompt.

**Phase 6 — X bookmarks integration. 🟡 6.1/6.2 done; 6.3/6.4 pending.**
- 6.1: 🟡 Built, but the archive bootstrap path is moot for X. `cron/import_bookmarks.js` works end-to-end (verified against a synthetic fixture), but X archives don't include bookmarks — verified 2026-05-24 by inspecting the actual archive. Script retained for any other JSON dump source. Refactored 2026-05-24 onto shared `cron/lib/tag.js` (no behavior change).
- 6.2: ✅ Built and live. **Architecture pivot from the original plan:** Claude-in-Chrome is a browser-side extension paired with a Claude.ai session — it cannot be driven from the headless cron container. So the scrape is **manual**: drive a Claude.ai session via the Chrome extension at x.com/i/bookmarks, dump bookmarks as JSON (file-download channel, not pasted into chat — Claude-in-Chrome's response filter blocks `key=value` substrings such as image URL query params and tweet bodies containing `--flag=value`), drop the file at `./data/x_bookmarks_NNN.json`, then `docker compose exec cron node sync_bookmarks.js --file …`. The cron-side script normalizes, dedupes vs the existing `bookmarks` table, tags new items via shared `tagBatch`, bulk-upserts as `source='x'`, and bumps `state.lastBookmarkSync` via `saveState` with OCC. **Scope deferred:** no `scheduler.js` entry (sync is manual), no PWA "Sync now" button (waits for 6.3 Interest tab). **Fields preserved in `content` as markers** (no schema migration): `[truncated]` when "Show more" was visible, `[link: title — desc | url]` for external link cards with a real title, `[image_url: <pbs.twimg.com URL>]` per attached image — the last of which is the hook for the next-session image-vision enrichment. Image-URL markers are stripped before tagging (waste tokens) but stay in the stored row. Verified 2026-05-24: 180 real bookmarks ingested, 77 with image markers, 44 truncated, 143/180 tagged. The `cron/lib/tag.js` `normalize()` and `tagBatch()` are the load-bearing shared pieces; do not duplicate them when 6.3/6.4 need parsing.
- 6.3: ⏳ Pending. New "Interest" tab in PWA showing bookmarks with original tweet text, Claude's tag, "Promote to mastery" action. Also: tiny PWA "Sync now" button (deferred from 6.2 — still needs an endpoint architecture; see open question in the original 6.2 plan).
- 6.4: ⏳ Pending. Curator inspects interest stream weekly and proposes foundational items for Tier 6 that would resolve recurring themes. Daily/weekly briefs receive the last ~10 bookmarks alongside the last 7 Dones. memory.js can surface a related bookmark when reviewing a mastery item.

**Phase 6.2.5 — Image vision enrichment for X bookmarks. ⏳ Pending (next chat).**
- Bookmarks ingested by 6.2 carry `[image_url: <pbs.twimg.com URL>]` markers in `content` for every attached image. Build a small cron-side script (`cron/enrich_bookmarks.js` or similar) that finds rows with `[image_url:` markers, calls Claude vision via the existing Anthropic SDK with the image URLs, replaces each marker with an `[image: <transcription/description>]` block following the spec from the earlier Prompt 1 (transcribe text screenshots verbatim up to ~500 chars, describe charts/diagrams/photos appropriately), and upserts. Idempotent: rerun against the same bookmarks is a no-op once markers are replaced. Run on demand, not on cron, initially. Will need an `askVision()` helper added to `cron/lib/claude.js` (image-URL inputs via Anthropic SDK's `messages.create`).

## Open items / what to do next

1. **Verify Phase 2 in practice.** Sasha has only one Done item at the moment (an item completed yesterday). Trigger the recall manually:
   ```bash
   docker compose exec cron node memory.js --force
   ```
   Refresh the PWA — yellow recall banner should appear above the tabs. Tap a button and confirm `nextReviewAt` updated. Also confirm the brief shows the `## Memory` section:
   ```bash
   docker compose exec cron node daily_brief.js
   ```
   First moment of truth: does Claude generate a recall question that actually tests understanding, or does it surface-skim the title? If weak, tune the PROMPT in `cron/memory.js`.

2. **Phase 6.2.5 image-vision enrichment is the active piece of work.** See "For the next chat: starting Phase 6.2.5" below.

3. **Phase 3a (audio) is queued after 6.x.** Biggest UX shift. Don't start until at least 6.3 is working so audio has bookmarks to talk about.

## For the next chat: starting Phase 6.2.5 (image enrichment)

Everything in 6.2 is shipped and live. 180 real X bookmarks are in `bookmarks` (source='x'). Image enrichment is the next clean unit of work.

**What's already in place:**
- `cron/lib/tag.js` — shared `normalize(entry, { source })` and `tagBatch(items)`. `normalize` already folds `[image_url: <pbs.twimg.com URL>]` markers into `content` per image. `tagBatch` strips those markers before sending text to Claude for tagging (`contentForTagging` helper) so they don't waste the 400-char window.
- `cron/sync_bookmarks.js` — the manual ingest pipeline. Idempotent. Reads `data/x_bookmarks_NNN.json` (the file-download channel from Claude-in-Chrome). Adding new bookmarks won't repeat enrichment if those rows already have `[image: ...]` blocks.
- `cron/lib/claude.js` — `ask(prompt, { noSearch: true })` for cheap text-only Claude calls. **Does not yet support image inputs** — you'll need to add an `askVision(prompt, imageUrls, opts)` helper that calls `client.messages.create` with content blocks of `{ type: "image", source: { type: "url", url: ... } }`. Anthropic SDK supports this natively.
- Supabase `bookmarks` table + RPCs (`get_bookmarks`, `upsert_bookmark`, `bulk_upsert_bookmarks`, `update_bookmark_status`). No schema migration needed for enrichment — replacing `[image_url:]` markers with `[image:]` blocks is just a `content` rewrite.

**What you need to build:**
- `cron/enrich_bookmarks.js` — entry point. Queries `get_bookmarks` filtered to rows containing `[image_url:` markers in `content`. For each row, parse the image URLs (one per marker line), call `askVision()` once per image (or batch a small number per call) with a prompt that follows the same content rules as the original Prompt 1 in the 6.2 chat (transcribe text screenshots verbatim ≤500 chars + `[…]`, describe charts/diagrams/photos succinctly). Replace each `[image_url: <url>]` line with the corresponding `[image: <content>]` block. Upsert via `upsert_bookmark`. Idempotent: a second run is a no-op once markers are replaced.
- CLI flags mirroring the other scripts: `--dry-run`, `--limit N`, `--id <tweetId>` for targeted testing. Honor `IMPORT_DEBUG`.
- Failure handling: image fetch / vision errors should emit `[image: <unreadable>]` (a sentinel that won't be retried) for that image only and continue with the rest. Never crash the loop on one bad image — `pbs.twimg.com` can 404, and that's fine.
- Don't add to `scheduler.js` initially. Run on demand: `docker compose exec cron node enrich_bookmarks.js`.

**Open questions for the next chat:**
- Should we normalize `pbs.twimg.com` URLs to `name=large` (better resolution for OCR) before passing to vision? The scrape captured `name=medium` for some.
- Batching strategy: one image per vision call (simpler, more requests) vs N images per call (cheaper, but each image gets less attention from the model). Start with one-per-call.
- Cost ceiling: 77 image-bearing rows × maybe 1.5 images avg = ~115 vision calls for batch 1. At Opus rates that's a few dollars. Sasha will likely want to confirm before running.

## Phase 6.2 architecture (locked, for context)

The original PLAN.md described 6.2 as a single autonomous cron job using "Claude-in-Chrome MCP" from inside the cron container. That turned out to be wrong: the Chrome extension is paired with a Claude.ai session and cannot run inside the headless `node:22-alpine` cron container. The shipped architecture is **manual scrape + cron ingest**:
1. Sasha drives a Claude.ai session (Chrome extension active) at `x.com/i/bookmarks`. Pure-DOM extraction (no vision in this pass), chunked at 250 items/batch, output via file-download (NOT pasted into chat — Claude-in-Chrome's response filter blocks `key=value` substrings such as image URL query params and tweet bodies with `--flag=value`).
2. Sasha drops the resulting `data/x_bookmarks_NNN.json` into the repo and runs `docker compose exec cron node sync_bookmarks.js --file /app/data/x_bookmarks_NNN.json`.
3. The script normalizes (folds `[truncated]`, `[link: ...]`, `[image_url: ...]` markers into `content`), dedupes vs Supabase, tags the new rows via `tagBatch` (image-URL markers stripped from the tagging input), bulk-upserts as `source='x'`, and bumps `state.lastBookmarkSync` via OCC `saveState`.

This sidesteps both the "headless container has no Chrome" problem and the response-filter problem in one move. PWA "Sync now" button is deferred to 6.3; scheduler entry is deferred until/unless autonomous scraping arrives.

## Conventions and gotchas

These are specific to this redesign and not in CLAUDE.md.

- **SEED markers are sacred.** `// SEED_START` / `// SEED_END` in `frontend/index.html` are parsed by `cron/curator.js` AND `cron/lib/state.js`. Don't move or rename them — the regex match in curator.js throws if they drift.
- **Anon key publishability.** The committed `sb_publishable_…` key in `frontend/index.html` is a *Supabase publishable key*, intentional and safe. RLS + SECURITY DEFINER RPCs gate access. Don't "fix" this.
- **Service worker cache versioning.** Bump `CACHE_VERSION` in `frontend/sw.js` whenever the shell changes. PWAs on iOS are sticky — SW updates can take a session to activate even with `skipWaiting`. Tell Sasha to unregister + hard refresh if a deploy doesn't seem to apply.
- **Bind-mount means code edits are live in cron.** Editing files in `cron/` updates the container immediately — no rebuild. Only `package.json` changes need `docker compose build cron`.
- **Optimistic concurrency in `set_state`.** Memory.js passes `if_unchanged_since` so concurrent PWA writes don't get clobbered. New cron jobs that write state should follow the same pattern.
- **`mergeStates` in `frontend/index.html`.** Per-item last-write-wins via item.updatedAt. Top-level fields (`collapsed`, `pendingMemory`) use outer `state.updatedAt`. New top-level fields need to be added to mergeStates explicitly or they'll be lost on pull.
- **Per-item memory fields live in JSONB.** `completedAt`, `note`, `rating`, `lastReviewedAt`, `nextReviewAt`, `reviewStep`, `evergreen`, `rereadEvery`, `stream`, `source`, `sourceUrl`, `tags`, `promotedAt` all sit inside each `state.items[id]` value. No schema migration needed when adding more.
- **The `state.pendingMemory` shape.** `{ itemId, question, generatedAt (iso), generatedFor (yyyy-mm-dd), reviewedNoteAt (iso) }`. `daily_brief.js` only renders it if `generatedFor === today's date`.
- **`LEARNING_SYNC_ID` in `.env`.** Required for cron to read state. Sasha's value: `gdukt-wb8dc-rwfk2-yzyw6`. If `.env` doesn't have it on the host, `state.js` degrades gracefully.

## Deployment cheatsheet

```bash
# After frontend OR cron code edits — push triggers Cloudflare Pages
git push

# Cron code-only changes (no new deps): restart
docker compose restart cron

# Cron package.json changes (e.g., Phase 1 added @supabase/supabase-js): rebuild
docker compose build cron && docker compose up -d cron

# Manually fire a job for testing
docker compose exec cron node memory.js --force
docker compose exec cron node daily_brief.js
docker compose exec cron node weekly_brief.js
docker compose exec cron node curator.js

# Tail logs
docker compose logs -f cron
```

## Where the data lives

- **`learning_state`** (Supabase): one JSONB blob per sync_id. Holds `items` (dict by id), `custom`, `collapsed`, `pendingMemory`, `updatedAt`, future `lastBookmarkSync`. Access via `get_state` / `set_state` SECURITY DEFINER RPCs.
- **`bookmarks`** (Supabase): one row per (sync_id, id) for the interest stream. Access via `get_bookmarks` / `upsert_bookmark` / `bulk_upsert_bookmarks` / `update_bookmark_status` RPCs. Populated by Phase 6.
- **`frontend/index.html`** SEED constant: the canonical mastery item catalog. The curator writes to it; everything else reads it.
- **`.env`** on the host: secrets (Anthropic/Resend keys) + `LEARNING_SYNC_ID`. Gitignored.
