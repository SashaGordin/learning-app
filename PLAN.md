# Learning system — phased roadmap & handoff

This doc captures the active redesign of the learning-backlog from "AI news machine" into a real learning system. It exists so a fresh Claude conversation (or a future me) can pick up without re-litigating decisions already made. **If you're a new Claude session: read this top to bottom before suggesting changes.**

## The vision

Sasha wants this system to be ultra-tailored to him — not a generic AI newsletter. The goal is twofold:

1. **Stay current selectively** on AI / agentic engineering / Claude Code / coding agents / open models through curation, not recurring news summaries.
2. **Gradually deepen** understanding by surfacing primary literature and foundational evergreens, reinforcing what's already been read, and capturing real learning (not just intake) over years.

The original v1 (built in a day, used for one day) optimized only for #1. This redesign adds #2 as a first-class concern.

## Architectural model: two streams + memory + audio

Three layered ideas:

**Two streams.** A *mastery* stream (the existing tiered SEED + a new Tier 6 Evergreens) holds foundational content Sasha commits to learning deeply — primary papers, canonical books, top-tier articles. An *interest* stream (new, fed by X bookmarks) holds curiosity-driven items he's bumped into. The interest stream is noisy, ephemeral, mostly never gets "promoted." But it serves as a **discovery signal for the mastery track**: the curator inspects the interest stream weekly and proposes foundational items that would resolve recurring curiosities.

**Memory loop.** Done items aren't binary — each one captures a one-sentence takeaway + optional rating. A spaced-recall cron job (`memory.js`) picks the most-overdue Done each morning, generates an active-recall question plus answer rubric, and surfaces it in the PWA. Remembered / Fuzzy / Forgot records confidence but always opens a required explanation prompt. `grade_memory.js` judges the demonstrated knowledge, provides reinforcement, updates the learner profile, and adapts review timing plus recommended next steps. Correct answers advance 1d → 7d → 30d → 90d → 180d (cap); partial answers repeat sooner; incorrect answers reset to 1d.

**Optional audio path.** Sasha has a 1.5–2 hr commute, but a spoken newsletter has the same intake problem as an emailed one. If audio is built, it must be an active-learning surface: recall, one concept, one experiment, and a response loop—not a news recap.

## Locked decisions (don't re-ask)

These were committed by Sasha during the planning phase. Don't surface them as open questions.

- **Storage split.** Mastery items stay in the existing `learning_state.state.items` JSONB blob. Bookmarks (interest stream) live in their own table `bookmarks` for indexable filtering. Other future tables (feedback, build_journal, memory_reviews) wait until their phases — JSONB shape decided per-phase.
- **Review cadence.** Simple 1/7/30/90/180-day intervals. AI-graded correct answers advance, partial answers repeat sooner, and incorrect answers reset to 1 day. Confidence is context, not proof. Not SM-2.
- **Audio modality.** Build async first (MP3 podcast + tap-to-chat with browser SpeechRecognition). Realtime two-way voice is a possible Phase 7 if async proves the demand.
- **Feedback channels.** Both PWA thumbs-up/down AND Resend inbound webhook for substantive replies.
- **Bookmark sync mechanism.** Claude in Chrome scraping the logged-in X session at /i/bookmarks. **First run** does a deep-scroll bootstrap to capture as much history as the X UI will load; **subsequent runs** are incremental and dedupe against what's already in the `bookmarks` table. X archives do not include bookmarks (verified 2026-05-24), so there is no archive bootstrap path — `cron/import_bookmarks.js` is retained but unused for X; it remains usable for any other JSON dump source. X API ($200/mo) was rejected as overkill for personal use.
- **No newsletter briefs.** Daily and weekly briefs were retired 2026-07-18. They felt like ordinary AI newsletters and did not close a learning loop. Spaced recall is PWA-first; bookmark insights, experiments, and future recommendations should surface inside the product. Do not reintroduce recurring news-summary emails.

## Phase status

Six phases planned. Tasks 1–13 in the task list map 1:1 to the sub-items below.

