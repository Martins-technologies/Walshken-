// Generates one private, disposable review set. This command never connects to a database.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { passwordHash, passwordMatches } from "../../lib/walshken/passwords.ts";
import { divisions, homepage } from "../../lib/walshken/catalog.ts";
import { decryptSettings, encryptSettings } from "../../lib/walshken/server.ts";
import { buildPreviewSql } from "./build-client-preview.mjs";

const schema = "walshken_client_qa";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const id = () => randomUUID();
const digest = value => createHash("sha256").update(value).digest("hex");
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const row = values => "(" + values.map(value => value == null ? "NULL" : quote(value)).join(",") + ")";
const securePassword = () => randomBytes(24).toString("base64url");

function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, remaining = 0, output = "";
  for (const byte of bytes) {
    remaining = (remaining << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(remaining >>> bits) & 31];
    }
  }
  return output + (bits ? alphabet[(remaining << (5 - bits)) & 31] : "");
}

function insideRepository(path) {
  const offset = relative(repository, path);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith("../"));
}

async function readPrivateKey(path) {
  if (!isAbsolute(path)) throw new Error("Use the absolute path of the private integration key file.");
  path = await realpath(path);
  if (insideRepository(path)) throw new Error("Keep the key file outside the repository.");
  const file = await stat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > 128) throw new Error("Use a private mode-0600 file for the integration key.");
  const key = (await readFile(path,"utf8")).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key,"base64").length !== 32) throw new Error("Enter a 32-byte base64 integration key.");
  return key;
}

async function staffFactor(staff, key) {
  const prior = process.env.WALSHKEN_INTEGRATION_KEY_V2;
  process.env.WALSHKEN_INTEGRATION_KEY_V2 = key;
  try {
    const secret = randomBytes(20);
    const encrypted = await encryptSettings("staff-mfa:" + staff.id, { secret: secret.toString("base64") });
    return {
      encrypted, setupKey: base32(secret), recoveryCodes: Array.from({ length: 8 }, () => randomBytes(12).toString("hex")),
    };
  } finally {
    if (prior === undefined) delete process.env.WALSHKEN_INTEGRATION_KEY_V2;
    else process.env.WALSHKEN_INTEGRATION_KEY_V2 = prior;
  }
}

