// Analyze fresh X bookmarks into an experiment/build stream.
//
// Reads bookmarks from Supabase (via get_bookmarks RPC), filters to anything
// bookmarked since state.lastBookmarkAnalysisAt, asks Claude to classify each
// into one of four buckets (experiment / explore_idea / deep_learn / noise),
// and extracts actionable fields for the first two. Then refreshes
// state.interestProfile from the broader corpus + any existing experiment
// outcomes. Writes everything back via saveState with OCC.
//
//   docker compose exec cron node analyze_bookmarks.js
//   docker compose exec cron node analyze_bookmarks.js --dry-run
//   docker compose exec cron node analyze_bookmarks.js --since 2026-05-01
//
// Output lands in state.experiments[] / state.exploreIdeas[] /
// state.interestProfile. weekly_brief.js reads these and surfaces a small
// number of "suggested"-status entries per week. Phase 6.4 will later pick
// up the deep_learn classifications for mastery suggestions; for now they're
// logged but not persisted.
//
// Idempotent: re-running with no new bookmarks is a no-op (skips profile
// refresh too). Within a run, dedup by hash(title + sorted sourceBookmarkIds)
// so an item already in state.experiments isn't appended again.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ask } from "./lib/claude.js";
import { loadState, saveState } from "./lib/state.js";

const BATCH_SIZE = 10;          // bookmarks per classification call
const MAX_CONTENT_CHARS = 700;  // truncate each bookmark's content for the prompt
const PROFILE_CORPUS_SIZE = 50; // last N bookmarks for profile context

const isoNow = new Date().toISOString();

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}
const DRY = flag("dry-run");
const SINCE = arg("since");

// ---- helpers -------------------------------------------------------------
function supaClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_ANON_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Strip [image_url:] markers (already enriched into [image:] blocks where present);
// collapse blank-line runs; truncate. Tagger uses the same pattern in lib/tag.js.
function contentForAnalysis(content) {
  return (content || "")
    .split("\n")
    .filter(line => !line.startsWith("[image_url:"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CONTENT_CHARS);
}

function hashId(prefix, title, sourceIds) {
  const h = crypto.createHash("sha256");
  h.update((title || "").trim().toLowerCase());
  h.update("\0");
  h.update([...sourceIds].sort().join(","));
  return `${prefix}_${h.digest("hex").slice(0, 10)}`;
}

function parseJsonLoose(raw) {
  let txt = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1];
  const arr = txt.match(/\[[\s\S]*\]/);
  if (arr) txt = arr[0];
  return JSON.parse(txt);
}

