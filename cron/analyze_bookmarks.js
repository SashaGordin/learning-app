// Analyze fresh X bookmarks into an experiment/build stream + cluster all
// classified bookmarks into cross-cutting concept notes.
//
// Reads bookmarks from Supabase (via get_bookmarks RPC), filters fresh ones
// (bookmarked since state.lastBookmarkAnalysisAt), asks Claude to classify
// each into experiment / explore_idea / deep_learn / noise and extracts
// actionable fields for the first two. Then runs a SYNTHESIS pass over ALL
// classified non-noise bookmarks (fresh + already-analyzed earlier ones that
// we re-pull from Supabase): cluster by theme, generate one markdown
// "insight document" per cluster, write to concepts/<slug>.md (gitignored).
// Finally refreshes state.interestProfile.
//
//   docker compose exec cron node analyze_bookmarks.js
//   docker compose exec cron node analyze_bookmarks.js --dry-run
//   docker compose exec cron node analyze_bookmarks.js --since 2026-05-01
//   docker compose exec cron node analyze_bookmarks.js --skip-synthesis
//
// Output lands in state.experiments[] / state.exploreIdeas[] /
// state.interestProfile / state.insights, plus concepts/*.md on disk. The
// weekly_brief.js reads all three and surfaces a handful per week.
//
// Idempotent in the classification pass: re-running with no new bookmarks
// skips both classification AND synthesis (synthesis depends on classified
// items from this run). Per-experiment/idea dedup is by
// hash(title + sortedSourceBookmarkIds). Insight files are overwritten by
// slug — the latest understanding wins; old concepts/*.md persist if the
// theme no longer clusters.

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { ask } from "./lib/claude.js";
import { loadState, saveState } from "./lib/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCEPTS_DIR = resolve(__dirname, "..", "concepts");

const BATCH_SIZE = 10;            // bookmarks per classification call
const MAX_CONTENT_CHARS = 700;    // truncate each bookmark's content for the prompt
const PROFILE_CORPUS_SIZE = 50;   // last N bookmarks for profile context
const CLUSTER_MIN_SIZE = 3;       // minimum bookmarks for a real cluster
const MAX_INSIGHTS_PER_RUN = 12;  // safety cap on insight-generation calls
const INSIGHT_CONTENT_CHARS = 600;// per-source content sent to insight-gen prompt

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
const SKIP_SYNTHESIS = flag("skip-synthesis");

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

function parseJsonObjectLoose(raw) {
  let txt = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1];
  const obj = txt.match(/\{[\s\S]*\}/);
  if (obj) txt = obj[0];
  return JSON.parse(txt);
}

