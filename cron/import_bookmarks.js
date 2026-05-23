// One-time X (Twitter) archive bookmarks importer.
//
// Drop your X archive's `bookmarks.js` at `./data/bookmarks.js` in the repo
// (mounted into the container at `/app/data/bookmarks.js`), then run:
//
//   docker compose exec cron node import_bookmarks.js
//
// Optional flags:
//   --file <path>   override the default file location
//   --dry-run       parse + tag, but don't write to Supabase
//   --no-tag        skip Claude tagging (faster; raw import)
//
// Idempotent: bookmarks already present in Supabase (by id) are skipped so
// the upsert can't reset a promoted/dismissed bookmark back to "open".

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { ask } from "./lib/claude.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(__dirname, "..", "data", "bookmarks.js");

const TAG_BATCH = 20;       // tweets per Claude tagging call
const UPSERT_BATCH = 200;   // rows per bulk_upsert_bookmarks call
const MIN_TAG_TEXT = 20;    // skip tagging if text is shorter than this
const MAX_TWEET_CHARS = 400;// truncate per-tweet text in the tagging prompt

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}
const FILE = arg("file") || DEFAULT_FILE;
const DRY = flag("dry-run");
const NO_TAG = flag("no-tag");

// ---- Supabase client -----------------------------------------------------
function supaClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_ANON_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- archive parsing -----------------------------------------------------
// X archive files look like:
//   window.YTD.bookmarks.part0 = [ { "bookmark": { "tweetId": "...", "fullText": "...", ... } }, ... ]
// We strip the JS assignment prefix and parse the remainder as JSON.
function parseBookmarksFile(text) {
  let body = text.replace(/^﻿/, "").trim();
  body = body.replace(/^window\.YTD\.bookmarks\.part\d+\s*=\s*/, "");
  body = body.replace(/;\s*$/, "");
  let arr;
  try { arr = JSON.parse(body); }
  catch (e) { throw new Error(`failed to parse bookmarks file as JSON: ${e.message}`); }
  if (!Array.isArray(arr)) throw new Error("parsed bookmarks file is not an array");
  return arr;
}

// X archive timestamps can be ISO or the legacy "Wed Mar 15 12:34:56 +0000 2023"
// format. Coerce to ISO, return null on anything unparseable.
function coerceTimestamp(s) {
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function normalize(entry) {
  const b = entry?.bookmark || entry;
  if (!b) return null;
  const id = String(b.tweetId ?? b.id ?? "").trim();
  if (!id) return null;
  const content = (b.fullText ?? b.full_text ?? b.text ?? "").toString();
  return {
    id,
    content,
    url: `https://x.com/i/web/status/${id}`,
    author: b.screenName ?? b.screen_name ?? b.author ?? null,
    source: "archive",
    bookmarked_at: coerceTimestamp(b.createdAt ?? b.created_at ?? null),
  };
}

// ---- tagging -------------------------------------------------------------
// Returns Map<id, { tags: string[], why: string|null }> for the items that
// had enough text to tag. Items without text are left alone.
async function tagBatch(items) {
  const taggable = items.filter(b => b.content && b.content.trim().length >= MIN_TAG_TEXT);
  if (!taggable.length) return new Map();
  const prompt = [
    "You are tagging X (Twitter) bookmarks for an AI / agentic-engineering learner who wants to deepen mastery of agents, coding agents (Claude Code), LLM evals, RLHF, and open models.",
    "",
    "For each tweet below, return:",
    "- `id`: the tweet id, as a STRING (with double quotes) — tweet ids exceed JS safe-integer range, so unquoted numbers lose precision",
    "- `tags`: 2-4 short lowercase hyphenated topic tags (e.g. \"agents\", \"prompt-engineering\", \"claude-code\", \"benchmarks\", \"rlhf\", \"open-models\")",
    "- `why`: one short sentence (<= 120 chars) describing what makes the tweet noteworthy. If the tweet is low-signal, set why to null.",
    "",
    "Return STRICT JSON only — an array of objects { id, tags, why } in the SAME ORDER as the tweets below. No prose, no markdown fences.",
    "",
    "Tweets:",
    ...taggable.map(b => `id: ${b.id}\ntext: ${b.content.replace(/\s+/g, " ").slice(0, MAX_TWEET_CHARS)}\n---`),
  ].join("\n");

  let raw;
  try {
    raw = await ask(prompt, { noSearch: true, maxTokens: 4096 });
  } catch (e) {
    console.warn(`[import] tagging call failed (${taggable.length} items): ${e?.message || e}`);
    return new Map();
  }
  if (process.env.IMPORT_DEBUG) console.log(`[import][debug] raw Claude response:\n${raw}\n---`);

  let jsonText = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1];
  const m = jsonText.match(/\[[\s\S]*\]/);
  if (m) jsonText = m[0];

  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (e) {
    console.warn(`[import] tagging response was not valid JSON; skipping tags for this batch.`);
    return new Map();
  }
  if (!Array.isArray(parsed)) return new Map();

  // If Claude returned ids as JSON numbers, large tweet ids (>2^53) lost precision
  // during JSON.parse. Detect this and fall back to positional matching when the
  // parsed array length matches the batch we sent.
  const positional = parsed.length === taggable.length;

  const out = new Map();
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i];
    if (!r) continue;
    const tags = Array.isArray(r.tags)
      ? r.tags.filter(t => typeof t === "string" && t.length > 0).slice(0, 6)
      : [];
    const why = typeof r.why === "string" && r.why.length > 0 ? r.why.slice(0, 200) : null;

    let key = null;
    if (typeof r.id === "string" && r.id.length > 0) {
      // Trust the string id only if it matches a real id in this batch — guards
      // against Claude making one up.
      if (taggable.some(b => b.id === r.id)) key = r.id;
    }
    if (!key && positional) key = taggable[i].id;
    if (!key) continue;

    out.set(key, { tags, why });
  }
  return out;
}