// ---- prompts -------------------------------------------------------------
function buildClassifyPrompt(batch, profileText) {
  const profileBlock = profileText
    ? `INTEREST PROFILE (use to bias toward what genuinely matches Sasha's patterns):\n${profileText}\n`
    : `INTEREST PROFILE: (no profile yet — this is the first analysis run; use the generic developer focus above)\n`;

  const itemsBlock = batch.map(b => {
    const tags = Array.isArray(b.tags) && b.tags.length ? b.tags.join(", ") : "—";
    const why = b.why ? `\nwhy: ${b.why}` : "";
    const content = contentForAnalysis(b.content);
    return `id: ${b.id}\ntags: ${tags}${why}\ncontent: ${content.replace(/\s+/g, " ").slice(0, MAX_CONTENT_CHARS)}\n---`;
  }).join("\n");

  return `You are helping Sasha turn his X bookmarks into actionable next steps. Sasha is a developer focused on AI / agentic engineering / Claude Code / coding agents. He bookmarks tweets that catch his curiosity. Your job is to classify each bookmark and extract concrete "what to do with this" content where it's high-signal.

${profileBlock}
For each bookmark below, return ONE classification:
- "experiment" — a concrete dev-procedure / tool / technique he could try in 30-90 minutes (e.g., tmux setup, a CLI tool, a coding pattern, a Claude Code feature, a shell trick, a workflow tweak). Must have clear steps. Don't force-classify here — if a bookmark is just a hot take or screenshot with no actionable lever, it's not an experiment.
- "explore_idea" — a bigger idea worth a weekend exploration: side hustles, product ideas, business threads, deeper themes ("what if I built X"). Less "do this in an hour", more "is this worth pursuing".
- "deep_learn" — primary literature, foundational concepts, articles worth deep study (papers, deep technical posts, long-form essays).
- "noise" — low-signal: memes, dunks, drama, follower-engagement bait, posts without substance.

For "experiment" bucket, extract:
- title: imperative form, <=60 chars (e.g., "Try tmux for persistent terminal sessions")
- why: one sentence on what value Sasha gets from trying this
- steps: 2-4 short concrete actions to actually try it (each <=80 chars)
- timeToTry: rough estimate as a string ("~30 min" / "~1 hr" / "~90 min")

For "explore_idea" bucket, extract:
- title: <=60 chars
- hypothesis: one sentence stating the thesis worth exploring
- firstAction: one concrete first step (read X, sketch Y, try Z for 20 min, talk to N)

For "deep_learn" and "noise" buckets, no extraction needed.

Return STRICT JSON only — an array of objects in the SAME ORDER as the bookmarks below. No prose, no markdown fences, no commentary. The "id" field MUST be a STRING (with double quotes) — tweet ids exceed JS safe-integer range and lose precision if unquoted.

Shape examples:
{"id": "1700000000000000000", "bucket": "experiment", "experiment": {"title": "...", "why": "...", "steps": ["...", "..."], "timeToTry": "..."}}
{"id": "1700000000000000000", "bucket": "explore_idea", "explore_idea": {"title": "...", "hypothesis": "...", "firstAction": "..."}}
{"id": "1700000000000000000", "bucket": "deep_learn"}
{"id": "1700000000000000000", "bucket": "noise"}

Bookmarks:
${itemsBlock}`;
}

function buildProfilePrompt(corpus, experiments) {
  const corpusBlock = corpus.map(c =>
    `- [${(c.tags || []).join(", ") || "—"}] ${c.snippet}`
  ).join("\n");

  const expBlock = experiments.length
    ? `EXISTING EXPERIMENT SUGGESTIONS (status reveals preference signal — "tried_liked" is a strong positive, "dismissed" a negative; "suggested" means he hasn't reacted yet):
${experiments.slice(-25).map(e => `- ${e.title}${e.status && e.status !== "suggested" ? ` (status: ${e.status})` : ""}`).join("\n")}`
    : "(no experiments tracked yet — this is the first analysis run)";

  return `You are writing Sasha's interest profile — a personal context document that captures the SPECIFIC patterns of curiosity in his X bookmarks. This profile gets injected into his weekly brief prompt so recommendations stay tailored.

Sasha is a developer focused on AI / agentic engineering / Claude Code / coding agents. The profile should NOT just restate that — it should surface the specific themes, recurring sub-interests, and the way he reads (try-later vs read-later vs save-for-reference) that are visible in his bookmarks.

CORPUS (recent bookmarks — tags + short text snippet):
${corpusBlock}

${expBlock}

Return STRICT JSON only — no prose, no markdown fences. Shape:
{
  "summary": "150-220 word profile in second person ('You're drawn to ...'). Concrete and specific — reference real recurring patterns from the corpus above, not abstractions. Surface tensions/contradictions if any. End with a one-line meta-observation about HOW he reads (try-later vs read-later vs reference-collection).",
  "topThemes": ["<8-12 short phrases capturing the recurring themes>"]
}`;
}

