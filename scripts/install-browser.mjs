import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cliPath = resolve("node_modules/playwright/cli.js");
const result = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
  stdio: "inherit",
});

if (result.error) {
  console.error("Could not start the Playwright browser installer.");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