// ---- main ----------------------------------------------------------------
async function main() {
  const syncId = process.env.LEARNING_SYNC_ID;
  if (!syncId) throw new Error("LEARNING_SYNC_ID must be set");

  console.log(`[import] reading ${FILE}`);
  let text;
  try { text = await readFile(FILE, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`bookmarks file not found at ${FILE}. Drop your X archive's bookmarks.js there and try again.`);
    throw e;
  }

  const raw = parseBookmarksFile(text);
  console.log(`[import] parsed ${raw.length} entries from archive`);

  const normalized = [];
  const seen = new Set();
  for (const e of raw) {
    const n = normalize(e);
    if (!n) continue;
    if (seen.has(n.id)) continue; // dedupe within the file itself
    seen.add(n.id);
    normalized.push(n);
  }
  console.log(`[import] normalized ${normalized.length} bookmarks (dropped ${raw.length - normalized.length} duplicates or missing-id entries)`);

  const supa = supaClient();

  // Fetch existing IDs so we don't clobber promoted/dismissed status on re-runs.
  const { data: existing, error: existErr } = await supa.rpc("get_bookmarks", {
    p_sync_id: syncId,
    p_limit: 100000,
  });
  if (existErr) throw new Error(`get_bookmarks failed: ${existErr.message}`);
  const existingIds = new Set((existing || []).map(b => b.id));
  console.log(`[import] ${existingIds.size} bookmarks already in Supabase`);

  const toImport = normalized.filter(b => !existingIds.has(b.id));
  console.log(`[import] ${toImport.length} new bookmarks to import`);
  if (!toImport.length) {
    console.log("[import] nothing to do.");
    return;
  }

  if (!NO_TAG) {
    const batches = Math.ceil(toImport.length / TAG_BATCH);
    for (let i = 0; i < toImport.length; i += TAG_BATCH) {
      const slice = toImport.slice(i, i + TAG_BATCH);
      console.log(`[import] tagging batch ${Math.floor(i / TAG_BATCH) + 1}/${batches} (${slice.length} items)`);
      const tagMap = await tagBatch(slice);
      for (const b of slice) {
        const t = tagMap.get(b.id);
        if (!t) continue;
        b.tags = t.tags;
        if (t.why) b.why = t.why;
      }
    }
  }

  if (DRY) {
    console.log("[import] --dry-run: skipping write.");
    console.log("[import] sample of first 3:");
    console.log(JSON.stringify(toImport.slice(0, 3), null, 2));
    return;
  }

  let total = 0;
  const batches = Math.ceil(toImport.length / UPSERT_BATCH);
  for (let i = 0; i < toImport.length; i += UPSERT_BATCH) {
    const slice = toImport.slice(i, i + UPSERT_BATCH);
    const { data, error } = await supa.rpc("bulk_upsert_bookmarks", {
      p_sync_id: syncId,
      p_bookmarks: slice,
    });
    if (error) throw new Error(`bulk_upsert_bookmarks failed at batch ${Math.floor(i / UPSERT_BATCH) + 1}: ${error.message}`);
    total += Number(data) || slice.length;
    console.log(`[import] upserted batch ${Math.floor(i / UPSERT_BATCH) + 1}/${batches} (running total: ${total})`);
  }
  console.log(`[import] done: ${total} bookmarks imported`);
}

main().catch(e => {
  console.error(`[import] FAILED: ${e?.message || e}`);
  process.exit(1);
});
