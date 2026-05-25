// X bookmarks live-sync ingest.
//
// The scrape itself runs out-of-band: Sasha drives a Claude.ai session with
// the Claude-in-Chrome extension, opens x.com/i/bookmarks in the logged-in
// browser, scrolls (deep-scroll on bootstrap, until first known id on
// subsequent runs), and dumps a JSON array of bookmarks into
// `./data/x_bookmarks.json` on this host.
//
// This script consumes that JSON, dedupes against existing rows, tags new
// items with Claude, bulk-upserts as source="x", and bumps
// `state.lastBookmarkSync`.
//
//   docker compose exec cron node sync_bookmarks.js
//
// Expected input shape — JSON array of objects, e.g.:
//   [
//     {
//       "tweetId": "1700000000000000000",
//       "fullText": "the bookmark text…",
//       "screenName": "someone",
//       "createdAt": "2026-05-23T14:21:00.000Z"
//     },
//     …
//   ]
// Alternate field names (id, full_text/text, screen_name/author, created_at)
// are also accepted — see `normalize` in lib/tag.js.
//
// Optional flags:
//   --file <path>   override the default file location
//   --dry-run       parse + tag, but don't write to Supabase or state
//   --no-tag        skip Claude tagging (faster; raw import)
//
// Idempotent: bookmarks already present in Supabase (by id) are skipped, and
// the state bump is omitted when nothing new was imported.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { normalize, tagBatch, TAG_BATCH } from "./lib/tag.js";
import { loadState, saveState } from "./lib/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(__dirname, "..", "data", "x_bookmarks.json");

const UPSERT_BATCH = 200;

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

function parseDumpFile(text) {
  let body = text.replace(/^﻿/, "").trim();
  let arr;
  try { arr = JSON.parse(body); }
  catch (e) { throw new Error(`failed to parse ${FILE} as JSON: ${e.message}`); }
  if (!Array.isArray(arr)) throw new Error(`expected a JSON array in ${FILE}, got ${typeof arr}`);
  return arr;
}

// ---- main ----------------------------------------------------------------
async function main() {
  const syncId = process.env.LEARNING_SYNC_ID;
  if (!syncId) throw new Error("LEARNING_SYNC_ID must be set");

  console.log(`[sync] reading ${FILE}`);
  let text;
  try { text = await readFile(FILE, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`bookmarks dump not found at ${FILE}. Drop the Claude-in-Chrome JSON export there and try again.`);
    throw e;
  }

  const raw = parseDumpFile(text);
  console.log(`[sync] parsed ${raw.length} entries from dump`);

  const normalized = [];
  const seen = new Set();
  for (const e of raw) {
    const n = normalize(e, { source: "x" });
    if (!n) continue;
    if (seen.has(n.id)) continue; // dedupe within the file itself
    seen.add(n.id);
    normalized.push(n);
  }
  console.log(`[sync] normalized ${normalized.length} bookmarks (dropped ${raw.length - normalized.length} duplicates or missing-id entries)`);

  const supa = supaClient();

  const { data: existing, error: existErr } = await supa.rpc("get_bookmarks", {
    p_sync_id: syncId,
    p_limit: 100000,
  });
  if (existErr) throw new Error(`get_bookmarks failed: ${existErr.message}`);
  const existingIds = new Set((existing || []).map(b => b.id));
  console.log(`[sync] ${existingIds.size} bookmarks already in Supabase`);

  const toImport = normalized.filter(b => !existingIds.has(b.id));
  console.log(`[sync] ${toImport.length} new bookmarks to import`);
  if (!toImport.length) {
    console.log("[sync] nothing to do.");
    return;
  }

  if (!NO_TAG) {
    const batches = Math.ceil(toImport.length / TAG_BATCH);
    for (let i = 0; i < toImport.length; i += TAG_BATCH) {
      const slice = toImport.slice(i, i + TAG_BATCH);
      console.log(`[sync] tagging batch ${Math.floor(i / TAG_BATCH) + 1}/${batches} (${slice.length} items)`);
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
    console.log("[sync] --dry-run: skipping write.");
    console.log("[sync] sample of first 3:");
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
    console.log(`[sync] upserted batch ${Math.floor(i / UPSERT_BATCH) + 1}/${batches} (running total: ${total})`);
  }
  console.log(`[sync] done: ${total} bookmarks imported`);

  // Record the sync timestamp on the learning_state row. Best-effort: a lost
  // OCC race just means the PWA wrote concurrently and will pick up
  // lastBookmarkSync on the next round-trip.
  const st = await loadState();
  if (st) {
    st.lastBookmarkSync = new Date().toISOString();
    const ok = await saveState(st, { ifUnchangedSince: st.__rowUpdatedAt });
    if (ok) console.log(`[sync] state.lastBookmarkSync = ${st.lastBookmarkSync}`);
    else console.warn("[sync] state save lost the OCC race; PWA will catch up on next push");
  } else {
    console.warn("[sync] could not load state to record lastBookmarkSync (network or env)");
  }
}

main().catch(e => {
  console.error(`[sync] FAILED: ${e?.message || e}`);
  process.exit(1);
});
