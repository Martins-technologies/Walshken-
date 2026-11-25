import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const checks = [
  { name: "production public pages", env: { VERCEL_ENV: "production", WALSHKEN_SITE_URL: "https://www.walshken.com", WALSHKEN_INDEX_PUBLIC: "1" }, index: true },
  { name: "production canonical default", env: { VERCEL_ENV: "production", WALSHKEN_INDEX_PUBLIC: "1" }, index: true },
  { name: "preview stays private", env: { VERCEL_ENV: "preview", WALSHKEN_INDEX_PUBLIC: "1" }, index: false },
  { name: "indexing needs explicit enablement", env: { VERCEL_ENV: "production" }, index: false },
  { name: "invalid configured origin stays private", env: { VERCEL_ENV: "production", WALSHKEN_SITE_URL: "http://localhost:3000", WALSHKEN_INDEX_PUBLIC: "1" }, index: false },
];

for (const check of checks) {
  const env = { ...process.env, NODE_ENV: "production" };
  for (const key of ["VERCEL_ENV", "VERCEL_URL", "WALSHKEN_SITE_URL", "WALSHKEN_INDEX_PUBLIC"]) delete env[key];
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { indexingEnabled, publicMetadata } from "./lib/walshken/seo.ts";
    import robots from "./app/robots.ts";
    import sitemap from "./app/sitemap.ts";
    const index = ${JSON.stringify(check.index)};
    assert.equal(indexingEnabled, index);
    assert.equal(publicMetadata("/about", "About Walshken", "Company overview").robots.index, index);
    assert.equal(publicMetadata("/countries/CA", "Canada", "Coming soon", false).robots.index, false);
    const directives = robots();
    const entries = await sitemap();
    if (index) {
      assert.equal(publicMetadata("/", "Walshken", "Professional services").alternates.canonical.href, "https://www.walshken.com/");
      assert.equal(directives.sitemap, "https://www.walshken.com/sitemap.xml");
      for (const path of ["/staff", "/preview", "/customer", "/api"]) assert.ok(directives.rules.disallow.includes(path));
      assert.ok(entries.some(entry => entry.url === "https://www.walshken.com/"));
      assert.ok(entries.every(entry => !/\\/(staff|customer|api|preview)(\\/|$)/.test(new URL(entry.url).pathname)));
      assert.ok(!entries.some(entry => /\\/countries\\//.test(new URL(entry.url).pathname)), "Unpublished markets must stay outside the sitemap");
    } else {
      assert.equal(directives.rules.disallow, "/");
      assert.deepEqual(entries, []);
    }
  `], { env: { ...env, ...check.env }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${check.name}: ${result.stderr || result.error || "check failed"}`);
  console.log(`PASS ${check.name}`);
}
