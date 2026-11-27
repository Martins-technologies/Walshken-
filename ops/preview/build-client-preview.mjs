import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const schema = "walshken_client_qa";
const runtime = schema + "_runtime";
const firstFeatureMigration = "20261127090000";
const excluded = "20261123181740_staff_e_to_i_production.sql";
const retiredRoles = ["walshken_preview_app", "walshken_production_app", "walshken_review_app", "walshken_role_qa_runtime"];
const inertRoles = retiredRoles.map((_, index) => schema + "_unused_legacy_" + index);

async function migrations(directory) {
  return (await readdir(resolve(repository, directory))).filter(name => /^\d+[a-z_\d]+\.sql$/i.test(name)).sort();
}

function scopeMigration(sql, name) {
  const scoped = sql
    .replace(/(?:\bpublic\b|"public")(?=\s*\.)/gi, schema)
    .replace(/(\bsearch_path\s*(?:=|TO)\s*)(?:pg_catalog\s*,\s*)?(?:"public"|public\b)/gi, "$1" + schema + ",pg_catalog")
    .replace(new RegExp("\\b(" + retiredRoles.join("|") + ")\\b", "g"), role => inertRoles[retiredRoles.indexOf(role)]);
  if (/\b(?:public|"public"|auth|storage|net|cron|walshken_private)\s*\./i.test(scoped)
      || /\b(?:CREATE|ALTER|DROP)\s+(?:SCHEMA|EXTENSION|ROLE|USER|DATABASE)\b/i.test(scoped)
      || /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;\s*$/mi.test(scoped)) {
    throw new Error("Unscoped or server-wide operation in " + name);
  }
  return scoped;
}

const guardRole = `
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${runtime}') THEN
    RAISE EXCEPTION 'Create the restricted client QA role before applying this stage';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${runtime}' AND
    (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = '${runtime}'::regrole)
    OR EXISTS (SELECT FROM pg_roles WHERE rolname IN (${inertRoles.map(role => "'" + role + "'").join(",")}))
    OR EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m') AND n.nspname IN ('public','auth','storage','walshken_role_qa')
        AND has_table_privilege('${runtime}',c.oid,'SELECT,INSERT,UPDATE,DELETE')
    ) THEN
    RAISE EXCEPTION 'The client QA runtime role has unsafe existing privileges';
  END IF;
`;

const startBaseline = `
DO $client_qa_create_role$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = '${schema}') THEN
    RAISE EXCEPTION 'Client QA schema already exists';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${runtime}') THEN
    CREATE ROLE ${runtime} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
${guardRole}
END
$client_qa_create_role$;
CREATE SCHEMA ${schema};
SET LOCAL search_path TO ${schema}, pg_catalog;
CREATE TABLE client_preview_migration_ledger (name text PRIMARY KEY);
REVOKE ALL ON client_preview_migration_ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${runtime};
DO $client_qa_login_path$
BEGIN
  EXECUTE format('ALTER ROLE ${runtime} IN DATABASE %I SET search_path TO ${schema}, pg_catalog', current_database());
END
$client_qa_login_path$;
`;

function startFeature(baselineNames) {
  return `
SET LOCAL search_path TO ${schema}, pg_catalog;
DO $client_qa_check_baseline$
BEGIN
${guardRole}
  IF current_schema() <> '${schema}' OR to_regclass('${schema}.client_preview_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'Client QA baseline is unavailable';
  END IF;
  IF EXISTS (
    SELECT wanted.name
    FROM (VALUES ${baselineNames.map(name => "('" + name + "')").join(",")}) AS wanted(name)
    WHERE NOT EXISTS (SELECT FROM ${schema}.client_preview_migration_ledger installed WHERE installed.name = wanted.name)
  ) THEN
    RAISE EXCEPTION 'Client QA baseline migrations are incomplete';
  END IF;
END
$client_qa_check_baseline$;
`;
}