function slugify(s) {
  return (s || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    || "untitled";
}

function hashCluster(ids) {
  return crypto.createHash("sha256")
    .update([...ids].sort().join(","))
    .digest("hex")
    .slice(0, 10);
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

function buildClusterPrompt(items) {
  const listing = items.map(i =>
    `id: ${i.id} | bucket: ${i.bucket} | tags: ${(i.tags || []).join(", ") || "—"} | snippet: ${i.snippet}`
  ).join("\n");

  return `You are clustering Sasha's X bookmarks by THEME — finding groups that, taken together, reveal a cross-cutting insight he could internalize and act on. Sasha is a developer focused on AI / agentic engineering / Claude Code / coding agents.

CONSTRAINTS:
- Aim for 6-12 clusters total. Don't force more if the corpus doesn't warrant it.
- Each cluster MUST contain at least ${CLUSTER_MIN_SIZE} bookmarks. Lone bookmarks don't form clusters.
- A bookmark belongs to AT MOST ONE cluster (assign to where it fits best).
- It's fine if many bookmarks don't fit any cluster — leave them out, don't pad.
- Cluster TITLES should be precise themes that reveal a PATTERN across sources, not just a topic.
  - Good: "How power users architect Claude Code memory" / "Codex automation loops, end-to-end"
  - Bad: "AI tools" / "Productivity" / "Stuff Sasha likes"
- Prefer clusters that span DIFFERENT buckets when the theme warrants it (an experiment + a deep_learn paper + an explore_idea can all reinforce one cross-cutting insight).

For each cluster also write:
- "theme": 1-2 sentence statement of the cross-cutting PATTERN these bookmarks reveal when read together.
- "summary": one tight sentence (<=140 chars) suitable for injection into a weekly brief.

CLASSIFIED BOOKMARKS:
${listing}

Return STRICT JSON only — no prose, no markdown fences:
{"clusters": [{"title": "...", "theme": "...", "summary": "...", "bookmarkIds": ["str", "str", ...]}, ...]}

The bookmarkIds MUST be strings (with double quotes) — tweet ids exceed JS safe-integer range.`;
}

function buildInsightPrompt(cluster, sources) {
  const sourceBlock = sources.map((s, i) => {
    const author = s.author ? `@${s.author}` : "?";
    const body = (s.fullContent || s.snippet || "")
      .replace(/\s+/g, " ")
      .slice(0, INSIGHT_CONTENT_CHARS);
    return `### Source ${i + 1} (id: ${s.id}, ${author}, bucket: ${s.bucket})\n${body}`;
  }).join("\n\n");

  return `You are writing ONE concept note for Sasha — a cross-cutting synthesis of ${sources.length} bookmarks that share a theme. The output is a markdown document that goes into his learning library. Write it as something he'll actually want to revisit in 3 months — concrete, pattern-revealing, not generic.

Sasha is a developer focused on AI / agentic engineering / Claude Code / coding agents.

CLUSTER TITLE: ${cluster.title}
THEME: ${cluster.theme}

SOURCE BOOKMARKS — use these as evidence; synthesize across them, don't just list them.

${sourceBlock}

Output a markdown document with this EXACT structure. No preamble. No emoji. No conclusion section. Don't add a "Generated" timestamp.

# ${cluster.title}

> *<a one-line meta-pattern statement in italics — what's the cross-cutting insight when these ${sources.length} bookmarks are read together?>*

## Cross-cutting insight

<200-350 words. Synthesize what these bookmarks ACTUALLY tell you when read together. Reference specific sources by number — "Source 3 hints that..." beats "one tweet says...". Note tensions or contradictions if present. Aim for an insight Sasha doesn't already have just from skimming the individual tweets — the value here is the synthesis.>

## What this means for how you work

<100-150 words. If Sasha internalized this insight, what would he do DIFFERENTLY next week? Be specific: workflow changes, mental-model updates, defaults to adopt, tools to wire in. Not "consider X" — concrete action.>

## Source bookmarks

- [Source 1 — @<author>](https://x.com/i/web/status/<id>): <one-line summary of THIS bookmark's contribution to the synthesis>
- ...
<One bullet per source, in the order they appeared above. Use the source's actual id and author from the SOURCE BOOKMARKS block.>

## Open questions

- <2-4 follow-up questions that would deepen Sasha's understanding>`;
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

// ---- synthesis pass ------------------------------------------------------

async function clusterBookmarks(items) {
  const prompt = buildClusterPrompt(items);
  let raw;
  try {
    raw = await ask(prompt, { noSearch: true, maxTokens: 4096 });
  } catch (e) {
    console.warn(`[analyze] cluster call failed: ${e?.message || e}`);
    return [];
  }
  if (process.env.IMPORT_DEBUG) console.log(`[analyze][debug] raw cluster response:\n${raw}\n---`);

  let parsed;
  try { parsed = parseJsonObjectLoose(raw); }
  catch (e) {
    console.warn(`[analyze] cluster response was not valid JSON; skipping synthesis.`);
    return [];
  }
  const clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : [];

  // Filter: must have title + theme + summary + min cluster size; bookmarkIds
  // must be strings that actually exist in the input.
  const validIds = new Set(items.map(i => i.id));
  const out = [];
  for (const c of clusters) {
    if (!c || typeof c.title !== "string" || typeof c.theme !== "string") continue;
    const ids = Array.isArray(c.bookmarkIds)
      ? c.bookmarkIds.filter(id => typeof id === "string" && validIds.has(id))
      : [];
    if (ids.length < CLUSTER_MIN_SIZE) continue;
    out.push({
      title: c.title.trim(),
      theme: c.theme.trim(),
      summary: (typeof c.summary === "string" ? c.summary : c.theme).trim().slice(0, 160),
      bookmarkIds: ids,
    });
  }
  return out;
}

async function generateInsightMarkdown(cluster, sources) {
  const prompt = buildInsightPrompt(cluster, sources);
  try {
    // 4096 gives headroom for clusters with 10+ sources (each needs a bullet
    // in the source list + the insight prose). Empirically clusters of 5
    // need ~1500-1800; clusters of 15 hit 2048 and truncate.
    const raw = await ask(prompt, { noSearch: true, maxTokens: 4096 });
    if (!raw || raw.trim().length < 100) {
      console.warn(`[analyze]   insight response suspiciously short for "${cluster.title}"`);
      return null;
    }
    return raw.trim();
  } catch (e) {
    console.warn(`[analyze]   insight call failed for "${cluster.title}": ${e?.message || e}`);
    return null;
  }
}

async function synthesizeInsights(classified) {
  const nonNoise = classified.filter(c => c && c.bucket !== "noise");
  if (nonNoise.length < CLUSTER_MIN_SIZE * 2) {
    console.log(`[analyze] only ${nonNoise.length} non-noise bookmarks — skipping synthesis (need >= ${CLUSTER_MIN_SIZE * 2})`);
    return [];
  }

  console.log(`[analyze] clustering ${nonNoise.length} non-noise bookmarks`);
  let clusters = await clusterBookmarks(nonNoise);
  if (!clusters.length) {
    console.log("[analyze] no usable clusters returned");
    return [];
  }
  if (clusters.length > MAX_INSIGHTS_PER_RUN) {
    console.log(`[analyze] capping ${clusters.length} clusters to ${MAX_INSIGHTS_PER_RUN}`);
    clusters = clusters.slice(0, MAX_INSIGHTS_PER_RUN);
  }
  console.log(`[analyze] generating ${clusters.length} insight notes`);

  const byId = new Map();
  for (const c of classified) byId.set(c.id, c);

  if (!DRY) await mkdir(CONCEPTS_DIR, { recursive: true });

  const usedSlugs = new Set();
  const insights = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const sources = c.bookmarkIds.map(id => byId.get(id)).filter(Boolean);
    if (sources.length < CLUSTER_MIN_SIZE) continue;
    console.log(`[analyze]   insight ${i + 1}/${clusters.length}: "${c.title}" (${sources.length} sources)`);

    const md = await generateInsightMarkdown(c, sources);
    if (!md) continue;

    // Slug collision: append a short hash if two clusters slugify the same.
    let slug = slugify(c.title);
    if (usedSlugs.has(slug)) slug = `${slug}-${hashCluster(c.bookmarkIds)}`;
    usedSlugs.add(slug);
    const filename = `${slug}.md`;
    const filePath = `concepts/${filename}`;

    if (!DRY) {
      await writeFile(resolve(CONCEPTS_DIR, filename), md, "utf8");
    }

    insights.push({
      id: `ins_${hashCluster(c.bookmarkIds)}`,
      title: c.title,
      theme: c.theme,
      summary: c.summary,
      filePath,
      sourceBookmarkIds: c.bookmarkIds,
      sourceCount: sources.length,
      generatedAt: isoNow,
      surfacedAt: null,
    });
  }

  console.log(`[analyze] wrote ${insights.length} insight notes to ${DRY ? "(dry-run, not written)" : CONCEPTS_DIR}`);
  return insights;
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
  // Captures every bookmark we classified this run — fed to the synthesis pass
  // so it can cluster across buckets and generate concept notes.
  const classifiedItems = [];

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

      // Record this classification for the synthesis pass (which clusters
      // across all non-noise buckets). Done unconditionally so noise is also
      // captured for counting; synthesis filters it out itself.
      classifiedItems.push({
        id: b.id,
        bucket: r.bucket,
        tags: b.tags || [],
        author: b.author || null,
        snippet: contentForAnalysis(b.content).replace(/\s+/g, " ").slice(0, 160),
        fullContent: b.content || "",
      });

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

  // Synthesis pass: cluster all classified non-noise bookmarks into themes
  // and write one .md insight note per cluster. State.insights is REPLACED
  // each run — the freshest synthesis wins, with .md files persisting as the
  // historical artifact. Skipped with --skip-synthesis or if too few items.
  const insights = SKIP_SYNTHESIS
    ? []
    : await synthesizeInsights(classifiedItems);
  if (SKIP_SYNTHESIS) console.log("[analyze] --skip-synthesis: cluster + insight pass disabled");

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
    console.log("[analyze] --dry-run: skipping state write + .md file write");
    console.log("[analyze] sample new experiments:");
    console.log(JSON.stringify(newExperiments.slice(0, 3), null, 2));
    console.log("[analyze] sample new ideas:");
    console.log(JSON.stringify(newIdeas.slice(0, 3), null, 2));
    if (insights.length) {
      console.log(`[analyze] proposed insights (${insights.length}):`);
      console.log(JSON.stringify(
        insights.map(i => ({ id: i.id, title: i.title, sourceCount: i.sourceCount, filePath: i.filePath })),
        null, 2,
      ));
    }
    if (profile) {
      console.log("[analyze] proposed interest profile:");
      console.log(JSON.stringify(profile, null, 2));
    }
    return;
  }

  state.experiments = [...existingExp, ...newExperiments];
  state.exploreIdeas = [...existingIdeas, ...newIdeas];
  if (profile) state.interestProfile = profile;
  // Replace insights each run — the freshest synthesis wins, .md files
  // persist as the historical artifact. If synthesis produced nothing this
  // run (e.g., --skip-synthesis), preserve existing state.insights.
  if (insights.length) state.insights = insights;
  state.lastBookmarkAnalysisAt = isoNow;

  const ok = await saveState(state, { ifUnchangedSince: state.__rowUpdatedAt });
  if (!ok) {
    console.error("[analyze] saveState failed — nothing persisted (re-run after PWA sync settles)");
    process.exit(1);
  }
  console.log(`[analyze] saved: +${newExperiments.length} exp, +${newIdeas.length} ideas, ${insights.length} insights, profile ${profile ? "refreshed" : "unchanged"}, lastBookmarkAnalysisAt=${isoNow}`);
}

main().catch(e => {
  console.error(`[analyze] FAILED: ${e?.message || e}`);
  process.exit(1);
});
