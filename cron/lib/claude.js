// Thin wrapper around the Anthropic Messages API with built-in web_search tool.
// Returns the final assistant text after all tool calls resolve.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";
const VISION_MODEL = process.env.CLAUDE_VISION_MODEL || "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 5 * 60 * 1000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Run a prompt that may use the web_search tool. The SDK auto-handles
 * server-side tool execution for web_search.
 * @param {string} prompt — user prompt
 * @param {object} opts — { maxTokens, maxSearches, system, timeoutMs, noSearch }
 *   noSearch=true disables the web_search tool entirely (cheaper + faster
 *   for prompts where you don't want Claude searching, e.g. recall question
 *   generation grounded in already-known item content).
 * @returns {Promise<string>} concatenated text from the assistant
 */
export async function ask(prompt, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const req = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  };
  if (!opts.noSearch) {
    req.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxSearches ?? 10 }];
  }
  const res = await client.messages.create(req, { timeout: timeoutMs });
  const u = res.usage || {};
  console.log(`[claude] model=${MODEL} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} stop=${res.stop_reason} elapsed=${Math.round((Date.now()-t0)/1000)}s`);
  if (res.stop_reason === "max_tokens") {
    console.warn(`[claude] response truncated at max_tokens=${opts.maxTokens ?? 4096}`);
  }
  // Concatenate text blocks. The web_search tool runs server-side so the final
  // response contains the synthesized answer directly.
  return res.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

/**
 * Vision call: send one or more image URLs plus a text prompt. No web search.
 * Defaults to Sonnet (cheaper, plenty strong for OCR + chart/photo description).
 * Anthropic SDK accepts URL image sources natively — no need to fetch + base64.
 * @param {string} prompt — user prompt (placed AFTER images per Anthropic guidance)
 * @param {string[]} imageUrls — one or more image URLs
 * @param {object} opts — { model, maxTokens, system, timeoutMs }
 * @returns {Promise<string>} concatenated text from the assistant
 */
export async function askVision(prompt, imageUrls, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!Array.isArray(imageUrls) || !imageUrls.length) throw new Error("askVision: imageUrls must be a non-empty array");
  const model = opts.model || VISION_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const content = [
    ...imageUrls.map(url => ({ type: "image", source: { type: "url", url } })),
    { type: "text", text: prompt },
  ];
  const res = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content }],
  }, { timeout: timeoutMs });
  const u = res.usage || {};
  console.log(`[claude vision] model=${model} imgs=${imageUrls.length} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} stop=${res.stop_reason} elapsed=${Math.round((Date.now()-t0)/1000)}s`);
  if (res.stop_reason === "max_tokens") {
    console.warn(`[claude vision] response truncated at max_tokens=${opts.maxTokens ?? 1024}`);
  }
  return res.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}
