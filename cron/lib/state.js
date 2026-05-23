// Reads the user's learning state from Supabase and joins it with the SEED
// metadata parsed out of frontend/index.html. Exposes `recentDones()` for
// brief personalization and a small `formatPersonalization()` helper that
// turns those into a prompt-ready Markdown block.
//
// Reads are best-effort: if SUPABASE_URL / LEARNING_SYNC_ID aren't set, or
// the network is down, we return empty results instead of throwing. Briefs
// degrade to the generic prompt rather than failing entirely.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(__dirname, "..", "..", "frontend", "index.html");

// ---- SEED parser ---------------------------------------------------------
// Same approach as curator.js: parse the JS array between // SEED_START /
// // SEED_END markers via vm.runInContext. Cached for the lifetime of the
// process; if the file changes between scheduled runs we get a fresh copy
// next time the process is spawned.
let _seedCache = null;
async function loadSeed() {
  if (_seedCache) return _seedCache;
  const html = await readFile(FRONTEND, "utf8");
  const m = html.match(/\/\/ SEED_START\n([\s\S]*?)\/\/ SEED_END/);
  if (!m) throw new Error("SEED markers not found in frontend/index.html");
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(m[1] + ";this.SEED = SEED;", ctx);
  _seedCache = new Map((ctx.SEED || []).map(it => [it.id, it]));
  return _seedCache;
}

// ---- Supabase client (lazy) ---------------------------------------------
let _client = null;
function client() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/**
 * Returns the raw state JSON for the configured sync_id, or null if not
 * configured / network failed. The returned object carries a non-enumerable
 * `__rowUpdatedAt` property that saveState can pass back as if_unchanged_since
 * for optimistic concurrency. Logs but never throws.
 */
export async function loadState() {
  const syncId = process.env.LEARNING_SYNC_ID;
  if (!syncId) {
    console.log("[state] LEARNING_SYNC_ID not set — briefs will run without personalization.");
    return null;
  }
  const supa = client();
  if (!supa) {
    console.log("[state] SUPABASE_URL/SUPABASE_ANON_KEY not set — skipping state load.");
    return null;
  }
  try {
    const { data, error } = await supa.rpc("get_state", { p_sync_id: syncId });
    if (error) {
      console.warn(`[state] get_state failed: ${error.message}`);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.state) return null;
    Object.defineProperty(row.state, "__rowUpdatedAt", {
      value: row.updated_at,
      enumerable: false,
      writable: false,
    });
    return row.state;
  } catch (e) {
    console.warn(`[state] get_state threw: ${e?.message || e}`);
    return null;
  }
}

/**
 * Writes state back via set_state. Bumps state.updatedAt so the PWA's pull
 * cycle picks the change up. Returns true on success, false on any failure
 * (so callers can degrade gracefully).
 *
 * NOTE: passes p_if_unchanged_since to avoid clobbering concurrent writes
 * from the PWA — if the PWA wrote between our read and write, we abort and
 * let the next cron tick try again.
 */
export async function saveState(state, opts = {}) {
  const syncId = process.env.LEARNING_SYNC_ID;
  if (!syncId) {
    console.warn("[state] LEARNING_SYNC_ID not set — cannot save.");
    return false;
  }
  const supa = client();
  if (!supa) {
    console.warn("[state] no Supabase client — cannot save.");
    return false;
  }
  const next = { ...state, updatedAt: new Date().toISOString() };
  try {
    const args = { p_sync_id: syncId, p_state: next };
    if (opts.ifUnchangedSince) args.p_if_unchanged_since = opts.ifUnchangedSince;
    const { data, error } = await supa.rpc("set_state", args);
    if (error) {
      console.warn(`[state] set_state failed: ${error.message}`);
      return false;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.conflict) {
      console.warn("[state] set_state conflict — PWA wrote concurrently; aborting this run.");
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[state] set_state threw: ${e?.message || e}`);
    return false;
  }
}

/**
 * Convenience: load SEED + state's `custom` map, then look up an item by id.
 * Returns null if not found anywhere.
 */
export async function getItemById(id, state = null) {
  const [seed, st] = await Promise.all([
    loadSeed().catch(() => new Map()),
    state ? Promise.resolve(state) : loadState(),
  ]);
  return seed.get(id) || st?.custom?.[id] || null;
}

/**
 * Most recently completed items (status === "done"), newest first, joined
 * with SEED metadata for title/source/category. Each result:
 *   { id, title, source, url, category, type, note, rating, completedAt }
 *
 * @param {number} limit — max items to return (default 7).
 */
export async function recentDones(limit = 7) {
  const [state, seed] = await Promise.all([loadState(), loadSeed().catch(e => {
    console.warn(`[state] SEED parse failed: ${e?.message || e}`);
    return new Map();
  })]);
  if (!state || !state.items) return [];

  const customMap = state.custom || {};
  const out = [];
  for (const [id, meta] of Object.entries(state.items)) {
    if (!meta || meta.status !== "done") continue;
    const seedItem = seed.get(id) || customMap[id] || null;
    out.push({
      id,
      title: seedItem?.title || id,
      source: seedItem?.source || "",
      url: seedItem?.url || "",
      category: seedItem?.category || "",
      type: seedItem?.type || "",
      note: meta.note || null,
      rating: meta.rating || null,
      completedAt: meta.completedAt || meta.updatedAt || null,
    });
  }
  out.sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  return out.slice(0, Math.max(limit, 0));
}

/**
 * Formats a Markdown block suitable to inject into a brief prompt. Returns
 * an empty string if there are no dones — so callers can safely template it
 * into prompts unconditionally.
 */
export function formatPersonalization(dones) {
  if (!dones || !dones.length) return "";
  const lines = dones.map(d => {
    const rating = d.rating ? ` (rated ${d.rating}/5)` : "";
    const note   = d.note ? `\n  note: "${d.note}"` : "";
    const when   = d.completedAt ? ` — ${d.completedAt.slice(0, 10)}` : "";
    return `- "${d.title}"${d.source ? ` · ${d.source}` : ""}${rating}${when}${note}`;
  });
  return [
    "## RECENT LEARNING CONTEXT",
    "Sasha just finished these (newest first). Reference them where relevant — connect today's news to what they just learned, build on themes in their notes, and don't resurface items they marked done.",
    "",
    lines.join("\n"),
    "",
  ].join("\n");
}