async function generate(key) {
  const created = new Date().toISOString(), expires = new Date(Date.now() + 48 * 3600_000).toISOString();
  const run = randomBytes(6).toString("hex");
  const entries = [
    { key: "client-a", name: "Preview Client A", role: "client", url: "/customer/sign-in" },
    { key: "client-b", name: "Preview Client B", role: "client", url: "/customer/sign-in" },
    { key: "caseworker", name: "Preview Caseworker", role: "employee", url: "/staff" },
    { key: "super-admin", name: "Preview Administrator", role: "super_admin", url: "/staff" },
  ].map(person => ({
    ...person, id: id(), email: "walshken-" + person.key + "-" + run + "@example.test", password: securePassword(),
  }));
  const [clientA,clientB,worker,admin] = entries;
  const [hashA, hashB] = await Promise.all([passwordHash(clientA.password), passwordHash(clientB.password)]);
  let staffRows = "";
  for (const staff of [worker,admin]) {
    if (key) {
      const factor = await staffFactor(staff, key);
      staff.loginMode = "password and authenticator";
      staff.authenticatorSetupKey = factor.setupKey;
      staff.recoveryCodes = factor.recoveryCodes;
      staffRows += `
INSERT INTO ${schema}.credentials (employee_id,password_hash,updated_at)
  VALUES ${row([staff.id,await passwordHash(staff.password),created])};
INSERT INTO ${schema}.staff_mfa (employee_id,secret,setup_expires_at,confirmed_at,last_step)
  VALUES (${quote(staff.id)},${quote(factor.encrypted)},${quote(created)},${quote(created)},-1);
INSERT INTO ${schema}.staff_recovery_codes (employee_id,code_hash) VALUES
  ${factor.recoveryCodes.map(code=>row([staff.id,digest(code)])).join(",\n  ")};
UPDATE ${schema}.employees SET activated_at=${quote(created)} WHERE id=${quote(staff.id)};
`;
    } else {
      staff.loginMode = "one-time staff activation";
      staff.activationCode = randomBytes(24).toString("base64url");
      staff.activationExpiresAt = expires;
      staffRows += `
INSERT INTO ${schema}.invitations (id,employee_id,code_hash,expires_at)
  VALUES ${row([id(),staff.id,digest(staff.activationCode),expires])};
`;
    }
  }
  const caseA = id(), caseB = id(), department = id();
  clientA.caseId = caseA;
  clientB.caseId = caseB;
  const makeCase = (client, key, caseId, assignee) => row([
    caseId,"walshken",client.id,"PREVIEW-" + run.toUpperCase() + "-" + key,"Client Portal Review · Case " + key,
    "Immigration consultation","CA",assignee?.id,department,
    assignee ? "Walshken Case Team" : "",assignee ? "Caseworker" : "",created,created,created,created,
  ]);
  const sql = `-- Synthetic Client Portal review identities. Apply only to the isolated Preview database schema.
BEGIN;
SET LOCAL search_path TO ${schema},pg_catalog;
DO $check_client_qa_seed$
BEGIN
  IF current_schema() <> '${schema}' OR to_regclass('${schema}.client_preview_migration_ledger') IS NULL
     OR to_regclass('${schema}.client_cases') IS NULL THEN
    RAISE EXCEPTION 'Client QA migrations must be installed before review seeds';
  END IF;
  IF NOT EXISTS (SELECT FROM ${schema}.organizations WHERE id='walshken') THEN
    RAISE EXCEPTION 'Missing Client QA organization';
  END IF;
END
$check_client_qa_seed$;
INSERT INTO ${schema}.site_content (id,title,description,about) VALUES
  ${row(["home",homepage.title,homepage.description,homepage.about])} ON CONFLICT DO NOTHING;
INSERT INTO ${schema}.services (id,name,description,icon,sort) VALUES
  ${divisions.map((entry,index)=>row([entry.id,entry.name,entry.description,entry.icon,index+1])).join(",\n  ")} ON CONFLICT DO NOTHING;
INSERT INTO ${schema}.units (id,org_id,kind,name) VALUES
  ${row([department,"walshken","Department","Client Portal QA " + run])};
INSERT INTO ${schema}.employees (id,org_id,employee_no,name,email,role,title,department_id) VALUES
  ${row([worker.id,"walshken","QA-WORK-"+run,worker.name,worker.email,worker.role,"Caseworker",department])},
  ${row([admin.id,"walshken","QA-ADMIN-"+run,admin.name,admin.email,admin.role,"Preview administrator",department])};
${staffRows}
INSERT INTO ${schema}.customers (id,name,email,password_hash,email_verified_at) VALUES
  ${row([clientA.id,clientA.name,clientA.email,hashA,created])},${row([clientB.id,clientB.name,clientB.email,hashB,created])};
INSERT INTO ${schema}.client_cases
  (id,org_id,customer_id,reference,title,service,country,assigned_employee_id,department_id,representative_name,
  representative_designation,created_at,submitted_at,client_updated_at,updated_at) VALUES
  ${makeCase(clientA,"A",caseA,worker)},${makeCase(clientB,"B",caseB)};
INSERT INTO ${schema}.client_case_assignments (id,org_id,case_id,employee_id,assigned_by,assigned_at) VALUES
  ${row([id(),"walshken",caseA,worker.id,admin.id,created])};
COMMIT;
`;
  return { sql, entries };
}

