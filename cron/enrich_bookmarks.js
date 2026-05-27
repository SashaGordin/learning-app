// X bookmarks image-vision enrichment.
//
// Bookmarks ingested by sync_bookmarks.js carry `[image_url: <pbs.twimg.com URL>]`
// markers in `content` for each attached image (one per line). This script
// finds those rows, calls Claude vision on each image, and rewrites every
// marker line in place as `[image: <transcription/description>]`. Run on
// demand:
//
//   docker compose exec cron node enrich_bookmarks.js
//
// Optional flags:
//   --dry-run     fetch + parse but make no API calls and no upserts
//   --limit N     only process the first N rows that need enrichment
//   --id <id>     only process the bookmark with that tweet id
//
// Idempotent: once a row's `[image_url:]` markers are replaced, it no longer
// matches the enrichment filter, so reruns skip it. Per-image vision/network
// errors degrade to `[image: <unreadable>]` and the loop continues — never
// crash on one bad image.

import { createClient } from "@supabase/supabase-js";
import { askVision } from "./lib/claude.js";

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
const LIMIT = (() => {
  const v = arg("limit");
  if (v == null) return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive integer, got ${v}`);
  return n;
})();
const ID = arg("id");
const DEBUG = !!process.env.IMPORT_DEBUG;

// ---- Supabase client -----------------------------------------------------
function supaClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_ANON_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- helpers -------------------------------------------------------------

// Canonical marker shape from cron/lib/tag.js buildContent(): `[image_url: <URL>]`,
// one per line, separated from surrounding parts by blank lines.
const IMAGE_URL_LINE = /^\[image_url:\s*(.+?)\]\s*$/;

// Force pbs.twimg.com URLs to name=large for better OCR fidelity on text-heavy
// screenshots. Anthropic doesn't bill by image dimensions, so this is free.
// Leaves non-pbs URLs untouched.
function normalizeTwimgUrl(url) {
  if (typeof url !== "string") return url;
  if (!url.includes("pbs.twimg.com")) return url;
  if (/[?&]name=/.test(url)) return url.replace(/([?&]name=)[^&]*/, "$1large");
  // No name param at all — append one (use ? if no query string yet).
  return url + (url.includes("?") ? "&" : "?") + "name=large";
}

const VISION_PROMPT = [
  "You are extracting the readable content from one image attached to an X (Twitter) bookmark.",
  "",
  "Return ONLY the replacement text — no prefix like \"[image:\", no quotes, no commentary.",
  "",
  "Pick the rule that fits the image:",
  "- If the image is a screenshot of text (tweet, article, code, terminal, chat): transcribe the text VERBATIM. Preserve line breaks for code/terminal. Cap at ~500 characters; if you had to cut it off, append `[…]` at the end.",
  "- If the image is a chart, graph, or diagram: describe in 1-3 sentences what's shown (axes, trend, key takeaway).",
  "- If the image is a photo, meme, illustration, or product shot: describe it in one sentence.",
  "",
  "Be terse. The output becomes a single `[image: …]` block embedded in the bookmark's body alongside the original tweet text.",
].join("\n");

async function describeImage(url) {
  const normalized = normalizeTwimgUrl(url);
  if (DEBUG) console.log(`[enrich][debug] vision call for ${normalized}`);
  let text;
  try {
    text = await askVision(VISION_PROMPT, [normalized]);
  } catch (e) {
    console.warn(`[enrich]   vision call failed for ${normalized}: ${e?.message || e}`);
    return null;
  }
  const cleaned = (text || "").trim();
  if (!cleaned) {
    console.warn(`[enrich]   empty response for ${normalized}`);
    return null;
  }
  return cleaned;
}

// Rewrite a single row's content. Returns { content, totalImages, enriched, unreadable }.
// Network/vision errors per image are absorbed here.
async function enrichContent(content) {
  const lines = content.split("\n");
  let total = 0;
  let enriched = 0;
  let unreadable = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMAGE_URL_LINE);
    if (!m) continue;
    total++;
    const url = m[1].trim();
    const desc = await describeImage(url);
    if (desc == null) {
      lines[i] = "[image: <unreadable>]";
      unreadable++;
      console.log(`[enrich]   image ${total} → unreadable`);
    } else {
      lines[i] = `[image: ${desc}]`;
      enriched++;
      console.log(`[enrich]   image ${total} → ${desc.length} chars`);
    }
  }
  return { content: lines.join("\n"), totalImages: total, enriched, unreadable };
}

// Count `[image_url:` markers in a content string without doing any work.
function countMarkers(content) {
  let n = 0;
  for (const line of content.split("\n")) if (IMAGE_URL_LINE.test(line)) n++;
  return n;
}

// ---- main ----------------------------------------------------------------
async function main() {
  const syncId = process.env.LEARNING_SYNC_ID;
  if (!syncId) throw new Error("LEARNING_SYNC_ID must be set");

  const supa = supaClient();

  const { data: all, error } = await supa.rpc("get_bookmarks", {
    p_sync_id: syncId,
    p_limit: 100000,
  });
  if (error) throw new Error(`get_bookmarks failed: ${error.message}`);
  const bookmarks = all || [];

  let needs = bookmarks.filter(b => typeof b.content === "string" && b.content.includes("[image_url:"));
  if (ID) needs = needs.filter(b => String(b.id) === String(ID));
  if (LIMIT != null) needs = needs.slice(0, LIMIT);

  const totalImages = needs.reduce((acc, b) => acc + countMarkers(b.content), 0);
  console.log(`[enrich] sync_id=${syncId} fetched ${bookmarks.length} bookmarks; ${needs.length} need enrichment (${totalImages} images)`);

  if (!needs.length) {
    console.log("[enrich] nothing to do.");
    return;
  }

  if (DRY) {
    console.log("[enrich] --dry-run: no vision calls, no upserts.");
    for (const b of needs.slice(0, 5)) {
      console.log(`[enrich]   would enrich id=${b.id} (${countMarkers(b.content)} images)`);
    }
    if (needs.length > 5) console.log(`[enrich]   …and ${needs.length - 5} more`);
    return;
  }

  let rowsUpserted = 0;
  let imgEnriched = 0;
  let imgUnreadable = 0;
  for (let idx = 0; idx < needs.length; idx++) {
    const row = needs[idx];
    const imgCount = countMarkers(row.content);
    console.log(`[enrich] row ${idx + 1}/${needs.length} (id=${row.id}) ${imgCount} image${imgCount === 1 ? "" : "s"}`);
    const result = await enrichContent(row.content);
    imgEnriched += result.enriched;
    imgUnreadable += result.unreadable;

    if (result.content === row.content) {
      // Defensive: should not happen since we filtered on marker presence, but
      // skip the upsert if nothing actually changed.
      console.log(`[enrich] row ${idx + 1}/${needs.length} no changes, skipping upsert`);
      continue;
    }

    // upsert_bookmark replaces ALL fields on conflict — include every key the
    // RPC reads (id, content, url, author, source, tags, why, status,
    // promoted_item_id, bookmarked_at) so we don't accidentally clobber
    // promoted_item_id on already-promoted rows.
    const payload = {
      id: row.id,
      content: result.content,
      url: row.url,
      author: row.author,
      source: row.source,
      tags: row.tags,
      why: row.why,
      status: row.status,
      promoted_item_id: row.promoted_item_id,
      bookmarked_at: row.bookmarked_at,
    };
    const { error: upErr } = await supa.rpc("upsert_bookmark", {
      p_sync_id: syncId,
      p_bookmark: payload,
    });
    if (upErr) {
      console.warn(`[enrich] row ${idx + 1}/${needs.length} upsert failed: ${upErr.message}`);
      continue;
    }
    rowsUpserted++;
    console.log(`[enrich] row ${idx + 1}/${needs.length} upserted`);
  }

  console.log(`[enrich] done: ${rowsUpserted}/${needs.length} rows upserted, ${imgEnriched + imgUnreadable} images (${imgEnriched} enriched, ${imgUnreadable} unreadable)`);
}

main().catch(e => {
  console.error(`[enrich] FAILED: ${e?.message || e}`);
  process.exit(1);
});
