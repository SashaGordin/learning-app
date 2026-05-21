// Thin wrapper around the Anthropic Messages API with built-in web_search tool.
// Returns the final assistant text after all tool calls resolve.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-7";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Run a prompt that may use the web_search tool. The SDK auto-handles
 * server-side tool execution for web_search.
 * @param {string} prompt — user prompt
 * @param {object} opts — { maxTokens, temperature, system }
 * @returns {Promise<string>} concatenated text from the assistant
 */
export async function ask(prompt, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxSearches ?? 10 }],
    messages: [{ role: "user", content: prompt }],
  });
  // Concatenate text blocks. The web_search tool runs server-side so the final
  // response contains the synthesized answer directly.
  return res.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}
