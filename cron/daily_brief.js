// Daily brief: ~5 min read covering the past 24-48 hrs. Sent via email.

import { ask } from "./lib/claude.js";
import { sendEmail } from "./lib/email.js";

const today = new Date();
const dateStr = today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const isoDate = today.toISOString().slice(0,10);

const PROMPT = `You are producing Sasha's daily AI/agentic-engineering brief. Sasha is a developer interested in: agentic engineering, building agents, Claude Code best practices, MCP, alternative coding agents (Cursor, Aider, Cline, Codex CLI, OpenCode, "Pi"), open-source models (Hermes / Nous Research, Llama, Qwen), and LLM updates from Anthropic, OpenAI, Google, Meta. They have a 1.5-2 hr daily commute and read this on commute, so favor skimmable text. Quality over coverage.

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

await sendEmail({
  subject: `Daily AI Brief — ${dateStr}`,
  markdown: md,
});
console.log("[daily_brief] done");
