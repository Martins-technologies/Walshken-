import { spawnSync } from "node:child_process";

if (process.env.VERCEL_ENV === "production") {
  console.log("Running the isolated regression gate before the production build.");
  const result = spawnSync(process.execPath, ["scripts/verify-tests.mjs"], {
    stdio: "inherit", timeout: 1_200_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error("Production build blocked: regression gate did not pass.");
    process.exit(result.status || 1);
  }
}
