// In-container scheduler. Uses node-cron so jobs see container env vars (no
// busybox crond env-var dance required).

import cron from "node-cron";
import { spawn } from "node:child_process";

const TZ = process.env.TZ || "America/New_York";

function run(script) {
  const t0 = Date.now();
  console.log(`[scheduler] ${new Date().toISOString()} running ${script}`);
  const proc = spawn("node", [script], { stdio: "inherit", env: process.env });
  proc.on("exit", code => {
    console.log(`[scheduler] ${script} exited ${code} in ${Math.round((Date.now()-t0)/1000)}s`);
  });
  proc.on("error", err => console.error(`[scheduler] ${script} error`, err));
}

// Weekday mornings, 6:30 AM in TZ
cron.schedule("30 6 * * 1-5", () => run("daily_brief.js"), { timezone: TZ });

// Sunday 5:00 PM — weekly deep brief
cron.schedule("0 17 * * 0", () => run("weekly_brief.js"), { timezone: TZ });

// Sunday 8:00 PM — backlog curator
cron.schedule("0 20 * * 0", () => run("curator.js"), { timezone: TZ });

console.log(`[scheduler] started (TZ=${TZ})`);
console.log("[scheduler] next daily at 6:30 weekday mornings");
console.log("[scheduler] next weekly at 5:00 PM Sunday");
console.log("[scheduler] next curator at 8:00 PM Sunday");

// Keep the process alive
setInterval(() => {}, 1 << 30);