// ---- core calls ----------------------------------------------------------
async function classifyBatch(batch, profileText) {
  const prompt = buildClassifyPrompt(batch, profileText);
  let raw;
  try {
    raw = await ask(prompt, { noSearch: true, maxTokens: 4096 });
  } catch (e) {
    console.warn(`[analyze] classify call failed (${batch.length} items): ${e?.message || e}`);
    return [];
  }
  if (process.env.IMPORT_DEBUG) console.log(`[analyze][debug] raw classify response:\n${raw}\n---`);

  let parsed;
  try { parsed = parseJsonLoose(raw); }
  catch (e) {
    console.warn(`[analyze] classify response was not valid JSON; skipping this batch.`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

async function refreshInterestProfile(corpus, experiments) {
  const prompt = buildProfilePrompt(corpus, experiments);
  let raw;
  try {
    raw = await ask(prompt, { noSearch: true, maxTokens: 2048 });
  } catch (e) {
    console.warn(`[analyze] profile call failed: ${e?.message || e}`);
    return null;
  }
  if (process.env.IMPORT_DEBUG) console.log(`[analyze][debug] raw profile response:\n${raw}\n---`);

  let txt = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1];
  const obj = txt.match(/\{[\s\S]*\}/);
  if (obj) txt = obj[0];

  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (e) {
    console.warn(`[analyze] profile response was not valid JSON; keeping previous profile.`);
    return null;
  }
  if (!parsed || typeof parsed.summary !== "string") return null;
  return {
    summary: parsed.summary.trim(),
    topThemes: Array.isArray(parsed.topThemes)
      ? parsed.topThemes.filter(t => typeof t === "string" && t.length > 0).slice(0, 12)
      : [],
    generatedAt: isoNow,
  };
}

// ---- main ----------------------------------------------------------------
async function main() {
  const syncId = process.env.LEARNING_SYNC_ID;
  if (!syncId) throw new Error("LEARNING_SYNC_ID must be set");

  const state = await loadState();
  if (!state) {
    console.error("[analyze] no state available — set LEARNING_SYNC_ID + SUPABASE_*");
    process.exit(1);
  }

  const supa = supaClient();
  const { data: bookmarks, error } = await supa.rpc("get_bookmarks", {
    p_sync_id: syncId,
    p_limit: 100000,
  });
  if (error) throw new Error(`get_bookmarks failed: ${error.message}`);
  const all = bookmarks || [];
  console.log(`[analyze] ${all.length} total bookmarks in Supabase`);

  // Window selection — SINCE override beats state.lastBookmarkAnalysisAt.
  const sinceIso = SINCE
    ? new Date(SINCE).toISOString()
    : (state.lastBookmarkAnalysisAt || null);
  const fresh = sinceIso
    ? all.filter(b => b.bookmarked_at && b.bookmarked_at > sinceIso)
    : all;
  console.log(`[analyze] ${fresh.length} bookmarks to analyze (since ${sinceIso || "the beginning"})`);

  if (!fresh.length) {
    console.log("[analyze] nothing new; profile refresh skipped");
    return;
  }

  const existingExp = state.experiments || [];
  const existingIdeas = state.exploreIdeas || [];
  const existingExpHashes = new Set(existingExp.map(e => e.id));
  const existingIdeaHashes = new Set(existingIdeas.map(e => e.id));

  const profileText = state.interestProfile?.summary || null;

  const newExperiments = [];
  const newIdeas = [];
  const deepLearnIds = [];
  const bucketCounts = { experiment: 0, explore_idea: 0, deep_learn: 0, noise: 0, unknown: 0 };

  // Classify in batches.
  const batches = Math.ceil(fresh.length / BATCH_SIZE);
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const slice = fresh.slice(i, i + BATCH_SIZE);
    console.log(`[analyze] classify batch ${Math.floor(i / BATCH_SIZE) + 1}/${batches} (${slice.length} bookmarks)`);
    const results = await classifyBatch(slice, profileText);

    // Index by id; fall back to positional alignment if Claude dropped ids
    // (parseInt precision loss is the usual culprit — same as tagBatch).
    const byId = new Map();
    for (const r of results) if (r && typeof r.id === "string") byId.set(r.id, r);
    const positional = results.length === slice.length;

    for (let j = 0; j < slice.length; j++) {
      const b = slice[j];
      let r = byId.get(b.id);
      if (!r && positional) r = results[j];
      if (!r || !r.bucket) {
        bucketCounts.unknown++;
        continue;
      }
      bucketCounts[r.bucket] = (bucketCounts[r.bucket] || 0) + 1;

      if (r.bucket === "experiment" && r.experiment && typeof r.experiment.title === "string") {
        const e = r.experiment;
        const sourceIds = [b.id];
        const id = hashId("exp", e.title, sourceIds);
        if (existingExpHashes.has(id)) {
          if (process.env.IMPORT_DEBUG) console.log(`[analyze]   dedup skip ${id}`);
          continue;
        }
        existingExpHashes.add(id);
        newExperiments.push({
          id,
          title: e.title.trim(),
          why: typeof e.why === "string" ? e.why.trim() : null,
          steps: Array.isArray(e.steps) ? e.steps.filter(s => typeof s === "string" && s.length).slice(0, 6) : [],
          timeToTry: typeof e.timeToTry === "string" ? e.timeToTry.trim() : null,
          sourceBookmarkIds: sourceIds,
          status: "suggested",
          suggestedAt: isoNow,
          triedAt: null,
          outcome: null,
        });
      } else if (r.bucket === "explore_idea" && r.explore_idea && typeof r.explore_idea.title === "string") {
        const e = r.explore_idea;
        const sourceIds = [b.id];
        const id = hashId("idea", e.title, sourceIds);
        if (existingIdeaHashes.has(id)) {
          if (process.env.IMPORT_DEBUG) console.log(`[analyze]   dedup skip ${id}`);
          continue;
        }
        existingIdeaHashes.add(id);
        newIdeas.push({
          id,
          title: e.title.trim(),
          hypothesis: typeof e.hypothesis === "string" ? e.hypothesis.trim() : null,
          firstAction: typeof e.firstAction === "string" ? e.firstAction.trim() : null,
          sourceBookmarkIds: sourceIds,
          status: "suggested",
          suggestedAt: isoNow,
          triedAt: null,
          outcome: null,
        });
      } else if (r.bucket === "deep_learn") {
        deepLearnIds.push(b.id);
      }
      // "noise" + degraded extractions fall through with no append.
    }
  }

  console.log(`[analyze] classification counts: ${JSON.stringify(bucketCounts)}`);
  console.log(`[analyze] new experiments: ${newExperiments.length}, new ideas: ${newIdeas.length}, deep_learn flagged: ${deepLearnIds.length}`);
  if (deepLearnIds.length && process.env.IMPORT_DEBUG) {
    console.log(`[analyze][debug] deep_learn ids: ${deepLearnIds.join(", ")}`);
  }

  // Refresh interest profile from a wider context — use the latest N bookmarks
  // overall (not just freshly analyzed), so the profile reflects accumulated
  // taste, not just the last sync slice.
  const profileCorpus = all
    .slice()
    .sort((a, b) => (b.bookmarked_at || "").localeCompare(a.bookmarked_at || ""))
    .slice(0, PROFILE_CORPUS_SIZE)
    .map(b => ({
      tags: b.tags || [],
      snippet: contentForAnalysis(b.content).replace(/\s+/g, " ").slice(0, 140),
    }));

  console.log(`[analyze] refreshing interest profile from ${profileCorpus.length} recent bookmarks`);
  const profile = await refreshInterestProfile(
    profileCorpus,
    [...existingExp, ...newExperiments],
  );

  if (DRY) {
    console.log("[analyze] --dry-run: skipping state write");
    console.log("[analyze] sample new experiments:");
    console.log(JSON.stringify(newExperiments.slice(0, 3), null, 2));
    console.log("[analyze] sample new ideas:");
    console.log(JSON.stringify(newIdeas.slice(0, 3), null, 2));
    if (profile) {
      console.log("[analyze] proposed interest profile:");
      console.log(JSON.stringify(profile, null, 2));
    }
    return;
  }

  state.experiments = [...existingExp, ...newExperiments];
  state.exploreIdeas = [...existingIdeas, ...newIdeas];
  if (profile) state.interestProfile = profile;
  state.lastBookmarkAnalysisAt = isoNow;

  const ok = await saveState(state, { ifUnchangedSince: state.__rowUpdatedAt });
  if (!ok) {
    console.error("[analyze] saveState failed — nothing persisted (re-run after PWA sync settles)");
    process.exit(1);
  }
  console.log(`[analyze] saved: +${newExperiments.length} exp, +${newIdeas.length} ideas, profile ${profile ? "refreshed" : "unchanged"}, lastBookmarkAnalysisAt=${isoNow}`);
}

main().catch(e => {
  console.error(`[analyze] FAILED: ${e?.message || e}`);
  process.exit(1);
});
