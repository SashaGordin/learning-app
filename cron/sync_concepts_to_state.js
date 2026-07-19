// One-shot/backfill bridge from private concepts/*.md files into the
// sync-protected learning state. New analyze_bookmarks.js runs store this
// content directly; this script recovers notes produced before that field was
// added, without publishing the files as public PWA assets.

import crypto from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState } from "./lib/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCEPTS_DIR = resolve(__dirname, "..", "concepts");

function idFor(sourceIds, title) {
  const source = sourceIds.length ? [...sourceIds].sort().join(",") : title.toLowerCase();
  return `ins_${crypto.createHash("sha256").update(source).digest("hex").slice(0, 10)}`;
}

function parseNote(markdown, filePath, generatedAt) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!title) return null;
  const theme = markdown.match(/^>\s*\*([^\n]+)\*\s*$/m)?.[1]?.trim() || "";
  const insightSection = markdown.match(/## Cross-cutting insight\s+([\s\S]*?)(?=\n##\s|$)/i)?.[1]?.trim() || "";
  const summary = insightSection.replace(/\s+/g, " ").slice(0, 160) || theme.slice(0, 160);
  const sourceBookmarkIds = [...new Set(
    [...markdown.matchAll(/https:\/\/x\.com\/i\/web\/status\/(\d+)/g)].map(match => match[1])
  )];
  return {
    id: idFor(sourceBookmarkIds, title),
    title,
    theme,
    summary,
    content: markdown,
    filePath,
    sourceBookmarkIds,
    sourceCount: sourceBookmarkIds.length,
    generatedAt,
    surfacedAt: null,
  };
}

const state = await loadState();
if (!state) throw new Error("learning state unavailable");

const existing = new Map((state.insights || []).map(insight => [insight.filePath, insight]));
const files = (await readdir(CONCEPTS_DIR)).filter(file => file.endsWith(".md")).sort();
const insights = [];
for (const file of files) {
  const absolute = resolve(CONCEPTS_DIR, file);
  const [markdown, fileStat] = await Promise.all([readFile(absolute, "utf8"), stat(absolute)]);
  const filePath = `concepts/${file}`;
  const parsed = parseNote(markdown, filePath, fileStat.mtime.toISOString());
  if (!parsed) {
    console.warn(`[sync_concepts] skipped ${file}: missing H1 title`);
    continue;
  }
  const previous = existing.get(filePath);
  insights.push({
    ...parsed,
    ...(previous || {}),
    content: markdown,
    sourceBookmarkIds: parsed.sourceBookmarkIds,
    sourceCount: parsed.sourceCount,
    generatedAt: previous?.generatedAt || parsed.generatedAt,
  });
}

state.insights = insights;
const ok = await saveState(state, { ifUnchangedSince: state.__rowUpdatedAt });
if (!ok) throw new Error("state changed while concepts were being synced; retry");
console.log(`[sync_concepts] synced ${insights.length} private concept notes into learning state`);
