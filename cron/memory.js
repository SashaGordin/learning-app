// Spaced-recall job. Runs on weekday mornings. Picks one Done item that's due
// for review, asks Claude (no web search) for ONE active-recall question plus
// a compact answer rubric grounded in the item + Sasha's own takeaway note,
// and stores the result in state.pendingMemory.
//
// The PWA renders it as a card with three confidence buttons, then requires a
// written explanation. grade_memory.js assesses that evidence and owns the
// review schedule. There is deliberately no newsletter/email surface.
//
// Review schedule (applied by grade_memory.js):
//   New: nextReviewAt = completedAt + 1 day  (first impression — Ebbinghaus)
//   Correct:    step up — 1d → 7d → 30d → 90d → 180d (caps at 180)
//   Partial:    halve current interval, min 1d
//   Incorrect:  reset to step 0 (1d)
//
// CLI: `node memory.js` runs normally. `node memory.js --force` ignores due
// dates and picks the most recent Done item — useful for testing.

import { ask } from "./lib/claude.js";
import { loadState, saveState, getItemById } from "./lib/state.js";

const FORCE = process.argv.includes("--force");
const today = new Date().toISOString().slice(0, 10);
const isoNow = new Date().toISOString();

function parseRecall(raw) {
  let text = String(raw || "").trim();
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text);
  return {
    question: String(parsed.question || "").trim(),
    referenceAnswer: String(parsed.referenceAnswer || "").trim(),
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter(point => typeof point === "string" && point.trim()).map(point => point.trim()).slice(0, 5)
      : [],
  };
}

function daysAgo(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
}

const state = await loadState();
if (!state) {
  console.log("[memory] no state available — skipping");
  process.exit(0);
}

// Idempotency: if there's already a pending memory waiting for the user to
// respond, don't overwrite it with a new question — wait until they react.
if (state.pendingMemory && state.pendingMemory.itemId && !FORCE) {
  console.log(`[memory] pending memory already exists for ${state.pendingMemory.itemId} — skipping`);
  process.exit(0);
}

// Find candidates. Done items with a nextReviewAt <= today.
const items = state.items || {};
const candidates = [];
for (const [id, meta] of Object.entries(items)) {
  if (!meta || meta.status !== "done") continue;
  // Phase 1 shipped after the first two items were already Done, so those
  // legacy rows have no completedAt. Their item-level updatedAt is the best
  // available completion timestamp; adopt it lazily when the item is selected
  // instead of excluding already-learned material from recall forever.
  const completedAt = meta.completedAt || meta.updatedAt;
  if (!completedAt) continue;
  const normalizedMeta = meta.completedAt ? meta : { ...meta, completedAt };
  // Skip items we just generated a recall for in the last 24 hrs (safety net)
  if (normalizedMeta.lastReviewedAt && daysAgo(normalizedMeta.lastReviewedAt) < 1) continue;
  const due = !normalizedMeta.nextReviewAt || normalizedMeta.nextReviewAt <= today;
  if (FORCE || due) {
    candidates.push({ id, meta: normalizedMeta });
  }
}

if (!candidates.length) {
  console.log("[memory] no items due for review today");
  process.exit(0);
}

// Pick the most-overdue, oldest-completed candidate. Deterministic across runs.
candidates.sort((a, b) =>
  (a.meta.nextReviewAt || a.meta.completedAt || "").localeCompare(
    b.meta.nextReviewAt || b.meta.completedAt || ""
  ) || (a.meta.completedAt || "").localeCompare(b.meta.completedAt || "")
);
const target = candidates[0];
const item = await getItemById(target.id, state);
if (!item) {
  console.warn(`[memory] item ${target.id} not found in SEED or state.custom — skipping`);
  process.exit(0);
}

const elapsed = daysAgo(target.meta.completedAt) ?? "?";
console.log(`[memory] generating recall for ${target.id} (completed ${elapsed}d ago, due ${target.meta.nextReviewAt || "—"})`);

const PROMPT = `Generate ONE active-recall question and its answer rubric for the learning item below. Sasha completed it ${elapsed} days ago. The goal is to test whether the key insight actually stuck — not surface-level recall, not "what was X about." Aim for the kind of question a smart friend would ask to check if you really got it.

ITEM
Title: ${item.title}
Source: ${item.source || "—"}
URL: ${item.url || "—"}
Category: ${item.category || "—"}
Why it matters: ${item.why || "—"}

SASHA'S OWN NOTE (their takeaway when they finished it)
"${target.meta.note || "(none captured)"}"

GUIDELINES
- Ground the question in this specific item's content. Don't ask a generic "explain X" — be concrete.
- If Sasha's note above hints at what they actually internalized, lean into that thread or stress-test it.
- Prefer "how does X handle Y?" / "why does Z work this way?" / "what would break if A?" over recall-the-fact questions.
- The question must be one sentence under 35 words.
- The reference answer must be 2-4 concise sentences.
- Include 2-5 concrete key points that distinguish real understanding from bluffing.

Return ONLY valid JSON:
{"question":"...","referenceAnswer":"...","keyPoints":["...","..."]}`;

let recall;
try {
  recall = parseRecall(await ask(PROMPT, { maxTokens: 650, noSearch: true }));
} catch (error) {
  console.warn(`[memory] invalid recall JSON: ${error?.message || error}`);
  process.exit(1);
}
if (!recall.question || !recall.referenceAnswer || !recall.keyPoints.length) {
  console.warn("[memory] empty response from Claude — skipping");
  process.exit(1);
}

// Strip wrapping quotes / leading "Q:" labels if Claude added them despite the prompt.
const cleaned = recall.question
  .replace(/^["'`]+|["'`]+$/g, "")
  .replace(/^(quick recall:|recall:|q:)\s*/i, "")
  .trim();

console.log(`[memory] question: ${cleaned}`);

// Write back. pendingMemory carries the item id, the question, and which
// review-step this attempt corresponds to (so the frontend response can bump
// the step appropriately).
state.pendingMemory = {
  itemId: target.id,
  question: cleaned,
  referenceAnswer: recall.referenceAnswer,
  keyPoints: recall.keyPoints,
  generatedAt: isoNow,
  generatedFor: today,                        // ISO date for UI/debugging
  reviewedNoteAt: target.meta.completedAt || null,
};
// Mark this item as having had a recall fired today, so we don't double-fire
// if the user runs memory.js manually after the scheduled run.
items[target.id] = {
  ...target.meta,
  lastReviewedAt: isoNow,
  updatedAt: isoNow,
};
state.items = items;

// Optimistic concurrency: pass back the row's updated_at from the load so
// set_state aborts if the PWA wrote between our read and write. If we lose
// the race, no harm done — next scheduled tick tries again.
const ok = await saveState(state, { ifUnchangedSince: state.__rowUpdatedAt });
if (!ok) {
  console.error("[memory] saveState failed — pending memory NOT persisted (will retry next run)");
  process.exit(1);
}
console.log("[memory] saved pendingMemory; the PWA will surface it");
