import { spawnSync } from "node:child_process";

const readiness = { WALSHKEN_TEST_READINESS: "1", WALSHKEN_TEST_EMPLOYMENT: "1" };
const enterprise = { ...readiness, WALSHKEN_TEST_ENTERPRISE: "1", WALSHKEN_TEST_ENTERPRISE_ONLY: "1" };
const suites = {
  "public-seo": ["tests/verify-public-seo.mjs"],
  staff: ["tests/verify-staff.mjs"],
  notifications: ["tests/verify-staff.mjs", { WALSHKEN_TEST_NOTIFICATIONS: "1" }],
  messages: ["tests/verify-messages.mjs"],
  calls: ["tests/verify-livekit.mjs"],
  documents: ["tests/verify-documents.mjs"],
  tasks: ["tests/verify-tasks.mjs"],
  workforce: ["tests/verify-workforce.mjs"],
  payroll: ["tests/verify-payroll.mjs"],
  holidays: ["tests/verify-holidays.mjs"],
  employment: ["tests/verify-holidays.mjs", readiness],
  "country-payroll": ["tests/verify-country-payroll.mjs"],
  enterprise: ["tests/verify-holidays.mjs", enterprise],
  completion: ["tests/verify-holidays.mjs", { ...enterprise, WALSHKEN_TEST_SOURCE: "1" }],
};

const requested = process.argv.slice(2);
// Completion includes the enterprise suite; run it once in the aggregate gate.
const selected = requested.length ? requested : Object.keys(suites).filter(name => name !== "enterprise");
if (selected.some(name => !Object.hasOwn(suites, name))) {
  console.error(`Unknown test suite. Available suites: ${Object.keys(suites).join(", ")}`);
  process.exit(1);
}

// Tests create disposable PGlite databases and their own random credentials.
// Never let a developer's or deployment's live connection leak into a fixture.
const runtimeKeys = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
  "TZ", "CI", "FORCE_COLOR", "NO_COLOR",
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => runtimeKeys.has(key)));
env.NODE_ENV = "test";

for (const name of selected) {
  const [file, flags = {}] = suites[name];
  console.log(`\nRunning ${name} with isolated test configuration`);
  const result = spawnSync(process.execPath, ["--import", "tsx", file], {
    cwd: process.cwd(), env: { ...env, ...flags }, stdio: "inherit", timeout: 300_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`Test suite failed: ${name}${result.signal ? ` (${result.signal})` : ""}`);
    process.exit(result.status || 1);
  }
}
console.log(`\nPASS ${selected.length} isolated test suites`);
