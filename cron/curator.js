// Backlog curator: edits frontend/index.html SEED block in place, emails a summary.

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "./lib/claude.js";
import { sendEmail } from "./lib/email.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(__dirname, "..", "frontend", "index.html");

const today = new Date().toISOString().slice(0,10);

// ---- Parse current SEED out of the HTML ----
const html = await readFile(FRONTEND, "utf8");
const seedMatch = html.match(/\/\/ SEED_START\n([\s\S]*?)\/\/ SEED_END/);
const changeMatch = html.match(/\/\/ CHANGELOG_START\n([\s\S]*?)\/\/ CHANGELOG_END/);
if (!seedMatch || !changeMatch) throw new Error("SEED or CHANGELOG markers not found in frontend/index.html");

const seedJsBlock = seedMatch[1];   // contains "const SEED = [ ... ];\n"
const changeJsBlock = changeMatch[1]; // contains "const CHANGELOG = [ ... ];\n"

// Parse the JS arrays via vm.runInNewContext for safety.
import vm from "node:vm";
const ctx = {};
vm.createContext(ctx);
vm.runInContext(seedJsBlock + "\n" + changeJsBlock + "\n;this.SEED=SEED;this.CHANGELOG=CHANGELOG;", ctx);
const currentSeed = ctx.SEED;
const currentChangelog = ctx.CHANGELOG;
const existingIds = new Set(currentSeed.map(i => i.id));

console.log(`[curator] read ${currentSeed.length} existing items, ${currentChangelog.length} changelog entries`);

// ---- Ask Claude for curation suggestions ----
const PROMPT = `You are the weekly curator for Sasha's learning backlog. Your job: search for genuinely high-signal new content from the past 7 days and decide what (if anything) to add. Bar is HIGH — better to add 0 items than to add filler.

CURRENT BACKLOG (don't duplicate these):
${currentSeed.map(i => `- ${i.id}: ${i.title} (${i.source})`).join("\n")}

Search 6-10 high-signal sources from the past 7 days:
- Anthropic engineering blog
- Simon Willison's blog
- Karpathy (now at Anthropic; watch for content)
- Lilian Weng / Sebastian Raschka
- Latent Space / Dwarkesh new episodes
- Model Context Protocol blog
- Hermes Agent / Nous Research releases
- Major arXiv preprints on agents/tool-use
- GitHub trending agent repos

SKIP: vendor PR, listicles, rewrites of existing news, anything that won't matter in 6 months.
ADD if it's from a top-tier source AND is a primary technical resource OR a working canonical repo.

Aim for 0-3 new items per week. Some weeks have nothing — that's fine.

OUTPUT
Return ONLY a JSON object with this exact shape (no Markdown, no preamble):
{
  "additions": [
    {
      "id": "kebab-case-slug",
      "tier": 1|2|3|4|5|0,
      "order": 1000,
      "prereqs": [],
      "category": "Fundamentals|Agentic Engineering|Claude Code|Coding Agents|Open Models|Daily Reads|Podcasts",
      "type": "Article|Video|Podcast|Tutorial|Course|Repo|Newsletter",
      "title": "...",
      "source": "...",
      "url": "https://...",
      "min": 30,
      "prio": "high|med|low",
      "why": "ONE sentence — what they'll get."
    }
  ],
  "removals": ["id1", "id2"],
  "note": "One-line summary for the changelog, e.g. 'Added 2 items on MCP; pruned 1 dead link.'"
}

Tiers: 1 Foundations · 2 Agentic engineering · 3 Claude Code · 4 Agent ecosystem · 5 Deep dives · 0 Ongoing reads (not sequenced).
If you have nothing worth adding and nothing to remove, return {"additions":[],"removals":[],"note":"Nothing worth adding this week."}.`;

console.log("[curator] querying Claude…");
const raw = await ask(PROMPT, { maxTokens: 4000, maxSearches: 12 });

// Extract JSON object from response (model sometimes wraps in ```json blocks)
let jsonText = raw.trim();
const fence = jsonText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
if (fence) jsonText = fence[1];
let decision;
try { decision = JSON.parse(jsonText); }
catch (e) {
  // Don't crash the run — log the full response and fall back to no changes so
  // the email still goes out and the frontend isn't left in a half-state.
  console.error("[curator] failed to parse JSON response. Full response below:");
  console.error(raw);
  decision = { additions: [], removals: [], note: "Curator: Claude returned non-JSON; no changes applied this week." };
}

