// Weekly deep brief: ~15-20 min read, Sunday evening. Sent via email.

import { ask } from "./lib/claude.js";
import { sendEmail } from "./lib/email.js";
import {
  recentDones,
  formatPersonalization,
  recentSuggestions,
  formatSuggestions,
} from "./lib/state.js";

const today = new Date();
const sun = new Date(today);
const mon = new Date(today); mon.setDate(today.getDate() - 6);
const fmt = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const yr = today.getFullYear();
const range = `${fmt(mon)} – ${fmt(sun)}, ${yr}`;
const isoDate = today.toISOString().slice(0,10);

// Use a slightly bigger window than the daily — the weekly synthesis benefits
// from seeing what Sasha learned over the past couple of weeks, not just days.
const dones = await recentDones(12);
const personalization = formatPersonalization(dones);
if (dones.length) console.log(`[weekly_brief] personalizing with ${dones.length} recent done items`);

// Pull bookmark-derived experiments + ideas + interest profile (Phase 6.3).
// All best-effort; empty strings if state isn't populated yet.
const suggestions = await recentSuggestions({ experimentLimit: 3, ideaLimit: 2 });
const suggestionBlock = formatSuggestions(suggestions);
if (suggestions.experiments.length || suggestions.ideas.length) {
  console.log(`[weekly_brief] injecting ${suggestions.experiments.length} experiments + ${suggestions.ideas.length} ideas from bookmarks`);
}
if (suggestions.profile?.summary) {
  console.log(`[weekly_brief] interest profile generated ${suggestions.profile.generatedAt || "—"}`);
}

const PROMPT = `You are producing Sasha's WEEKLY deep brief on AI/agentic engineering. Sasha is a developer who gets a 5-minute daily brief; this is the longer Monday-morning commute read. Target ~15-20 minutes of reading (1500-2500 words).

Sasha is interested in: agentic engineering, building agents, Claude Code best practices, MCP, coding agents (Cursor, Aider, Cline, Codex CLI, OpenCode, "Pi"), open-source models (Hermes / Nous Research, Llama, Qwen), and LLM updates from Anthropic, OpenAI, Google, Meta. Sasha wants to be told what to PAY ATTENTION TO — not just a recap.

${suggestionBlock}${personalization}
TASK
Cover the past 7 days (${range}). Run 8-12 web searches across:
- Claude Code / Anthropic releases and engineering posts
- Major lab announcements (OpenAI, Google DeepMind, xAI, Meta)
- Open model releases (Hermes / Nous, Llama, Qwen, DeepSeek, Mistral)
- Agentic engineering / multi-agent posts, papers, GitHub repos that trended
- Coding agent ecosystem (Cursor / Aider / Cline / Codex CLI / OpenCode)
- MCP ecosystem updates
- Notable arXiv preprints
- Long-form posts (Simon Willison, Karpathy, Lilian Weng, Raschka, swyx Latent Space, Dwarkesh)
- Podcasts/videos worth queuing for next week's commute

OUTPUT — return Markdown only, no preamble. This exact structure:

# Weekly Deep Brief — ${range}

## The one thing
One tight paragraph: if Sasha reads one section, this is what mattered most this week and why.

## What happened
3-5 themed subheadings. Under each, 2-4 paragraphs of synthesis — connect items, point out trends, don't just list. Link every claim.

## Worth your commute this week
3-5 items to actually consume next week. Each:
- **Title** — [link]
- Format and length
- One paragraph on what they'll get
- Where it fits (commute? evening? weekend?)

## Experiments to try
Reproduce the items from the EXPERIMENTS TO SURFACE THIS WEEK block verbatim under this heading — title (with timeToTry in parens), the "why" sentence, and a numbered or bulleted steps list. Then a "### Ideas worth exploring" subheading with the IDEAS WORTH EXPLORING entries (title + hypothesis + first action). If neither block was provided, omit this whole section.

## Add to the backlog
1-3 specific resources for the persistent learning backlog. Each: title, source, URL, estimated time, one-line why.

## On the horizon
Things announced not released, papers people are talking about, events next week.

## Skeptic's corner
1 paragraph: what's overhyped, what didn't pan out. Skip section if nothing real.

GUARDRAILS
- Synthesize, don't list.
- Verify before stating.
- Skip Twitter/X embeds.

End with: "Want me to spin up a deep dive on any theme? Just reply."`;

console.log(`[weekly_brief] ${isoDate} starting`);
const start = Date.now();
const md = await ask(PROMPT, { maxTokens: 8000, maxSearches: 16 });
console.log(`[weekly_brief] generated in ${Math.round((Date.now()-start)/1000)}s, ${md.length} chars`);

await sendEmail({
  subject: `Weekly Deep Brief — ${range}`,
  markdown: md,
});
console.log("[weekly_brief] done");
