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
// the daily brief at 6:30 picks it up. Fast (no web search), but giving it
// a 5-min head start avoids a race where the brief runs before it finishes.
cron.schedule("25 6 * * 1-5", () => run("memory.js"), { timezone: TZ });

// Weekday mornings, 6:30 AM in TZ
cron.schedule("30 6 * * 1-5", () => run("daily_brief.js"), { timezone: TZ });

// Sunday 5:00 PM — weekly deep brief
cron.schedule("0 17 * * 0", () => run("weekly_brief.js"), { timezone: TZ });

// Sunday 8:00 PM — backlog curator
cron.schedule("0 20 * * 0", () => run("curator.js"), { timezone: TZ });

console.log(`[scheduler] started (TZ=${TZ})`);
console.log("[scheduler] next memory at 6:25 weekday mornings");
console.log("[scheduler] next daily at 6:30 weekday mornings");
console.log("[scheduler] next weekly at 5:00 PM Sunday");
console.log("[scheduler] next curator at 8:00 PM Sunday");

// Keep the process alive
setInterval(() => {}, 1 << 30);
