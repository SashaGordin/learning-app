// Daily brief: ~5 min read covering the past 24-48 hrs. Sent via email.

import { ask } from "./lib/claude.js";
import { sendEmail } from "./lib/email.js";
import { recentDones, formatPersonalization, loadState, getItemById } from "./lib/state.js";

const today = new Date();
const dateStr = today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const isoDate = today.toISOString().slice(0,10);

// Pull recent learning context so the brief can connect today's news to what
// Sasha actually finished and noted. Best-effort: empty string if state
// access fails, so the brief still goes out.
const dones = await recentDones(7);
const personalization = formatPersonalization(dones);
if (dones.length) console.log(`[daily_brief] personalizing with ${dones.length} recent done items`);

// Pull pendingMemory (written by memory.js earlier in the morning). If
// present and generated today, render a `## Memory` section before the
// generated brief body — that section is a static include, not Claude-
// generated, so it shows up exactly as memory.js wrote it.
const state = await loadState();
let memorySection = "";
if (state?.pendingMemory?.question && state.pendingMemory.generatedFor === isoDate) {
  const pm = state.pendingMemory;
  const item = await getItemById(pm.itemId, state);
  const meta = state.items?.[pm.itemId] || {};
  const completedDays = meta.completedAt
    ? Math.floor((Date.now() - new Date(meta.completedAt).getTime()) / (24 * 3600 * 1000))
    : null;
  const titleLine = item ? `**${item.title}**${item.source ? ` · ${item.source}` : ""}` : `**${pm.itemId}**`;
  const noteLine = meta.note ? `\n> Your note when you finished: "${meta.note}"` : "";
  const timing = completedDays != null ? ` _(${completedDays} days ago)_` : "";
  memorySection =
    `## Memory\n\n` +
    `${titleLine}${timing}${noteLine}\n\n` +
    `**Quick recall:** ${pm.question}\n\n` +
    `_Open the app to mark this as remembered / fuzzy / forgot — your next review date adjusts accordingly._\n\n---\n\n`;
  console.log(`[daily_brief] including Memory section for ${pm.itemId}`);
}

const PROMPT = `You are producing Sasha's daily AI/agentic-engineering brief. Sasha is a developer interested in: agentic engineering, building agents, Claude Code best practices, MCP, alternative coding agents (Cursor, Aider, Cline, Codex CLI, OpenCode, "Pi"), open-source models (Hermes / Nous Research, Llama, Qwen), and LLM updates from Anthropic, OpenAI, Google, Meta. They have a 1.5-2 hr daily commute and read this on commute, so favor skimmable text. Quality over coverage.

${personalization}
TASK
Produce a focused ~5-minute-read brief covering the last 24-48 hours, dated ${dateStr}.

Run 5-7 targeted web searches across:
- Claude Code updates/releases (past 48 hrs)
- Anthropic announcements
- Major OpenAI / Google DeepMind / Meta AI news
- Agentic engineering / multi-agent posts
- MCP updates and new servers
- Open model releases (Hermes, Llama, Qwen, DeepSeek)
- Notable individual posts (Simon Willison, Karpathy, Lilian Weng)

FILTER RUTHLESSLY. Skip generic "AI is transforming X" articles, vendor PR with no substance, stale rewrites. Prefer primary sources.

OUTPUT — return Markdown only, no preamble. This exact structure:

# Daily Brief — ${dateStr}

## TL;DR
- 3 to 5 bullets, single sentence each, only what genuinely matters today. Don't pad.

## Top stories
For each of 3 to 5 items:
**[Headline]** — 1-2 sentence summary. [Source link](url). *Why it matters: one line.*

## Worth a deeper look
1-2 items worth adding to the learning backlog. Each: title, link, time estimate, one sentence on what they'd learn.

## Quick hits
3-6 one-line bullets, each with a link.

## On the radar
Optional: 1-3 announced-but-not-released items.

GUARDRAILS
- If you cannot verify a claim, omit it.
- Skip Twitter/X embeds; use the underlying source.
- Length 400-700 words. Hard cap 900.

End with: "Want a deeper dive on any of these? Reply with the headline."`;

console.log(`[daily_brief] ${isoDate} starting`);
const start = Date.now();
const md = await ask(PROMPT, { maxTokens: 3500, maxSearches: 10 });
console.log(`[daily_brief] generated in ${Math.round((Date.now()-start)/1000)}s, ${md.length} chars`);

// Memory section goes before the brief body so it's the first thing Sasha
// sees on the commute. It's optional; if empty it just collapses cleanly.
const body = memorySection + md;

await sendEmail({
  subject: `Daily AI Brief — ${dateStr}`,
  markdown: body,
});
console.log("[daily_brief] done");
