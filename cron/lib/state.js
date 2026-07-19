// Reads and writes the user's learning state in Supabase and joins item ids
// with SEED metadata parsed out of frontend/index.html.
//
// Reads are best-effort: if SUPABASE_URL / LEARNING_SYNC_ID aren't set, or
// the network is down, callers receive null instead of an exception.

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
    console.log("[state] LEARNING_SYNC_ID not set — skipping state access.");
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
 * Returns the complete shared resource catalog (SEED + custom items). Useful
 * for jobs that need to resolve a bounded set of user-selected item ids.
 */
export async function listItems(state = null) {
  const [seed, st] = await Promise.all([
    loadSeed().catch(() => new Map()),
    state ? Promise.resolve(state) : loadState(),
  ]);
  return [...seed.values(), ...Object.values(st?.custom || {})];
}