const grants = `
-- This private QA role is the server login. Browser-facing roles never receive schema or table access.
DO $client_qa_runtime_grants$
DECLARE
  relation record;
  browser_role text;
  privileges text;
  expression text;
BEGIN
  IF current_schema() <> '${schema}' THEN
    RAISE EXCEPTION 'Wrong client QA runtime grant scope';
  END IF;
  REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role',${retiredRoles.map(role => "'" + role + "'").join(",")}] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = browser_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ${schema} FROM %I',browser_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM %I',browser_role);
    END IF;
  END LOOP;
  REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;

  FOR relation IN
    SELECT c.relname, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relkind IN ('r','p') AND c.relname <> 'client_preview_migration_ledger'
    ORDER BY c.relname
  LOOP
    IF EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = relation.oid AND p.polname = 'client_qa_runtime_scope') THEN
      CONTINUE;
    END IF;
    expression := 'true';
    IF EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = relation.oid AND a.attname = 'org_id' AND NOT a.attisdropped) THEN
      expression := 'org_id = ''walshken''';
    ELSIF relation.relname = 'organizations' THEN
      expression := 'id = ''walshken''';
    END IF;

    -- Staff tables retain their normal workflows in this isolated dataset. The client
    -- tables grant only used actions; triggers still enforce their state transitions.
    privileges := CASE
      WHEN relation.relname IN ('client_profile_history','client_security_events','client_case_notes','client_case_messages',
        'client_case_events','client_privacy_policies','client_case_legal_holds','client_case_hold_releases',
        'client_consent_records','client_privacy_decisions','client_document_events','client_document_policies','client_document_versions',
        'client_finance_activity','client_payment_events','client_agreement_responses','client_agreements','client_call_provider_events')
        THEN 'SELECT,INSERT'
      WHEN relation.relname='client_case_assignments' THEN 'SELECT,INSERT,UPDATE (ended_at,ended_by)'
      WHEN relation.relname='client_case_updates' THEN 'SELECT,INSERT,UPDATE (decision,decided_by,decided_at,review_note)'
      WHEN relation.relname='client_documents' THEN 'SELECT,INSERT,UPDATE (review_status,updated_at,deleted_at)'
      WHEN relation.relname='client_document_holds' THEN 'SELECT,INSERT,UPDATE (released_by,release_reason,released_at)'
      WHEN relation.relname='client_document_disposals' THEN 'SELECT,INSERT,UPDATE (status,reviewed_by,reviewed_at,review_reason,disposed_at)'
      WHEN relation.relname IN ('client_preview_document_objects','client_upload_pending_objects','client_invoice_items')
        THEN 'SELECT,INSERT,DELETE'
      WHEN left(relation.relname,7)='client_' THEN 'SELECT,INSERT,UPDATE'
      ELSE 'SELECT,INSERT,UPDATE,DELETE'
    END;
    EXECUTE format('ALTER TABLE ${schema}.%I ENABLE ROW LEVEL SECURITY',relation.relname);
    EXECUTE format('GRANT %s ON TABLE ${schema}.%I TO ${runtime}',privileges,relation.relname);
    EXECUTE format('CREATE POLICY client_qa_runtime_scope ON ${schema}.%I FOR ALL TO ${runtime} USING (%s) WITH CHECK (%s)',
      relation.relname,expression,expression);
  END LOOP;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime};
  IF to_regprocedure('${schema}.walshken_source_disposal_allowed(text,jsonb,jsonb)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ${schema}.walshken_source_disposal_allowed(text,jsonb,jsonb) TO ${runtime};
  END IF;
END
$client_qa_runtime_grants$;
`;