// Validate additions against the SEED schema before we splice them into HTML.
const VALID_TIERS = new Set([0, 1, 2, 3, 4, 5]);
const VALID_TYPES = new Set(["Article", "Video", "Podcast", "Tutorial", "Course", "Repo", "Newsletter"]);
const VALID_PRIOS = new Set(["high", "med", "low"]);
function isValidAddition(a) {
  if (!a || typeof a !== "object") return false;
  if (typeof a.id !== "string" || !a.id) return false;
  if (typeof a.title !== "string" || !a.title) return false;
  if (typeof a.source !== "string" || !a.source) return false;
  if (typeof a.url !== "string" || !/^https?:\/\//.test(a.url)) return false;
  if (!VALID_TIERS.has(a.tier)) return false;
  if (typeof a.category !== "string" || !a.category) return false;
  if (!VALID_TYPES.has(a.type)) return false;
  if (typeof a.min !== "number" || a.min <= 0) return false;
  if (!VALID_PRIOS.has(a.prio)) return false;
  if (typeof a.why !== "string" || !a.why) return false;
  return true;
}

const rawAdditions = decision.additions || [];
const additions = [];
for (const a of rawAdditions) {
  if (!isValidAddition(a)) {
    console.warn(`[curator] skipping malformed addition: ${JSON.stringify(a)}`);
    continue;
  }
  if (existingIds.has(a.id)) {
    console.warn(`[curator] skipping duplicate id: ${a.id}`);
    continue;
  }
  additions.push(a);
}
const removals = (decision.removals || []).filter(id => existingIds.has(id) && !id.startsWith("custom-"));

console.log(`[curator] +${additions.length} -${removals.length}`);

// ---- Apply changes ----
let newSeed = currentSeed.filter(i => !removals.includes(i.id));
for (const a of additions) {
  newSeed.push({ ...a, addedAt: today });
}

// ---- Rewrite the HTML ----
const seedJs = "const SEED = [\n" +
  newSeed.map(i => `  ${JSON.stringify(i)}`).join(",\n") +
  "\n];\n";
const newChangelog = [
  ...currentChangelog,
  { date: today, note: decision.note || `Added ${additions.length}, removed ${removals.length}.` }
];
const changelogJs = "const CHANGELOG = " + JSON.stringify(newChangelog, null, 2) + ";\n";

const afterSeed = html.replace(
  /\/\/ SEED_START\n[\s\S]*?\/\/ SEED_END/,
  `// SEED_START\n${seedJs}// SEED_END`
);
if (afterSeed === html) throw new Error("SEED splice no-op — markers may have drifted in frontend/index.html");
const newHtml = afterSeed.replace(
  /\/\/ CHANGELOG_START\n[\s\S]*?\/\/ CHANGELOG_END/,
  `// CHANGELOG_START\n${changelogJs}// CHANGELOG_END`
);
if (newHtml === afterSeed) throw new Error("CHANGELOG splice no-op — markers may have drifted in frontend/index.html");

// Atomic write: write to .tmp then rename. POSIX rename is atomic, so a crash
// mid-write can't leave the deployed file truncated.
const TMP = FRONTEND + ".tmp";
try {
  await writeFile(TMP, newHtml);
  await rename(TMP, FRONTEND);
} catch (e) {
  try { await unlink(TMP); } catch {}
  throw e;
}
console.log("[curator] wrote frontend/index.html");

// ---- Email a summary ----
const summary = additions.length === 0 && removals.length === 0
  ? `# Backlog Curator — ${today}\n\nNothing worth adding this week.\n\n_${decision.note || ""}_`
  : `# Backlog Curator — ${today}\n\n${decision.note || ""}\n\n` +
    (additions.length ? `## Added (${additions.length})\n\n` +
      additions.map(a => `- **${a.title}** — [${a.source}](${a.url}) · ${a.min} min · Tier ${a.tier}\n  ${a.why}`).join("\n\n") + "\n\n" : "") +
    (removals.length ? `## Removed (${removals.length})\n\n` +
      removals.map(id => `- \`${id}\``).join("\n") + "\n\n" : "") +
    `Run \`./deploy.sh\` from the project root when you want to push these changes to Cloudflare Pages.`;

await sendEmail({
  subject: `Backlog Curator — ${additions.length} added, ${removals.length} removed`,
  markdown: summary,
});
console.log("[curator] done");