**Phase 1 — Memory foundation. ✅ Built and deployed.**
- 1.1 Supabase: new `bookmarks` table (composite PK `(sync_id, id)`, RLS on, no direct policies, four SECURITY DEFINER RPCs: `get_bookmarks`, `upsert_bookmark`, `bulk_upsert_bookmarks`, `update_bookmark_status`). Per-item memory fields land inside the existing `state.items` JSONB — no schema change for those.
- 1.2 PWA: mark-done modal captures one-sentence takeaway + 1–5 star rating. Cmd/Ctrl+Enter saves, Esc cancels. Inline note rendering on path and backlog. Color-based dim for completed items so takeaway cards stay vivid. SW cache `v2`.
- 1.3 Historical: brief personalization was built, then removed with the newsletter jobs on 2026-07-18. The reusable state loader remains for memory and bookmark workflows.

**Phase 2 — Evidence-based spaced recall. 🟡 Built; awaiting first explanation/grade.**
- `cron/memory.js` runs at 6:25 AM weekdays, picks one due Done, asks Claude (no web search) for one active-recall question plus a reference answer/key-point rubric, and writes to `state.pendingMemory`. Idempotent. `--force` flag for testing.
- The PWA's confidence buttons open a required free-text explanation modal. Submission appends a pending record to `state.memoryReviews[]`; the browser does not advance the schedule itself.
- `cron/grade_memory.js` runs every two minutes, grades the oldest pending explanation, stores feedback and knowledge evidence, updates per-item mastery plus `state.learnerProfile`, applies the 1/7/30/90/180 cadence from the verdict, and writes path-specific recommendations.
- Up Next promotes actionable recommended items without changing the underlying curriculum. The PWA surfaces grading feedback, reinforcement, cumulative strengths/gaps, and per-item AI mastery.
- `mergeStates` merges recall reviews by id and profiles/recommendations by their own timestamps so unrelated browser edits cannot regress server-graded evidence.
- `cron/scheduler.js` runs both generation and grading schedules.
- `cron/lib/state.js` gained `saveState` (with optimistic-concurrency via `if_unchanged_since`) and `getItemById`. Hidden `__rowUpdatedAt` on loaded state for the OCC token.
- `cron/lib/claude.js` got a `noSearch: true` option to omit the web_search tool.
- Initial review remains +1 day (Ebbinghaus). SW cache `v5`.

**Phase 3 — Active-learning audio. ⏳ Deferred.**
- No TTS news brief. Any audio experiment must chain recall question → one rotating concept → experiment-of-the-day → one open question.
- Voice reply should land in an in-PWA chat where Claude grades and expands the answer; the expanded answer becomes a takeaway on the reviewed item.
- Reassess only after the equivalent PWA surfaces are useful.

**Phase 4 — Evergreens + curator broadening. ⏳ Pending.**
- Add Tier 6: Evergreens to SEED (DDIA, Crafting Interpreters, Attention Is All You Need, GPT-3 paper, FlashAttention, InstructGPT/RLHF paper, CSAPP, CRDT primer, Postgres internals). `evergreen: true` flag — curator skips on removals.
- Broaden `cron/curator.js` source list: HF Daily Papers (filtered), Hamel Husain, Eugene Yan, one skeptic.
- Wire `rereadEvery` (days) so items with cadence re-enter the queue automatically.

**Phase 5 — Build loop + feedback. ⏳ Pending.**
- 5.1: New `build` item type. `cron/build_challenge.js` creates a 60–90 min challenge matched to recent Dones and surfaces it in the PWA. Separate `build_journal` array in state.
- 5.2: PWA thumbs up/down on recommendations/experiments → small `feedback` table. Feedback should tune subsequent in-app recommendations.