const customerIsolation = `
-- A customer route sets this per transaction on the shared server connection.
-- Staff, system and unauthenticated identity actions continue to use app-side authorization.
DO $client_qa_customer_policies$
DECLARE
  relation record;
  identity_expression text := 'NULLIF(current_setting(''walshken.client_customer_id'',true),'''')';
  check_expression text;
  case_scope text;
  relation_name text;
BEGIN
  IF current_schema() <> '${schema}' THEN RAISE EXCEPTION 'Wrong customer RLS scope'; END IF;
  FOR relation IN
    SELECT c.relname,
      EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='customer_id' AND NOT a.attisdropped) owns_customer,
      EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='case_id' AND NOT a.attisdropped) owns_case
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${schema}' AND c.relkind IN ('r','p')
      AND (c.relname IN ('customers','customer_sessions') OR left(c.relname,7)='client_')
  LOOP
    relation_name := format('%I',relation.relname);
    check_expression := NULL;
    case_scope := format('EXISTS (SELECT 1 FROM ${schema}.client_cases owned
      WHERE owned.id=%s.case_id AND owned.org_id=%s.org_id AND owned.customer_id=%s)',relation_name,relation_name,identity_expression);
    IF relation.relname = 'customers' THEN
      check_expression := 'id=' || identity_expression;
    ELSIF relation.relname IN ('client_case_notes','client_case_assignments','client_privacy_decisions','client_call_provider_events') THEN
      check_expression := 'false';
    ELSIF relation.relname = 'client_invoices' THEN
      check_expression := 'customer_id=' || identity_expression || ' AND status<>''Draft''';
    ELSIF relation.relname = 'client_case_legal_holds' THEN
      -- Organization holds and their guarded release rows must still block case activity.
      check_expression := '(customer_id=' || identity_expression || ' OR (customer_id IS NULL AND case_id IS NULL) OR ' || case_scope || ')';
    ELSIF relation.relname = 'client_case_messages' OR relation.relname = 'client_case_events' THEN
      -- Company replies and case-level events carry case ownership rather than an author customer ID.
      check_expression := '(customer_id=' || identity_expression || ' OR (customer_id IS NULL AND ' || case_scope || '))';
    ELSIF relation.owns_customer THEN
      check_expression := 'customer_id=' || identity_expression;
    ELSIF relation.owns_case THEN
      check_expression := case_scope;
      IF relation.relname='client_case_updates' THEN check_expression := '(' || check_expression || ' AND decision=''Published'')'; END IF;
    ELSIF relation.relname IN ('client_invoice_items','client_payments') THEN
      check_expression := format('EXISTS (SELECT 1 FROM ${schema}.client_invoices bill
        WHERE bill.id=%s.invoice_id AND bill.org_id=%s.org_id AND bill.customer_id=%s)',relation_name,relation_name,identity_expression);
    ELSIF relation.relname='client_agreement_versions' THEN
      check_expression := format('published_at IS NOT NULL AND EXISTS (SELECT 1 FROM ${schema}.client_agreements agreement
        WHERE agreement.id=%s.agreement_id AND agreement.org_id=%s.org_id AND agreement.customer_id=%s)',relation_name,relation_name,identity_expression);
    ELSIF relation.relname='client_case_hold_releases' THEN
      check_expression := 'EXISTS (SELECT 1 FROM ${schema}.client_case_legal_holds owned_hold WHERE owned_hold.id=client_case_hold_releases.hold_id)';
    ELSIF relation.relname IN ('client_payment_events','client_invoice_sequences') THEN
      check_expression := 'false';
    END IF;
    IF check_expression IS NOT NULL THEN
      check_expression := '(' || identity_expression || ' IS NULL OR (' || check_expression || '))';
      EXECUTE format('CREATE POLICY client_qa_customer_scope ON ${schema}.%I AS RESTRICTIVE FOR ALL TO ${runtime} USING (%s) WITH CHECK (%s)',
        relation.relname,check_expression,check_expression);
    END IF;
  END LOOP;
END
$client_qa_customer_policies$;
`;

export async function buildPreviewSql(mode) {
  if (!["baseline", "feature"].includes(mode)) throw new Error("Choose baseline or feature");
  const drizzle = await migrations("drizzle");
  const supabase = (await migrations("supabase/migrations")).filter(name => name !== excluded);
  const baseline = supabase.filter(name => name < firstFeatureMigration);
  const feature = supabase.filter(name => name >= firstFeatureMigration);
  if (mode === "feature" && !feature.length) throw new Error("The client portal migrations are unavailable");
  const output = ["-- Client Portal Preview only. No production records or provider credentials.", "BEGIN;",
    mode === "baseline" ? startBaseline : startFeature([...drizzle, ...baseline])];
  const append = async (directory, file) => {
    const path = directory + "/" + file;
    const sql = scopeMigration(await readFile(resolve(repository, path), "utf8"), path);
    output.push("-- " + path, sql,
      "INSERT INTO " + schema + ".client_preview_migration_ledger (name) VALUES ('" + file + "');");
  };
  if (mode === "baseline") {
    for (const file of drizzle) await append("drizzle", file);
    output.push("INSERT INTO " + schema + ".organizations (id,name,time_zone) VALUES ('walshken','Walshken','UTC') ON CONFLICT (id) DO NOTHING;");
  }
  for (const file of mode === "baseline" ? baseline : feature) await append("supabase/migrations", file);
  output.push(grants);
  if (mode === "feature") output.push(customerIsolation);
  output.push("COMMIT;");
  return output.join("\n") + "\n";
}

