// In-container scheduler. Uses node-cron so jobs see container env vars (no
// busybox crond env-var dance required).

import cron from "node-cron";
import { spawn } from "node:child_process";
import { sendEmail } from "./lib/email.js";

const TZ = process.env.TZ || "America/New_York";

async function notifyFailure(script, code) {
  try {
    await sendEmail({
      subject: `[learning-app] ${script} failed (exit ${code})`,
      markdown: `\`${script}\` exited with code **${code}** at ${new Date().toISOString()}.\n\nRun \`docker compose logs cron\` for details.`,
    });
  } catch (e) {
    console.error(`[scheduler] failed to send failure email for ${script}:`, e?.message || e);
  }
}

function run(script) {
  const t0 = Date.now();
  console.log(`[scheduler] ${new Date().toISOString()} running ${script}`);
  const proc = spawn("node", [script], { stdio: "inherit", env: process.env });
  proc.on("exit", code => {
    console.log(`[scheduler] ${script} exited ${code} in ${Math.round((Date.now()-t0)/1000)}s`);
    if (code !== 0) notifyFailure(script, code);
  });
  proc.on("error", err => {
    console.error(`[scheduler] ${script} error`, err);
    notifyFailure(script, `spawn-error: ${err?.message || err}`);
  });
}

// 6:25 AM weekdays — spaced-recall job. Writes pendingMemory to state so
// the PWA Memory card picks it up. Fast (no web search).
cron.schedule("25 6 * * 1-5", () => run("memory.js"), { timezone: TZ });

// Every 2 minutes — grade explanations submitted from the PWA. Exits without
// an API call when there is no pending response.
cron.schedule("*/2 * * * *", () => run("grade_memory.js"), { timezone: TZ });

// Sunday 8:00 PM — backlog curator
cron.schedule("0 20 * * 0", () => run("curator.js"), { timezone: TZ });

console.log(`[scheduler] started (TZ=${TZ})`);
console.log("[scheduler] next memory at 6:25 weekday mornings");
console.log("[scheduler] memory grading checks every 2 minutes");
console.log("[scheduler] next curator at 8:00 PM Sunday");

// Keep the process alive
setInterval(() => {}, 1 << 30);