**Phase 6 — X bookmarks integration. 🟡 6.1/6.2/6.2.5/6.3 done; 6.4 pending.**
- 6.1: 🟡 Built, but the archive bootstrap path is moot for X. `cron/import_bookmarks.js` works end-to-end (verified against a synthetic fixture), but X archives don't include bookmarks — verified 2026-05-24 by inspecting the actual archive. Script retained for any other JSON dump source. Refactored 2026-05-24 onto shared `cron/lib/tag.js` (no behavior change).
- 6.2: ✅ Built and live. **Architecture pivot from the original plan:** Claude-in-Chrome is a browser-side extension paired with a Claude.ai session — it cannot be driven from the headless cron container. So the scrape is **manual**: drive a Claude.ai session via the Chrome extension at x.com/i/bookmarks, dump bookmarks as JSON (file-download channel, not pasted into chat — Claude-in-Chrome's response filter blocks `key=value` substrings such as image URL query params and tweet bodies containing `--flag=value`), drop the file at `./data/x_bookmarks_NNN.json`, then `docker compose exec cron node sync_bookmarks.js --file …`. The cron-side script normalizes, dedupes vs the existing `bookmarks` table, tags new items via shared `tagBatch`, bulk-upserts as `source='x'`, and bumps `state.lastBookmarkSync` via `saveState` with OCC. **Scope deferred:** no `scheduler.js` entry (sync is manual), no PWA "Sync now" button (waits for 6.3 Interest tab). **Fields preserved in `content` as markers** (no schema migration): `[truncated]` when "Show more" was visible, `[link: title — desc | url]` for external link cards with a real title, `[image_url: <pbs.twimg.com URL>]` per attached image — the last of which is the hook for the next-session image-vision enrichment. Image-URL markers are stripped before tagging (waste tokens) but stay in the stored row. Verified 2026-05-24: 180 real bookmarks ingested, 77 with image markers, 44 truncated, 143/180 tagged. The `cron/lib/tag.js` `normalize()` and `tagBatch()` are the load-bearing shared pieces; do not duplicate them when 6.3/6.4 need parsing.
- 6.3: ✅ V1.5 built and run (verified on 180 bookmarks). **Architecture pivot from the original plan:** bookmarks are *not* displayed in the PWA — they're context data in the codebase. The pipeline has two passes, both inside `cron/analyze_bookmarks.js` (manual, like `sync_bookmarks.js`):
  - **Pass 1 — Per-bookmark classification.** Fresh bookmarks (those with `bookmarked_at > state.lastBookmarkAnalysisAt`) go through Claude (`noSearch`, batches of 10) into four buckets: `experiment` (concrete 30-90 min dev-workflow tries with title/why/steps/timeToTry), `explore_idea` (weekend-scale ideas with hypothesis/firstAction), `deep_learn` (logged this run, persisted as cluster sources via the synthesis pass — no longer a transient bucket), `noise` (dropped). Per-item dedup by `hash(title + sortedSourceBookmarkIds)`. Writes to `state.experiments[]` / `state.exploreIdeas[]`.
  - **Pass 2 — Cluster + insight synthesis.** All classified non-noise bookmarks get clustered by theme via Claude (min 3 sources/cluster, target 6-12 clusters, cap at 12 to control cost). For each cluster, a second Claude call produces a markdown insight document (`max_tokens: 4096` — the 2048 default truncated the largest 10+ source clusters): one-line meta-pattern in italics, 200-350 word cross-cutting insight, "what this means for how you work" with concrete moves, source-bookmark bullets with one-liners each, 2-4 open questions. Files land at `concepts/<slug>.md` (gitignored, bind-mounted into the cron container via `docker-compose.yml`). After write, the script sweeps `concepts/` and unlinks any `.md` not referenced by this run's `state.insights` (clusters shift slightly between runs and otherwise leave orphans). State carries `state.insights[]` with `{id, title, theme, summary, filePath, sourceBookmarkIds, sourceCount, generatedAt, surfacedAt}`, fully replaced each synthesis run — the `.md` files are the persistent artifact, the state array is the brief-injection cursor. Flag `--skip-synthesis` disables Pass 2 for cheaper iteration.
  - **Profile refresh.** Final step: regenerates `state.interestProfile` (Claude-generated ~200-word summary + topThemes from the last 50 bookmarks plus any `tried_liked`/`tried_disliked` outcome history).
  - **Former brief integration.** Weekly-email rendering was built and verified, then retired with `weekly_brief.js` on 2026-07-18. The underlying `state.insights`, `state.experiments`, `state.exploreIdeas`, and `state.interestProfile` data remain intact and now need a PWA surface.
  - **Verified 2026-05-26:** Ran on the 180-bookmark corpus. Classification distribution: ~38-43 experiment / ~22-23 explore_idea / ~16-18 deep_learn / ~99-101 noise (~55% noise rate is correct — X is mostly noise; bumping that down would force false positives). The synthesis pass produced 11 clusters spanning Claude Code internals, agent skills, autonomous coding loops, official curricula, security, personal-OS patterns, open models, solo-operator businesses, agent tooling, IDE rules. All 11 insight files completed cleanly with `stop=end_turn` after the `max_tokens` bump. Brief-block preview confirmed injection works end-to-end.
  - **Scope deferred to 6.3 V2:** PWA UI for marking experiments tried/liked/disliked; explicit feedback loop driving profile updates; "Sync now" button (sync stays manual). The original "Sync now" + Interest-tab framing is fully scrapped.
- 6.4: ⏳ Pending. Curator inspects the interest stream weekly and proposes foundational items that resolve recurring themes. `memory.js` can surface a related bookmark when reviewing a mastery item.

**Phase 6.2.5 — Image vision enrichment for X bookmarks. ✅ Built and run.**
- `cron/lib/claude.js` gained `askVision(prompt, imageUrls, opts)` — uses `client.messages.create` with `{ type: "image", source: { type: "url", url } }` content blocks. Defaults to `claude-sonnet-4-6` (overridable via `opts.model` or `CLAUDE_VISION_MODEL`). No web search. Logs `[claude vision]` usage in the same shape as `ask()`.
- `cron/enrich_bookmarks.js` — on-demand script mirroring `sync_bookmarks.js` conventions. Pulls bookmarks via `get_bookmarks`, filters to rows whose `content` contains a `[image_url:` line, normalizes `pbs.twimg.com` URLs to `name=large` for better OCR, calls `askVision()` once per image, and rewrites markers in place via `upsert_bookmark`. Per-image vision/network failures degrade to `[image: <unreadable>]` and the loop continues. CLI: `--dry-run`, `--limit N`, `--id <tweetId>`. `IMPORT_DEBUG=1` for verbose logs. Idempotent — once markers are replaced the row no longer matches the filter.
- **Locked decisions:** Sonnet 4.6 default (≈5× cheaper than Opus, plenty strong for OCR + chart/photo description). URLs normalized to `name=large` (Anthropic is dimension-agnostic on cost). One image per vision call. No interactive cost guard — `--dry-run` + `--limit` are sufficient.
- **Payload safety:** `upsert_bookmark` replaces ALL fields on conflict, so the script forwards every existing field (including `promoted_item_id`) to avoid clobbering downstream state set by 6.3.
- Verified 2026-05-24: 77 rows / 84 images flagged, smoke test on 1 row produced a faithful 685-char screenshot transcription. Full batch: 76/76 rows upserted, 83/83 images enriched, 0 unreadable. Re-running `--dry-run` correctly reports 0 rows needing enrichment.
- Run again on demand after future `sync_bookmarks.js` ingests:
  ```bash
  docker compose exec cron node enrich_bookmarks.js
  ```

## Audit & amendments — 2026-05-26

Fresh-eyes review after Phase 6.3 V1.5 landed. Captured here so the gaps don't get re-litigated and the candidate amendments are visible alongside the locked plan. Nothing in this section is locked yet — promote any item to "Locked decisions" or the relevant Phase block once Sasha signs off.

### Gaps in the current build (decide how to fix, don't silently ignore)

- **Resolved 2026-07-18: newsletter briefs retired.** `daily_brief.js` and `weekly_brief.js` were deleted, their schedules and prompt helpers removed, and memory is now explicitly PWA-first.

- **Concept `.md` files have no product surface.** `cron/analyze_bookmarks.js` writes synthesis docs to `concepts/<slug>.md`, but those files are gitignored and host-only. With weekly email retired, the correct fix is an in-app Concepts surface backed by `state.insights`, with the full notes made reachable from the PWA.

- **Phase 2 evidence loop upgraded 2026-07-19.** The first real click exposed a product flaw: confidence alone advanced the schedule without proving recall. That transition has been removed. A fresh real run selected `karp-software30` and persisted a question, reference answer, and four-point rubric. The explanation modal, asynchronous grader, mastery/profile updates, feedback, review scheduling, and path recommendations are built; the remaining verification is Sasha's first real explanation and resulting grade.

- **Mastery and interest streams don't talk yet.** The vision puts the interest stream's job as a *discovery signal* for the mastery track. Today: `cron/curator.js` does not import `cron/lib/state.js` — it web-searches generically and ignores `state.interestProfile` and `state.insights` entirely. Phase 6.4 is the wire that closes this loop; until it lands, the two halves run independently.

- **Resolved 2026-07-18: brief prompt reproduction removed** with the newsletter jobs.

- **`state.experiments[]` and `state.exploreIdeas[]` accumulate forever.** Dedup is exact-title-hash and there is no in-app lifecycle yet, so stale candidates will dominate as the corpus grows. Phase 6.3 V2 needs outcome controls plus semantic dedup or periodic cleanup.

### Candidate amendments (new ideas worth committing on)

- **A. Active-learning commute session.** If audio is revisited, stitch recall question → one concept-note → experiment-of-the-day → one open question. Exclude top stories and news recap. A voice reply lands in the PWA, Claude grades and expands it, and the expanded answer becomes a takeaway on the item.

- **B. Mine concept-note "Open questions" as Tier 6 Evergreen seeds.** Every `concepts/*.md` ends with 2-4 follow-up questions ("what I don't yet understand about this theme"). A new job — `cron/seed_from_questions.js` — feeds those into a curator-style pass: for each open question, find the 1-2 best primary sources that answer it, propose as Tier 6 with `evergreen: true`. Replaces "curator searches the web blindly" with "curator answers questions Sasha's own synthesis already raised." Natural Phase 6.4 implementation.

- **C. Working-theory documents.** Monthly job: `cron/working_theory.js` takes the last ~30 Done-item notes and drafts "Your working theory of {agents | MCP | Claude Code | open models}" for an editable PWA surface. Personal counterpart to `concepts/*.md`, grounded in Sasha's own thinking.

- **D. Bookmark → SEED promotion.** The `deep_learn` bucket in `cron/analyze_bookmarks.js:597` is currently logged-only. Add a PWA action: a `deep_learn` bookmark becomes a one-tap "promote to backlog", creating a SEED item (`source: x_bookmark`, `tier: 5` or `6`, `promotedFromBookmark: <id>`) and marking the bookmark with `promoted_item_id`. Schema already supports this.

- **E. Dedicated skeptic pass.** Re-read recent concept notes and working theories, then find the strongest counter-evidence to patterns Sasha may be internalizing. Surface the result in-app, not as a newsletter.

### Revised priority order

This supersedes the original newsletter-oriented ordering below.

1. **Complete the first evidence-based Phase 2 response.** Open the PWA, answer the pending `karp-software30` recall in your own words, then verify the grade, reinforcement, mastery profile, next review, and any path adjustment appear.
2. **Build in-app Concepts + Experiments surfaces.** Make the useful bookmark outputs visible without producing another feed or newsletter.
3. **Phase 6.4 — curator reads `state.insights` + `state.interestProfile` + concept-note open questions.** This is the load-bearing wire between interest and mastery.
4. **Add experiment outcome controls and state cleanup.** Tried/liked/disliked/dismissed should tune the profile and prevent stale accumulation.
5. **Only then reassess active-learning audio.** It must be interactive and concept/recall-driven, never a spoken news brief.

## Open items / what to do next

The "Revised priority order" in the Audit section above is the current sequence. The numbered items below preserve the original operational detail (commands, expected outputs) for the still-relevant work — read both.

1. **Verify the first evidence-based Phase 2 response. 🟡 Awaiting Sasha.** The real rubric-backed question for `karp-software30` is persisted and should appear in the yellow banner. Pick the confidence that feels right, explain the concept in your own words, and wait up to two minutes. Confirm that feedback, reinforcement, mastery/profile evidence, `nextReviewAt`, and any recommended next item arrive. Do not use a synthetic answer: this first record should represent real knowledge.

2. **Build a PWA Concepts + Experiments surface.** The synthesis pass produced 11 insights plus experiment/idea state, but the retired weekly brief was their only presentation layer. Show these inside the product with explicit tried/liked/disliked/dismissed actions.

3. **Phase 6.3 V2 (deferred).** PWA UI to mark experiments tried/liked/disliked, Resend inbound webhook for email-reply feedback (Phase 5.2 territory), explicit feedback loop driving profile-personalization (so future analyses surface items resembling things he liked), state-bloat cleanup (after several runs `state.experiments` accumulates near-duplicates with slightly different titles — semantic dedup or periodic sweep). Empty-content bookmarks (~21% of corpus, all scrape gaps where X exposed no body text) are a known noise floor — fix is upstream in the scrape, not in classification.

4. **Phase 6.4. ⏳ Pending.** Curator inspects bookmarks weekly and proposes foundational Evergreens. The synthesis pass's `deep_learn` cluster sources are the natural input.

5. **Active-learning audio is deferred.** Do not start until the same concepts, experiments, and response loop work in the PWA. No news-summary component.

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
- **The `state.pendingMemory` shape.** `{ itemId, question, generatedAt (iso), generatedFor (yyyy-mm-dd), reviewedNoteAt (iso) }`. The PWA renders it until the user responds.
- **Phase 6.3 state shapes (top-level keys, all in JSONB).**
  - `state.experiments[]` — `{ id (exp_<hash>), title, why, steps[], timeToTry, sourceBookmarkIds[], status: "suggested"|"tried_liked"|"tried_disliked"|"dismissed", suggestedAt, triedAt, outcome }`. Appended (deduped by id) per run. V2 will add explicit-feedback transitions.
  - `state.exploreIdeas[]` — same shape minus `steps`/`timeToTry`, plus `hypothesis`/`firstAction`.
  - `state.interestProfile` — `{ summary (~200 words), topThemes[8-12], generatedAt }`. Replaced each run.
  - `state.insights[]` — `{ id (ins_<clusterHash>), title, theme, summary, filePath ("concepts/<slug>.md"), sourceBookmarkIds[], sourceCount, generatedAt, surfacedAt }`. **Fully replaced** each synthesis run; it is now the cursor for a future in-app Concepts surface.
  - `state.lastBookmarkAnalysisAt` — ISO timestamp; the analyze run filters bookmarks newer than this. `--since YYYY-MM-DD` overrides.
- **Bookmark synthesis is `analyze_bookmarks.js` two-pass.** Classification first (per-bookmark, batches of 10), then synthesis (cluster all non-noise items via Claude into 6-12 themes, generate one `.md` per cluster via a second Claude call with `max_tokens: 4096` — the 2048 default truncates 10+ source clusters). The script auto-cleans orphan `concepts/*.md` files at the end (clusters shift slightly between runs and otherwise leave stale files). Use `--skip-synthesis` for cheap iteration on the classification prompts alone.
- **`./concepts` is bind-mounted** into the cron container as `/app/concepts` via `docker-compose.yml`. New volume mounts require `docker compose up -d cron` (or full restart) to take effect — a `docker compose restart cron` won't apply mount changes.
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
docker compose exec cron node curator.js
docker compose exec cron node analyze_bookmarks.js                  # Phase 6.3 — classify fresh bookmarks + synthesize concept notes
docker compose exec cron node analyze_bookmarks.js --dry-run        # preview without writing state or .md files
docker compose exec cron node analyze_bookmarks.js --since 2025-01-01 # force re-classification of the whole corpus
docker compose exec cron node analyze_bookmarks.js --skip-synthesis # cheap iteration — classification only, no cluster pass

# Tail logs
docker compose logs -f cron
```

## Where the data lives

- **`learning_state`** (Supabase): one JSONB blob per sync_id. Top-level keys: `items` (dict by id, mastery stream), `custom`, `collapsed`, `pendingMemory`, `updatedAt`, `lastBookmarkSync`, and Phase 6.3 additions: `experiments[]`, `exploreIdeas[]`, `interestProfile`, `insights[]`, `lastBookmarkAnalysisAt`. Access via `get_state` / `set_state` SECURITY DEFINER RPCs (the latter takes optional `p_if_unchanged_since` for OCC).
- **`bookmarks`** (Supabase): one row per (sync_id, id) for the interest stream. Access via `get_bookmarks` / `upsert_bookmark` / `bulk_upsert_bookmarks` / `update_bookmark_status` RPCs. Populated by `cron/sync_bookmarks.js`; enriched by `cron/enrich_bookmarks.js`; classified + clustered by `cron/analyze_bookmarks.js`.
- **`frontend/index.html`** SEED constant: the canonical mastery item catalog. The curator writes to it; everything else reads it.
- **`concepts/*.md`** on the host (gitignored, bind-mounted into the cron container as `/app/concepts`): one markdown file per bookmark cluster, written by the Phase 6.3 synthesis pass. The file path lives in `state.insights[i].filePath`; orphan files (whose slug no longer matches the current insight set) are unlinked at the end of each synthesis run.
- **`.env`** on the host: secrets (Anthropic/Resend keys) + `LEARNING_SYNC_ID`. Gitignored.
