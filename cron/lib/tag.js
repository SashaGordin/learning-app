// Shared bookmark normalization + Claude tagging helpers.
//
// Used by both `import_bookmarks.js` (X archive ingest, source="archive") and
// `sync_bookmarks.js` (live X bookmark dump from Claude-in-Chrome, source="x").
// `normalize` accepts the same raw shape either path produces — pass the
// appropriate `source` per-caller.

import { ask } from "./claude.js";

export const TAG_BATCH = 20;       // tweets per Claude tagging call
export const MIN_TAG_TEXT = 20;    // skip tagging if text is shorter than this
export const MAX_TWEET_CHARS = 400;// truncate per-tweet text in the tagging prompt

// X archive timestamps can be ISO or the legacy "Wed Mar 15 12:34:56 +0000 2023"
// format. Coerce to ISO, return null on anything unparseable.
export function coerceTimestamp(s) {
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Builds the canonical `content` string from a raw scraped entry. Tweet body
// is the lead, then optional markers in this order:
//   [truncated]                          — Show more was visible; body is partial
//   [link: <title> — <desc> | <url>]     — external link card
//   [image_url: <url>]                   — one per attached image, for later
//                                          server-side vision enrichment
// All markers are appended only when the source data carries them, so the
// archive-import path (which only sets fullText) still produces a bare body.
function buildContent(b) {
  const body = (b.fullText ?? b.full_text ?? b.text ?? "").toString().trim();
  const parts = [];
  if (body) parts.push(body);

  if (b.textTruncated === true) parts.push("[truncated]");

  const lc = b.linkCard;
  if (lc && typeof lc === "object") {
    const title = (lc.title || "").toString().trim();
    const desc = (lc.description || "").toString().trim();
    const url = (lc.url || "").toString().trim();
    // X's player/media cards expose only a t.co URL with no title — those are
    // noise. Require a real title before emitting a [link: ...] block.
    if (title) {
      const lhs = desc ? `${title} — ${desc}` : title;
      parts.push(`[link: ${lhs} | ${url}]`);
    }
  }

  const imageUrls = Array.isArray(b.imageUrls) ? b.imageUrls : [];
  for (const u of imageUrls) {
    if (typeof u === "string" && u.trim()) parts.push(`[image_url: ${u.trim()}]`);
  }

  return parts.join("\n\n");
}

export function normalize(entry, { source } = {}) {
  if (!source) throw new Error("normalize: { source } is required");
  const b = entry?.bookmark || entry;
  if (!b) return null;
  const id = String(b.tweetId ?? b.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    content: buildContent(b),
    url: `https://x.com/i/web/status/${id}`,
    author: b.screenName ?? b.screen_name ?? b.author ?? null,
    source,
    bookmarked_at: coerceTimestamp(b.createdAt ?? b.created_at ?? null),
  };
}

// `[image_url: ...]` markers are bare CDN URLs and waste tagging tokens
// without helping the tagger. Strip them before sending content to Claude
// for tag generation, while leaving them in the stored content for future
// vision-enrichment.
function contentForTagging(content) {
  return content
    .split("\n")
    .filter(line => !line.startsWith("[image_url:"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Returns Map<id, { tags: string[], why: string|null }> for the items that
// had enough text to tag. Items without text are left alone.
export async function tagBatch(items) {
  // Build (id, tagText) pairs from items, dropping items without enough
  // taggable text (the [image_url:] markers are stripped for this).
  const taggable = items
    .map(b => ({ id: b.id, tagText: contentForTagging(b.content || "") }))
    .filter(x => x.tagText.length >= MIN_TAG_TEXT);
  if (!taggable.length) return new Map();
  const prompt = [
    "You are tagging X (Twitter) bookmarks for an AI / agentic-engineering learner who wants to deepen mastery of agents, coding agents (Claude Code), LLM evals, RLHF, and open models.",
    "",
    "For each tweet below, return:",
    "- `id`: the tweet id, as a STRING (with double quotes) — tweet ids exceed JS safe-integer range, so unquoted numbers lose precision",
    "- `tags`: 2-4 short lowercase hyphenated topic tags (e.g. \"agents\", \"prompt-engineering\", \"claude-code\", \"benchmarks\", \"rlhf\", \"open-models\")",
    "- `why`: one short sentence (<= 120 chars) describing what makes the tweet noteworthy. If the tweet is low-signal, set why to null.",
    "",
    "The text may contain a `[truncated]` marker (body cut off by X's \"Show more\") or a `[link: title — desc | url]` block (linked article preview). Both are signal — use them to inform tags and why.",
    "",
    "Return STRICT JSON only — an array of objects { id, tags, why } in the SAME ORDER as the tweets below. No prose, no markdown fences.",
    "",
    "Tweets:",
    ...taggable.map(b => `id: ${b.id}\ntext: ${b.tagText.replace(/\s+/g, " ").slice(0, MAX_TWEET_CHARS)}\n---`),
  ].join("\n");

  let raw;
  try {
    raw = await ask(prompt, { noSearch: true, maxTokens: 4096 });
  } catch (e) {
    console.warn(`[tag] tagging call failed (${taggable.length} items): ${e?.message || e}`);
    return new Map();
  }
  if (process.env.IMPORT_DEBUG) console.log(`[tag][debug] raw Claude response:\n${raw}\n---`);

  let jsonText = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1];
  const m = jsonText.match(/\[[\s\S]*\]/);
  if (m) jsonText = m[0];

  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (e) {
    console.warn(`[tag] tagging response was not valid JSON; skipping tags for this batch.`);
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