export async function verifyPreviewSql() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE ROLE walshken_preview_app; CREATE ROLE walshken_production_app; CREATE ROLE walshken_review_app; CREATE ROLE walshken_role_qa_runtime;
CREATE TABLE public.employees (id text PRIMARY KEY);
INSERT INTO public.employees VALUES ('sentinel');
CREATE SCHEMA storage;
CREATE TABLE storage.objects (id text PRIMARY KEY);
INSERT INTO storage.objects VALUES ('sentinel');
`);
    const baseline = await buildPreviewSql("baseline");
    const feature = await buildPreviewSql("feature");
    await db.exec(baseline);
    await db.exec(feature);
    const { rows: [{ private: allClientTablesPrivate, count }] } = await db.query(`
      SELECT count(*)::integer count, bool_and(relrowsecurity
        AND NOT has_table_privilege('anon',c.oid,'SELECT')
        AND NOT has_table_privilege('authenticated',c.oid,'SELECT')
        AND NOT has_table_privilege('walshken_production_app',c.oid,'SELECT')
        AND has_table_privilege('${runtime}',c.oid,'SELECT')) private
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relname LIKE 'client_%' AND c.relkind='r' AND c.relname<>'client_preview_migration_ledger';
    `);
    assert(count > 10 && allClientTablesPrivate, "The client tables should be present with private, server-only access.");
    await db.exec("SET ROLE " + runtime + "; SET search_path TO " + schema + ",pg_catalog;");
    assert.equal((await db.query("SELECT id FROM organizations")).rows[0].id, "walshken");
    await assert.rejects(db.exec("INSERT INTO organizations (id,name,time_zone) VALUES ('other','Other','UTC')"), /row-level security/);
    await assert.rejects(db.query("SELECT * FROM public.employees"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM storage.objects"), /permission denied/);
    await db.exec(`
      INSERT INTO employees(id,org_id,employee_no,name,email,role) VALUES
        ('fixture-author','walshken','QA-AUTHOR','Fixture author','author@example.test','employee'),
        ('fixture-reviewer','walshken','QA-REVIEW','Fixture reviewer','reviewer@example.test','super_admin');
      INSERT INTO customers(id,name,email,password_hash) VALUES
        ('fixture-a','Client A','a@example.test','not-a-login'), ('fixture-b','Client B','b@example.test','not-a-login');
      INSERT INTO client_cases(id,org_id,customer_id,reference,title,service,country,created_at,client_updated_at,updated_at) VALUES
        ('case-a','walshken','fixture-a','WAL-QA-A','Case A','Consultation','CA','2026-11-27','2026-11-27','2026-11-27'),
        ('case-b','walshken','fixture-b','WAL-QA-B','Case B','Consultation','CA','2026-11-27','2026-11-27','2026-11-27');
      INSERT INTO client_case_updates (id,org_id,case_id,title,body,created_by,created_at) VALUES
        ('published-a','walshken','case-a','Published','Visible', 'fixture-author','2026-11-27'),
        ('pending-a','walshken','case-a','Pending','Private', 'fixture-author','2026-11-27'),
        ('published-b','walshken','case-b','Published','Visible', 'fixture-author','2026-11-27');
      UPDATE client_case_updates SET decision='Published',decided_by='fixture-reviewer',decided_at='2026-11-27'
        WHERE id IN ('published-a','published-b');
      INSERT INTO client_case_messages (id,org_id,case_id,direction,employee_id,display_name,body,created_at) VALUES
        ('reply-a','walshken','case-a','Company','fixture-author','Support','Reply A','2026-11-27'),
        ('reply-b','walshken','case-b','Company','fixture-author','Support','Reply B','2026-11-27');
      BEGIN;
      SELECT set_config('walshken.client_customer_id','fixture-a',true);
    `);
    assert.deepEqual((await db.query("SELECT id FROM customers")).rows, [{ id: "fixture-a" }]);
    assert.deepEqual((await db.query("SELECT id FROM client_cases")).rows, [{ id: "case-a" }]);
    assert.deepEqual((await db.query("SELECT id FROM client_case_updates")).rows, [{ id: "published-a" }]);
    assert.deepEqual((await db.query("SELECT id FROM client_case_messages")).rows, [{ id: "reply-a" }]);
    await db.exec("COMMIT;");
    assert.equal((await db.query("SELECT id FROM client_cases")).rows.length, 2);

    await db.exec("RESET ROLE;");
    assert.deepEqual((await db.query("SELECT id FROM public.employees UNION ALL SELECT id FROM storage.objects")).rows,
      [{ id: "sentinel" }, { id: "sentinel" }]);
    await assert.rejects(db.exec(baseline), /already exists/);
    await db.exec("ROLLBACK;");
    await assert.rejects(db.exec(feature), /already exists|duplicate key/);
    await db.exec("ROLLBACK;");
    console.log(`PASS Client QA baseline and feature SQL, isolation from existing records, and RLS on ${count} client tables`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === "verify") await verifyPreviewSql();
  else if (mode === "baseline" || mode === "feature") process.stdout.write(await buildPreviewSql(mode));
  else {
    console.error("Usage: node ops/preview/build-client-preview.mjs baseline|feature|verify");
    process.exitCode = 2;
  }
}