async function verify() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(await buildPreviewSql("baseline"));
    await db.exec(await buildPreviewSql("feature"));
    const activation = await generate();
    for (const account of activation.entries) {
      assert(!activation.sql.includes(account.password));
      if (account.activationCode) assert(!activation.sql.includes(account.activationCode));
    }
    await db.exec(activation.sql);
    const [clientA,clientB,worker,admin] = activation.entries;
    const { rows: [seeded] } = await db.query(`SELECT * FROM ${schema}.customers WHERE email=$1`, [clientA.email]);
    assert(seeded.email_verified_at && await passwordMatches(clientA.password, seeded.password_hash));
    assert.equal((await db.query(`SELECT customer_id,assigned_employee_id FROM ${schema}.client_cases WHERE id=$1`,[clientA.caseId])).rows[0].assigned_employee_id,worker.id);
    assert.equal((await db.query(`SELECT assigned_employee_id FROM ${schema}.client_cases WHERE id=$1`,[clientB.caseId])).rows[0].assigned_employee_id,null);
    const { rows: [invite] } = await db.query(`SELECT * FROM ${schema}.invitations WHERE employee_id=$1`,[admin.id]);
    assert.equal(invite.code_hash,digest(admin.activationCode));
    assert.equal(invite.consumed_at,null);

    const testKey = randomBytes(32).toString("base64");
    const ready = await generate(testKey);
    await db.exec(ready.sql);
    const readyAdmin = ready.entries[3];
    const { rows: [credential] } = await db.query(`SELECT * FROM ${schema}.credentials WHERE employee_id=$1`,[readyAdmin.id]);
    assert(await passwordMatches(readyAdmin.password,credential.password_hash));
    const { rows: [authenticator] } = await db.query(`SELECT * FROM ${schema}.staff_mfa WHERE employee_id=$1`,[readyAdmin.id]);
    const prior = process.env.WALSHKEN_INTEGRATION_KEY_V2;
    process.env.WALSHKEN_INTEGRATION_KEY_V2 = testKey;
    try {
      const decrypted = await decryptSettings("staff-mfa:" + readyAdmin.id,authenticator.secret);
      assert.equal(base32(Buffer.from(decrypted.secret,"base64")),readyAdmin.authenticatorSetupKey);
    } finally {
      if (prior === undefined) delete process.env.WALSHKEN_INTEGRATION_KEY_V2;
      else process.env.WALSHKEN_INTEGRATION_KEY_V2 = prior;
    }
    assert.equal((await db.query(`SELECT count(*)::integer total FROM ${schema}.staff_recovery_codes WHERE employee_id=$1`,[readyAdmin.id])).rows[0].total,8);
    console.log("PASS isolated Preview role seeds with verified clients, distinct case ownership, one-time staff activation and optional encrypted MFA");
  } finally {
    await db.close();
  }
}

if (process.argv[2] === "verify") await verify();
else if (process.argv[2] === "generate") {
  if (process.argv.length > 3 && (process.argv.length !== 5 || process.argv[3] !== "--mfa-key-file")) {
    throw new Error("Use generate with an optional --mfa-key-file followed by an absolute path.");
  }
  const key = process.argv[4] ? await readPrivateKey(process.argv[4]) : undefined;
  const { sql, entries } = await generate(key);
  const temp = await realpath(tmpdir());
  if (insideRepository(temp)) throw new Error("The private output directory must be outside the worktree.");
  const folder = await mkdtemp(join(temp,"walshken-client-qa-"));
  await chmod(folder,0o700);
  await writeFile(join(folder,"seed.sql"),sql,{mode:0o600,flag:"wx"});
  await writeFile(join(folder,"accounts.json"), JSON.stringify({
    instructions: key ? "Sign in directly. Import the saved staff MFA key into your authenticator or use an unused recovery code." :
      "At /staff, select I have an activation or admin reset code. Use the staff email, activation code and generated password, then sign in and enroll an authenticator when prompted.",
    accounts: entries,
  },null,2),{mode:0o600,flag:"wx"});
  console.log(folder);
} else {
  console.error("Usage: node --import tsx ops/preview/seed-client-preview.mjs verify|generate [--mfa-key-file /absolute/private-file]");
  process.exitCode = 2;
}
