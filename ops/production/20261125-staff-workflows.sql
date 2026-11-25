-- Approved Walshken production release. Target: ssggjxyexwkshtcypsaq/public.
-- Source migrations are copied unchanged from reviewed commit 7475f55.
-- Apply the WHOLE file once through apply_migration, in one transaction.
-- No existing business record, credential, MFA factor, or object is removed here.
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '90s';
DO $preflight$
DECLARE t text;
BEGIN
 IF current_schema()<>'public' THEN RAISE EXCEPTION 'Wrong target schema'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id='walshken') THEN RAISE EXCEPTION 'Walshken organization missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='walshken_production_app' AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'Unsafe or missing production runtime'; END IF;
 IF has_schema_privilege('walshken_production_app','walshken_role_qa','USAGE') OR has_table_privilege('walshken_role_qa_runtime','public.employees','SELECT') THEN RAISE EXCEPTION 'QA and production isolation changed'; END IF;
 FOREACH t IN ARRAY ARRAY['staff_action_permissions','staff_security_events','staff_privacy_notices','staff_privacy_acknowledgements','staff_reporting_reviews','staff_jurisdiction_versions','staff_jurisdiction_decisions','staff_work_policy_versions','employment_countries','employment_regions','staff_employment_terms','staff_upload_scans','staff_upload_scan_events','staff_leave_adjustments','staff_leave_adjustment_reviews','staff_retention_versions','staff_retention_reviews','staff_legal_holds','staff_legal_hold_releases','staff_statutory_inputs','staff_statutory_input_reviews','staff_contribution_ledger','staff_country_holiday_allocations','staff_privacy_requests','staff_privacy_request_events','staff_privacy_cleanup','staff_source_disposals','staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_source_disposal_objects','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN RAISE EXCEPTION 'Migration already/partly applied: %',t; END IF;
 END LOOP;
END;
$preflight$;

-- BEGIN reviewed dependency 20261124192707_staff_readiness.sql
CREATE TABLE staff_action_permissions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  principal_type text NOT NULL CHECK (principal_type IN ('employee','role')),
  principal_id text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('organization','division','department','employee')),
  scope_id text NOT NULL,
  action text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  UNIQUE (org_id, principal_type, principal_id, scope_type, scope_id, action)
);
CREATE INDEX staff_permissions_lookup ON staff_action_permissions(org_id,principal_type,principal_id,action);

CREATE TABLE staff_security_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  employee_id text REFERENCES employees(id),
  fingerprint text NOT NULL,
  action text NOT NULL CHECK (action IN ('Sign-in failed','Sign-in rate limited','Repeated sign-in failures')),
  created_at text NOT NULL
);
CREATE INDEX staff_security_lookup ON staff_security_events(org_id,fingerprint,created_at);
CREATE INDEX staff_security_recent ON staff_security_events(org_id,created_at DESC);

CREATE TABLE staff_privacy_notices (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  title text NOT NULL,
  body text NOT NULL,
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL
);
CREATE INDEX staff_privacy_current ON staff_privacy_notices(org_id,created_at DESC,id DESC);

CREATE TABLE staff_privacy_acknowledgements (
  notice_id text NOT NULL REFERENCES staff_privacy_notices(id),
  employee_id text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  PRIMARY KEY(notice_id,employee_id)
);

CREATE TABLE staff_reporting_reviews (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  attendance_id text NOT NULL REFERENCES attendance(id),
  attendance_revision integer NOT NULL,
  release_stage text NOT NULL CHECK(release_stage IN ('preview','production')),
  classification text NOT NULL CHECK(classification IN ('Required','Voluntary early departure','Employee-requested short work')),
  reason text NOT NULL,
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  UNIQUE(attendance_id, attendance_revision, release_stage, created_at)
);
CREATE INDEX staff_reporting_lookup ON staff_reporting_reviews(org_id,release_stage,attendance_id,attendance_revision,created_at DESC);

DO $migration$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_action_permissions','staff_security_events','staff_privacy_notices','staff_privacy_acknowledgements','staff_reporting_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_security_events','staff_privacy_notices','staff_privacy_acknowledgements','staff_reporting_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation()', t);
  END LOOP;
END;
$migration$;

CREATE TABLE staff_jurisdiction_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  country text NOT NULL CHECK(country IN ('CA', 'IN', 'PK')),
  jurisdiction text NOT NULL,
  classification text NOT NULL,
  version text NOT NULL,
  effective_from text NOT NULL,
  effective_through text NOT NULL,
  source_url text NOT NULL,
  evidence text NOT NULL,
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  CHECK(effective_from <= effective_through),
  CHECK(split_part(jurisdiction, '-', 1) = country),
  UNIQUE(org_id,jurisdiction,classification,version)
);
CREATE INDEX staff_jurisdiction_lookup ON staff_jurisdiction_versions(org_id,jurisdiction,classification,effective_from,effective_through);

CREATE TABLE staff_jurisdiction_decisions (
  id text PRIMARY KEY,
  version_id text NOT NULL REFERENCES staff_jurisdiction_versions(id),
  decision text NOT NULL CHECK(decision IN ('Verified','Withdrawn')),
  reason text NOT NULL,
  actor_id text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL
);
CREATE INDEX staff_jurisdiction_decision_lookup ON staff_jurisdiction_decisions(version_id,created_at DESC,id DESC);

ALTER TABLE staff_jurisdiction_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_jurisdiction_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_jurisdiction_versions, staff_jurisdiction_decisions FROM PUBLIC;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_jurisdiction_versions
FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_jurisdiction_decisions
FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();

CREATE TABLE staff_work_policy_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  employee_id text NOT NULL REFERENCES employees(id),
  release_stage text NOT NULL CHECK(release_stage IN ('preview','production')),
  effective_on text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  settings text NOT NULL,
  created_by text NOT NULL REFERENCES employees(id),
  created_at text NOT NULL,
  UNIQUE(employee_id,release_stage,revision)
);
CREATE INDEX staff_work_policy_lookup ON staff_work_policy_versions(employee_id,release_stage,effective_on DESC,revision DESC);
ALTER TABLE staff_work_policy_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_work_policy_versions FROM PUBLIC;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_work_policy_versions
FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();

-- END 20261124192707_staff_readiness.sql


-- BEGIN reviewed dependency 20261124211828_dynamic_employment_engine.sql
CREATE TABLE employment_countries (
 org_id text NOT NULL REFERENCES organizations(id), code text NOT NULL CHECK(code IN ('CA','IN','PK')),
 name text NOT NULL, currency text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, updated_by text REFERENCES employees(id), updated_at text NOT NULL,
 PRIMARY KEY(org_id,code)
);
CREATE TABLE employment_regions (
 org_id text NOT NULL, code text NOT NULL, country text NOT NULL, name text NOT NULL, kind text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 updated_by text REFERENCES employees(id), updated_at text NOT NULL,
 PRIMARY KEY(org_id,code), FOREIGN KEY(org_id,country) REFERENCES employment_countries(org_id,code),
 CHECK(split_part(code,'-',1)=country)
);
ALTER TABLE staff_jurisdiction_versions ADD COLUMN category text NOT NULL DEFAULT 'Evidence'
 CHECK(category IN ('Work','Overtime','Holiday calendar','Leave','Canada Alberta payroll','Evidence'));
ALTER TABLE staff_jurisdiction_versions ADD COLUMN settings text;
ALTER TABLE staff_jurisdiction_versions ADD COLUMN settings_hash text;
ALTER TABLE staff_jurisdiction_versions ADD COLUMN mandatory boolean NOT NULL DEFAULT false;
ALTER TABLE staff_jurisdiction_versions ADD COLUMN predecessor_id text REFERENCES staff_jurisdiction_versions(id);
ALTER TABLE staff_jurisdiction_versions ADD CONSTRAINT policy_settings_integrity CHECK(
 (category='Evidence' AND settings IS NULL AND settings_hash IS NULL) OR
 (category<>'Evidence' AND settings IS NOT NULL AND settings_hash IS NOT NULL)
);
CREATE INDEX employment_policy_lookup ON staff_jurisdiction_versions(org_id,jurisdiction,classification,category,effective_from,effective_through);
CREATE TABLE staff_employment_terms (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 effective_on text NOT NULL, country text NOT NULL, region_code text NOT NULL, jurisdiction text NOT NULL,
 classification text NOT NULL, city text NOT NULL, office_id text REFERENCES units(id), time_zone text NOT NULL,
 employment_type text NOT NULL CHECK(employment_type IN ('Full-time','Part-time','Fixed-term','Contractor')),
 category text NOT NULL, compensation_type text NOT NULL CHECK(compensation_type IN ('Hourly','Salaried','Contract fee')),
 currency text NOT NULL, frequency text NOT NULL CHECK(frequency IN ('Weekly','Biweekly','Semimonthly','Monthly')),
 expected_hours integer NOT NULL CHECK(expected_hours BETWEEN 0 AND 80), schedule text NOT NULL,
 reference text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL,
 UNIQUE(employee_id,effective_on), FOREIGN KEY(org_id,country) REFERENCES employment_countries(org_id,code),
 FOREIGN KEY(org_id,region_code) REFERENCES employment_regions(org_id,code),
 FOREIGN KEY(org_id,jurisdiction) REFERENCES employment_regions(org_id,code),
 CHECK(split_part(region_code,'-',1)=country AND split_part(jurisdiction,'-',1)=country)
);
CREATE INDEX staff_terms_current ON staff_employment_terms(org_id,employee_id,effective_on DESC);
DO $migration$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['employment_countries','employment_regions','staff_employment_terms'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END;
$migration$;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_employment_terms
 FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();

INSERT INTO employment_countries(org_id,code,name,currency,updated_at)
SELECT o.id,v.code,v.name,v.currency,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM organizations o CROSS JOIN (VALUES ('CA','Canada','CAD'),('IN','India','INR'),('PK','Pakistan','PKR')) v(code,name,currency);
INSERT INTO employment_regions(org_id,code,country,name,kind,updated_at)
SELECT o.id,v.code,v.country,v.name,v.kind,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM organizations o CROSS JOIN (VALUES
('CA-AB','CA','Alberta','Province'),
('CA-BC','CA','British Columbia','Province'),
('CA-MB','CA','Manitoba','Province'),
('CA-NB','CA','New Brunswick','Province'),
('CA-NL','CA','Newfoundland and Labrador','Province'),
('CA-NS','CA','Nova Scotia','Province'),
('CA-ON','CA','Ontario','Province'),
('CA-PE','CA','Prince Edward Island','Province'),
('CA-QC','CA','Quebec','Province'),
('CA-SK','CA','Saskatchewan','Province'),
('CA-NT','CA','Northwest Territories','Territory'),
('CA-NU','CA','Nunavut','Territory'),
('CA-YT','CA','Yukon','Territory'),
('CA-FED','CA','Federal employment jurisdiction','Federal'),
('IN-AP','IN','Andhra Pradesh','State'),
('IN-AR','IN','Arunachal Pradesh','State'),
('IN-AS','IN','Assam','State'),
('IN-BR','IN','Bihar','State'),
('IN-CT','IN','Chhattisgarh','State'),
('IN-GA','IN','Goa','State'),
('IN-GJ','IN','Gujarat','State'),
('IN-HR','IN','Haryana','State'),
('IN-HP','IN','Himachal Pradesh','State'),
('IN-JH','IN','Jharkhand','State'),
('IN-KA','IN','Karnataka','State'),
('IN-KL','IN','Kerala','State'),
('IN-MP','IN','Madhya Pradesh','State'),
('IN-MH','IN','Maharashtra','State'),
('IN-MN','IN','Manipur','State'),
('IN-ML','IN','Meghalaya','State'),
('IN-MZ','IN','Mizoram','State'),
('IN-NL','IN','Nagaland','State'),
('IN-OD','IN','Odisha','State'),
('IN-PB','IN','Punjab','State'),
('IN-RJ','IN','Rajasthan','State'),
('IN-SK','IN','Sikkim','State'),
('IN-TN','IN','Tamil Nadu','State'),
('IN-TS','IN','Telangana','State'),
('IN-TR','IN','Tripura','State'),
('IN-UP','IN','Uttar Pradesh','State'),
('IN-UK','IN','Uttarakhand','State'),
('IN-WB','IN','West Bengal','State'),
('IN-AN','IN','Andaman and Nicobar Islands','Union territory'),
('IN-CH','IN','Chandigarh','Union territory'),
('IN-DH','IN','Dadra and Nagar Haveli and Daman and Diu','Union territory'),
('IN-DL','IN','Delhi','Union territory'),
('IN-JK','IN','Jammu and Kashmir','Union territory'),
('IN-LA','IN','Ladakh','Union territory'),
('IN-LD','IN','Lakshadweep','Union territory'),
('IN-PY','IN','Puducherry','Union territory'),
('IN-CENTRAL','IN','Central employment jurisdiction','Federal'),
('PK-PB','PK','Punjab','Province'),
('PK-SD','PK','Sindh','Province'),
('PK-KP','PK','Khyber Pakhtunkhwa','Province'),
('PK-BA','PK','Balochistan','Province'),
('PK-IS','PK','Islamabad Capital Territory','Capital territory'),
('PK-GB','PK','Gilgit-Baltistan','Territory'),
('PK-JK','PK','Azad Jammu and Kashmir','Territory'),
('PK-FED','PK','Federal employment jurisdiction','Federal')
) v(code,country,name,kind);

CREATE TABLE staff_upload_scans (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 sha256 text NOT NULL, file_name text NOT NULL, storage_key text, created_at text NOT NULL,
 status text NOT NULL CHECK(status IN ('Pending','Scanning','Clean','Infected','Failed','Quarantined')),
 updated_at text NOT NULL
);
CREATE INDEX staff_upload_scans_recent ON staff_upload_scans(org_id,created_at DESC);
CREATE TABLE staff_upload_scan_events (
 id text PRIMARY KEY, scan_id text NOT NULL REFERENCES staff_upload_scans(id), org_id text NOT NULL REFERENCES organizations(id),
 status text NOT NULL CHECK(status IN ('Pending','Scanning','Clean','Infected','Failed','Quarantined')),
 actor_id text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
ALTER TABLE staff_upload_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_upload_scan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_upload_scans,staff_upload_scan_events FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_upload_scan_events
 FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
ALTER TABLE leave_requests ADD COLUMN entitlement_snapshot text;
ALTER TABLE leave_requests ADD COLUMN requested_minutes integer CHECK(requested_minutes IS NULL OR requested_minutes>=0);
CREATE TABLE staff_leave_adjustments (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 code text NOT NULL, effective_on text NOT NULL, minutes integer NOT NULL, reason text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('Opening balance','Correction','Carry forward')),
 created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
CREATE TABLE staff_leave_adjustment_reviews (
 id text PRIMARY KEY, adjustment_id text NOT NULL UNIQUE REFERENCES staff_leave_adjustments(id),
 decision text NOT NULL CHECK(decision IN ('Approved','Rejected')), reason text NOT NULL,
 actor_id text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
ALTER TABLE staff_leave_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_leave_adjustment_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_leave_adjustments,staff_leave_adjustment_reviews FROM PUBLIC,anon,authenticated;
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_leave_adjustments FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON staff_leave_adjustment_reviews FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation();
ALTER TABLE staff_action_permissions DROP CONSTRAINT staff_action_permissions_scope_type_check;
ALTER TABLE staff_action_permissions ADD CONSTRAINT staff_action_permissions_scope_type_check
 CHECK(scope_type IN ('organization','division','department','employee','country','office'));
CREATE TABLE staff_retention_versions (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), country text NOT NULL CHECK(country IN ('CA','IN','PK')),
 category text NOT NULL, classification text NOT NULL, retain_days integer NOT NULL CHECK(retain_days>=0),
 minimum_days integer NOT NULL CHECK(minimum_days>=0 AND retain_days>=minimum_days),
 effective_on text NOT NULL, source_url text NOT NULL, reason text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
CREATE TABLE staff_retention_reviews (
 id text PRIMARY KEY, version_id text NOT NULL UNIQUE REFERENCES staff_retention_versions(id),
 decision text NOT NULL CHECK(decision IN ('Approved','Rejected')), actor_id text NOT NULL REFERENCES employees(id), reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_legal_holds (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), scope_type text NOT NULL CHECK(scope_type IN ('organization','employee','document','conversation','payroll period')),
 target_id text NOT NULL, reason text NOT NULL, created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL
);
CREATE TABLE staff_legal_hold_releases (
 hold_id text PRIMARY KEY REFERENCES staff_legal_holds(id), actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
DO $migration$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_retention_versions','staff_retention_reviews','staff_legal_holds','staff_legal_hold_releases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('CREATE TRIGGER protect_staff_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation()',t);
 END LOOP;
END;
$migration$;

-- END 20261124211828_dynamic_employment_engine.sql


-- BEGIN reviewed dependency 20261124223624_enterprise_payroll_privacy_workflows.sql
-- Additive enterprise workflow objects. Apply to isolated review schema first.
ALTER TABLE staff_jurisdiction_versions DROP CONSTRAINT IF EXISTS staff_jurisdiction_versions_category_check;
ALTER TABLE staff_jurisdiction_versions ADD CONSTRAINT staff_jurisdiction_versions_category_check CHECK(category IN ('Work','Overtime','Holiday calendar','Leave','Canada Alberta payroll','Canada payroll','India payroll','Pakistan payroll','Pay standards','Evidence'));

CREATE TABLE staff_statutory_inputs (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 period_id text NOT NULL REFERENCES payroll_periods(id), release_stage text NOT NULL CHECK(release_stage IN ('preview','production')),
 configuration text NOT NULL, configuration_hash text NOT NULL, reference text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL
);
CREATE INDEX staff_statutory_input_employee ON staff_statutory_inputs(org_id,release_stage,employee_id,period_id,created_at DESC,id DESC);
CREATE TABLE staff_statutory_input_reviews (
 id text PRIMARY KEY, input_id text NOT NULL UNIQUE REFERENCES staff_statutory_inputs(id),
 decision text NOT NULL CHECK(decision IN ('Approved','Rejected')), actor_id text NOT NULL REFERENCES employees(id), reason text NOT NULL, created_at text NOT NULL
);
CREATE TABLE staff_contribution_ledger (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 payroll_id text NOT NULL REFERENCES payroll(id), release_stage text NOT NULL CHECK(release_stage IN ('preview','production')),
 tax_year integer NOT NULL, contribution_month text NOT NULL CHECK(contribution_month ~ '^\d{4}-\d{2}$'), code text NOT NULL,
 basis_minor bigint NOT NULL CHECK(basis_minor>=0), employee_minor bigint NOT NULL CHECK(employee_minor>=0), employer_minor bigint NOT NULL CHECK(employer_minor>=0),
 snapshot text NOT NULL, created_at text NOT NULL, UNIQUE(payroll_id,contribution_month,code)
);
CREATE INDEX staff_contribution_month ON staff_contribution_ledger(org_id,release_stage,employee_id,contribution_month,code);
CREATE INDEX staff_contribution_year ON staff_contribution_ledger(org_id,release_stage,employee_id,tax_year,code);

CREATE TABLE staff_country_holiday_allocations (
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),employee_id text NOT NULL REFERENCES employees(id),payroll_id text NOT NULL REFERENCES payroll(id),
 release_stage text NOT NULL,holiday_date text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>=0),snapshot text NOT NULL,created_at text NOT NULL,
 UNIQUE(employee_id,release_stage,holiday_date)
);

CREATE TABLE staff_privacy_requests (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id),
 kind text NOT NULL CHECK(kind IN ('Export','Archive','Restore','Dispose')), category text NOT NULL,
 from_date text NOT NULL, through_date text NOT NULL, reason text NOT NULL, created_by text NOT NULL REFERENCES employees(id), created_at text NOT NULL,
 state text NOT NULL DEFAULT 'Pending' CHECK(state IN ('Pending','Approved','Rejected','Completed','Cancelled')),
 revision integer NOT NULL DEFAULT 1, completed_at text, artifact_key text, artifact_hash text, artifact_expires_at text
);
CREATE INDEX staff_privacy_requests_recent ON staff_privacy_requests(org_id,employee_id,created_at DESC);
CREATE TABLE staff_privacy_request_events (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES staff_privacy_requests(id), org_id text NOT NULL REFERENCES organizations(id),
 action text NOT NULL, actor_id text NOT NULL REFERENCES employees(id), detail text NOT NULL, created_at text NOT NULL
);
CREATE INDEX staff_privacy_events_request ON staff_privacy_request_events(request_id,created_at,id);
CREATE TABLE staff_privacy_cleanup (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), employee_id text NOT NULL REFERENCES employees(id), request_id text NOT NULL REFERENCES staff_privacy_requests(id), storage_key text NOT NULL UNIQUE, created_at text NOT NULL
);
CREATE INDEX staff_privacy_cleanup_due ON staff_privacy_cleanup(org_id,created_at);

DO $migration$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_country_holiday_allocations','staff_statutory_inputs','staff_statutory_input_reviews','staff_contribution_ledger','staff_privacy_request_events'] LOOP
  EXECUTE format('CREATE TRIGGER protect_enterprise_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['staff_country_holiday_allocations','staff_statutory_inputs','staff_statutory_input_reviews','staff_contribution_ledger','staff_privacy_requests','staff_privacy_request_events','staff_privacy_cleanup'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM anon',t);END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated',t);END IF;
 END LOOP;
END;
$migration$;

-- END 20261124223624_enterprise_payroll_privacy_workflows.sql


-- BEGIN reviewed dependency 20261125053842_source_disposal_employer_validation.sql
-- Apply to the isolated review schema first. Original history remains immutable
-- except for a separately approved, exact-hash source-disposal manifest.
CREATE TABLE staff_source_disposals(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),employee_id text NOT NULL REFERENCES employees(id),release_stage text NOT NULL,
 category text NOT NULL,from_date text NOT NULL,through_date text NOT NULL,reason text NOT NULL,
 manifest_time text NOT NULL,manifest_hash text NOT NULL,manifest_count integer NOT NULL CHECK(manifest_count>0),
 state text NOT NULL DEFAULT 'Pending' CHECK(state IN('Pending','Approved','Rejected','Executing','Cleanup pending','Completed','Cancelled')),
 revision integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,
 executed_by text REFERENCES employees(id),executed_at text,completed_at text
);
CREATE INDEX source_disposal_recent ON staff_source_disposals(org_id,release_stage,created_at DESC);
CREATE TABLE staff_source_disposal_items(
 id text PRIMARY KEY,request_id text NOT NULL REFERENCES staff_source_disposals(id),table_name text NOT NULL,record_key jsonb NOT NULL,
 before_hash text NOT NULL,after_hash text,patch jsonb,operation text NOT NULL CHECK(operation IN('Delete','Redact')),
 category text NOT NULL,owner_ids jsonb NOT NULL,countries jsonb NOT NULL,anchor_date text NOT NULL,eligible_after text NOT NULL,
 hold_targets jsonb NOT NULL,summary text NOT NULL,UNIQUE(request_id,table_name,record_key)
);
CREATE TABLE staff_source_disposal_reviews(
 id text PRIMARY KEY,request_id text NOT NULL UNIQUE REFERENCES staff_source_disposals(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_source_disposal_events(
 id text PRIMARY KEY,request_id text NOT NULL REFERENCES staff_source_disposals(id),actor_id text NOT NULL REFERENCES employees(id),action text NOT NULL,detail text NOT NULL,created_at text NOT NULL
);
CREATE INDEX source_disposal_events_request ON staff_source_disposal_events(request_id,created_at,id);
CREATE TABLE staff_source_disposal_objects(
 id text PRIMARY KEY,request_id text NOT NULL REFERENCES staff_source_disposals(id),storage_kind text NOT NULL CHECK(storage_kind IN('Documents','Recordings')),
 storage_id text NOT NULL,storage_key text NOT NULL,storage_location jsonb NOT NULL,attempts integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'Pending' CHECK(status IN('Pending','Deleted')),
 last_error text,deleted_at text,UNIQUE(request_id,storage_kind,storage_id,storage_key)
);
CREATE TABLE staff_employer_versions(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),country text NOT NULL CHECK(country IN('CA','IN','PK')),
 effective_from text NOT NULL,effective_through text NOT NULL,version text NOT NULL,configuration text NOT NULL,configuration_hash text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL,UNIQUE(org_id,country,version)
);
CREATE INDEX employer_version_lookup ON staff_employer_versions(org_id,country,effective_from DESC);
CREATE TABLE staff_employer_decisions(
 id text PRIMARY KEY,version_id text NOT NULL REFERENCES staff_employer_versions(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected','Withdrawn')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_employee_statutory_facts(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),employee_id text NOT NULL REFERENCES employees(id),
 effective_from text NOT NULL,effective_through text NOT NULL,configuration text NOT NULL,configuration_hash text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL
);
CREATE TABLE staff_employee_statutory_reviews(
 id text PRIMARY KEY,facts_id text NOT NULL UNIQUE REFERENCES staff_employee_statutory_facts(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);
CREATE TABLE staff_employer_levy_assessments(
 id text PRIMARY KEY,org_id text NOT NULL REFERENCES organizations(id),period_id text NOT NULL REFERENCES payroll_periods(id),release_stage text NOT NULL,
 country text NOT NULL,configuration_hash text NOT NULL,source_hash text NOT NULL,calculation text NOT NULL,
 created_by text NOT NULL REFERENCES employees(id),created_at text NOT NULL
);
CREATE TABLE staff_employer_levy_reviews(
 id text PRIMARY KEY,assessment_id text NOT NULL UNIQUE REFERENCES staff_employer_levy_assessments(id),decision text NOT NULL CHECK(decision IN('Approved','Rejected')),
 actor_id text NOT NULL REFERENCES employees(id),reason text NOT NULL,created_at text NOT NULL
);

CREATE FUNCTION walshken_source_disposal_allowed(tab text,before_row jsonb,after_row jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path FROM CURRENT AS $guard$
 SELECT EXISTS(
 SELECT 1 FROM staff_source_disposals r JOIN staff_source_disposal_items i ON i.request_id=r.id
 JOIN staff_source_disposal_reviews v ON v.request_id=r.id AND v.decision='Approved' AND v.actor_id<>r.created_by
 WHERE r.id=current_setting('walshken.source_disposal',true) AND r.state='Executing'
 AND r.executed_by=current_setting('walshken.source_disposal_actor',true)
 AND i.table_name=tab AND before_row @> i.record_key
 AND i.before_hash=encode(sha256(convert_to(before_row::text,'UTF8')),'hex')
 AND ((i.operation='Delete' AND after_row IS NULL) OR(i.operation='Redact' AND i.after_hash=encode(sha256(convert_to(after_row::text,'UTF8')),'hex')))
 AND i.eligible_after<=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD')
 AND NOT EXISTS(SELECT 1 FROM staff_legal_holds h WHERE h.org_id=r.org_id
  AND NOT EXISTS(SELECT 1 FROM staff_legal_hold_releases x WHERE x.hold_id=h.id)
  AND (h.scope_type='organization' OR(h.scope_type='employee' AND i.owner_ids ? h.target_id)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(i.hold_targets) a WHERE a->>'type'=h.scope_type AND a->>'id'=h.target_id)))
 );
$guard$;
REVOKE ALL ON FUNCTION walshken_source_disposal_allowed(text,jsonb,jsonb) FROM PUBLIC;

-- Preserve every existing business/history guard; add one narrow checked exit.
DO $wrap$
DECLARE p record;body text;definition text;prefix text;
BEGIN
 FOR p IN SELECT DISTINCT f.oid,f.prosrc,f.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc f ON f.oid=t.tgfoid
 WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND c.relname IN
 ('audit','compensation','payroll','payroll_sources','payroll_payments','payroll_profiles','payroll_openings','payroll_earnings','payroll_members','payroll_events','holiday_allocations','holiday_assessments','holiday_assignments','holiday_audit','holiday_consents','holiday_exceptions','holiday_histories','holiday_private_records','staff_employment_terms','staff_reporting_reviews','staff_work_policy_versions','staff_leave_adjustments','staff_leave_adjustment_reviews','staff_contribution_ledger','staff_country_holiday_allocations','staff_statutory_inputs','staff_statutory_input_reviews','staff_security_events')
 LOOP
  IF position('walshken_source_disposal_allowed' IN p.prosrc)>0 THEN CONTINUE;END IF;
  prefix=format(E'BEGIN\n IF TG_OP=''DELETE'' AND %I.walshken_source_disposal_allowed(TG_TABLE_NAME::text,to_jsonb(OLD),NULL::jsonb) THEN RETURN OLD;END IF;\n IF TG_OP=''UPDATE'' AND %I.walshken_source_disposal_allowed(TG_TABLE_NAME::text,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;',current_schema(),current_schema());
  body=regexp_replace(p.prosrc,'\mBEGIN\M',prefix, 'i');
  IF body=p.prosrc THEN RAISE EXCEPTION 'Unsupported source guard %',p.proname;END IF;
  definition=replace(pg_get_functiondef(p.oid),p.prosrc,body);EXECUTE definition;
 END LOOP;
END;
$wrap$;

DO $security$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_source_validation_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION walshken_reject_history_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['staff_source_disposals','staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_source_disposal_objects','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END;
$security$;

-- END 20261125053842_source_disposal_employer_validation.sql

-- Remove Supabase default Data API grants from every new relation.
-- Do not change database-wide defaults or any other project's privileges.
DO $close_api$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_action_permissions','staff_security_events','staff_privacy_notices','staff_privacy_acknowledgements','staff_reporting_reviews','staff_jurisdiction_versions','staff_jurisdiction_decisions','staff_work_policy_versions','employment_countries','employment_regions','staff_employment_terms','staff_upload_scans','staff_upload_scan_events','staff_leave_adjustments','staff_leave_adjustment_reviews','staff_retention_versions','staff_retention_reviews','staff_legal_holds','staff_legal_hold_releases','staff_statutory_inputs','staff_statutory_input_reviews','staff_contribution_ledger','staff_country_holiday_allocations','staff_privacy_requests','staff_privacy_request_events','staff_privacy_cleanup','staff_source_disposals','staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_source_disposal_objects','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END;
$close_api$;
REVOKE ALL ON FUNCTION public.walshken_source_disposal_allowed(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.walshken_source_disposal_allowed(text,jsonb,jsonb) TO walshken_production_app;

GRANT SELECT,INSERT ON public.staff_action_permissions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_action_permissions FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_action_permissions FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT UPDATE ON public.staff_action_permissions TO walshken_production_app;
CREATE POLICY staff_release_update ON public.staff_action_permissions FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (org_id='walshken');
GRANT DELETE ON public.staff_action_permissions TO walshken_production_app;
CREATE POLICY staff_release_delete ON public.staff_action_permissions FOR DELETE TO walshken_production_app USING (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_security_events TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_security_events FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_security_events FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_privacy_notices TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_privacy_notices FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_privacy_notices FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_privacy_acknowledgements TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_privacy_acknowledgements FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_privacy_notices p WHERE p.id=staff_privacy_acknowledgements.notice_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_privacy_acknowledgements FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_privacy_notices p WHERE p.id=staff_privacy_acknowledgements.notice_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_reporting_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_reporting_reviews FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_reporting_reviews FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.staff_jurisdiction_versions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_jurisdiction_versions FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_jurisdiction_versions FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_jurisdiction_decisions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_jurisdiction_decisions FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_jurisdiction_versions p WHERE p.id=staff_jurisdiction_decisions.version_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_jurisdiction_decisions FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_jurisdiction_versions p WHERE p.id=staff_jurisdiction_decisions.version_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_work_policy_versions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_work_policy_versions FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_work_policy_versions FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.employment_countries TO walshken_production_app;
CREATE POLICY staff_release_select ON public.employment_countries FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.employment_countries FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT UPDATE ON public.employment_countries TO walshken_production_app;
CREATE POLICY staff_release_update ON public.employment_countries FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.employment_regions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.employment_regions FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.employment_regions FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT UPDATE ON public.employment_regions TO walshken_production_app;
CREATE POLICY staff_release_update ON public.employment_regions FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_employment_terms TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employment_terms FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_employment_terms FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_upload_scans TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_upload_scans FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_upload_scans FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT UPDATE ON public.staff_upload_scans TO walshken_production_app;
CREATE POLICY staff_release_update ON public.staff_upload_scans FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_upload_scan_events TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_upload_scan_events FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_upload_scan_events FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_leave_adjustments TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_leave_adjustments FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_leave_adjustments FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_leave_adjustment_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_leave_adjustment_reviews FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_leave_adjustments p WHERE p.id=staff_leave_adjustment_reviews.adjustment_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_leave_adjustment_reviews FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_leave_adjustments p WHERE p.id=staff_leave_adjustment_reviews.adjustment_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_retention_versions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_retention_versions FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_retention_versions FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_retention_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_retention_reviews FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_retention_versions p WHERE p.id=staff_retention_reviews.version_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_retention_reviews FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_retention_versions p WHERE p.id=staff_retention_reviews.version_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_legal_holds TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_legal_holds FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_legal_holds FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_legal_hold_releases TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_legal_hold_releases FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_legal_holds p WHERE p.id=staff_legal_hold_releases.hold_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_legal_hold_releases FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_legal_holds p WHERE p.id=staff_legal_hold_releases.hold_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_statutory_inputs TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_statutory_inputs FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_statutory_inputs FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.staff_statutory_input_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_statutory_input_reviews FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_statutory_inputs p WHERE p.id=staff_statutory_input_reviews.input_id AND p.org_id='walshken' AND p.release_stage='production'));
CREATE POLICY staff_release_insert ON public.staff_statutory_input_reviews FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_statutory_inputs p WHERE p.id=staff_statutory_input_reviews.input_id AND p.org_id='walshken' AND p.release_stage='production'));
GRANT SELECT,INSERT ON public.staff_contribution_ledger TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_contribution_ledger FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_contribution_ledger FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.staff_country_holiday_allocations TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_country_holiday_allocations FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_country_holiday_allocations FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.staff_privacy_requests TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_privacy_requests FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_privacy_requests FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT UPDATE ON public.staff_privacy_requests TO walshken_production_app;
CREATE POLICY staff_release_update ON public.staff_privacy_requests FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_privacy_request_events TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_privacy_request_events FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_privacy_request_events FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_privacy_cleanup TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_privacy_cleanup FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_privacy_cleanup FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT UPDATE ON public.staff_privacy_cleanup TO walshken_production_app;
CREATE POLICY staff_release_update ON public.staff_privacy_cleanup FOR UPDATE TO walshken_production_app USING (org_id='walshken') WITH CHECK (org_id='walshken');
GRANT DELETE ON public.staff_privacy_cleanup TO walshken_production_app;
CREATE POLICY staff_release_delete ON public.staff_privacy_cleanup FOR DELETE TO walshken_production_app USING (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_source_disposals TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_source_disposals FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_source_disposals FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT UPDATE ON public.staff_source_disposals TO walshken_production_app;
CREATE POLICY staff_release_update ON public.staff_source_disposals FOR UPDATE TO walshken_production_app USING (org_id='walshken' AND release_stage='production') WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.staff_source_disposal_items TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_source_disposal_items FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_items.request_id AND p.org_id='walshken' AND p.release_stage='production'));
CREATE POLICY staff_release_insert ON public.staff_source_disposal_items FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_items.request_id AND p.org_id='walshken' AND p.release_stage='production'));
GRANT SELECT,INSERT ON public.staff_source_disposal_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_source_disposal_reviews FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_reviews.request_id AND p.org_id='walshken' AND p.release_stage='production'));
CREATE POLICY staff_release_insert ON public.staff_source_disposal_reviews FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_reviews.request_id AND p.org_id='walshken' AND p.release_stage='production'));
GRANT SELECT,INSERT ON public.staff_source_disposal_events TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_source_disposal_events FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_events.request_id AND p.org_id='walshken' AND p.release_stage='production'));
CREATE POLICY staff_release_insert ON public.staff_source_disposal_events FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_events.request_id AND p.org_id='walshken' AND p.release_stage='production'));
GRANT SELECT,INSERT ON public.staff_source_disposal_objects TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_source_disposal_objects FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_objects.request_id AND p.org_id='walshken' AND p.release_stage='production'));
CREATE POLICY staff_release_insert ON public.staff_source_disposal_objects FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_objects.request_id AND p.org_id='walshken' AND p.release_stage='production'));
GRANT UPDATE ON public.staff_source_disposal_objects TO walshken_production_app;
CREATE POLICY staff_release_update ON public.staff_source_disposal_objects FOR UPDATE TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_objects.request_id AND p.org_id='walshken' AND p.release_stage='production')) WITH CHECK (EXISTS(SELECT 1 FROM public.staff_source_disposals p WHERE p.id=staff_source_disposal_objects.request_id AND p.org_id='walshken' AND p.release_stage='production'));
GRANT SELECT,INSERT ON public.staff_employer_versions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employer_versions FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_employer_versions FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_employer_decisions TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employer_decisions FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_employer_versions p WHERE p.id=staff_employer_decisions.version_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_employer_decisions FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_employer_versions p WHERE p.id=staff_employer_decisions.version_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_employee_statutory_facts TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employee_statutory_facts FOR SELECT TO walshken_production_app USING (org_id='walshken');
CREATE POLICY staff_release_insert ON public.staff_employee_statutory_facts FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken');
GRANT SELECT,INSERT ON public.staff_employee_statutory_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employee_statutory_reviews FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_employee_statutory_facts p WHERE p.id=staff_employee_statutory_reviews.facts_id AND p.org_id='walshken'));
CREATE POLICY staff_release_insert ON public.staff_employee_statutory_reviews FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_employee_statutory_facts p WHERE p.id=staff_employee_statutory_reviews.facts_id AND p.org_id='walshken'));
GRANT SELECT,INSERT ON public.staff_employer_levy_assessments TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employer_levy_assessments FOR SELECT TO walshken_production_app USING (org_id='walshken' AND release_stage='production');
CREATE POLICY staff_release_insert ON public.staff_employer_levy_assessments FOR INSERT TO walshken_production_app WITH CHECK (org_id='walshken' AND release_stage='production');
GRANT SELECT,INSERT ON public.staff_employer_levy_reviews TO walshken_production_app;
CREATE POLICY staff_release_select ON public.staff_employer_levy_reviews FOR SELECT TO walshken_production_app USING (EXISTS(SELECT 1 FROM public.staff_employer_levy_assessments p WHERE p.id=staff_employer_levy_reviews.assessment_id AND p.org_id='walshken' AND p.release_stage='production'));
CREATE POLICY staff_release_insert ON public.staff_employer_levy_reviews FOR INSERT TO walshken_production_app WITH CHECK (EXISTS(SELECT 1 FROM public.staff_employer_levy_assessments p WHERE p.id=staff_employer_levy_reviews.assessment_id AND p.org_id='walshken' AND p.release_stage='production'));

-- Add only missing physical-delete rights. Existing legitimate cleanup rights
-- remain unchanged. Every newly granted delete has both a scoped allow policy
-- and a restrictive exact-manifest policy; unrelated commands match no rows.
DO $source_delete_grants$
DECLARE t text; expression text; candidate regclass;
BEGIN
 FOREACH t IN ARRAY ARRAY['credentials','sessions','invitations','staff_mfa','staff_recovery_codes','staff_avatars','compensation','staff_employment_terms','staff_work_policy_versions','work_policies','payroll_profiles','holiday_private_records','holiday_assignments','staff_employee_statutory_facts','staff_employee_statutory_reviews','attendance','breaks','corrections','staff_reporting_reviews','work_reminders','timesheets','payroll','payroll_sources','payroll_payments','payroll_reconciliations','payroll_earnings','payroll_members','payroll_openings','payroll_events','holiday_allocations','holiday_reconciliations','holiday_assessments','holiday_histories','holiday_consents','holiday_exceptions','staff_contribution_ledger','staff_country_holiday_allocations','staff_statutory_inputs','staff_statutory_input_reviews','doc_entries','doc_versions','doc_acl','doc_events','task_document_links','audit','staff_security_events','work_events','holiday_audit','message_reactions','message_changes','message_mentions','meetings','meeting_members','meeting_attendance','meeting_events','meeting_recordings','leave_requests','staff_leave_adjustments','staff_leave_adjustment_reviews'] LOOP
  candidate=to_regclass('public.'||t);
  IF candidate IS NULL THEN CONTINUE; END IF; -- optional legacy adapters
  IF has_table_privilege('walshken_production_app',candidate,'DELETE') THEN CONTINUE; END IF;
  expression=format('public.walshken_source_disposal_allowed(%L,to_jsonb(%I),NULL::jsonb)',t,t);
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=candidate AND attname='org_id' AND NOT attisdropped) THEN
   expression=expression||' AND org_id=''walshken''';
  ELSIF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=candidate AND attname='employee_id' AND NOT attisdropped) THEN
   expression=expression||format(' AND EXISTS(SELECT 1 FROM public.employees e WHERE e.id=%I.employee_id AND e.org_id=''walshken'')',t);
  ELSIF t='breaks' THEN
   expression=expression||' AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.id=breaks.attendance_id AND a.org_id=''walshken'' AND a.release_stage=''production'')';
  ELSIF t IN('meeting_members','meeting_attendance','meeting_events','meeting_recordings') THEN
   expression=expression||format(' AND EXISTS(SELECT 1 FROM public.meetings m WHERE m.id=%I.meeting_id AND m.org_id=''walshken'')',t);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=candidate AND attname='release_stage' AND NOT attisdropped) THEN
   expression=expression||' AND release_stage=''production''';
  END IF;
  EXECUTE format('GRANT DELETE ON public.%I TO walshken_production_app',t);
  EXECUTE format('CREATE POLICY approved_source_disposal_allow ON public.%I FOR DELETE TO walshken_production_app USING (%s)',t,expression);
  EXECUTE format('CREATE POLICY approved_source_disposal_only ON public.%I AS RESTRICTIVE FOR DELETE TO walshken_production_app USING (%s)',t,expression);
 END LOOP;
END;
$source_delete_grants$;

-- Two redaction columns were intentionally absent from old runtime UPDATE ACLs.
-- Grant precisely those columns, with a trigger binding any change to the same
-- separately approved exact-hash manifest. Existing ordinary column ACLs stay.
CREATE FUNCTION public.walshken_guard_disposal_redaction()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $redaction$
BEGIN
 IF TG_TABLE_NAME='employees' THEN
  IF OLD.auth_id IS NOT DISTINCT FROM NEW.auth_id THEN RETURN NEW;END IF;
 ELSIF TG_TABLE_NAME='messages' THEN
  IF OLD.document_id IS NOT DISTINCT FROM NEW.document_id THEN RETURN NEW;END IF;
 ELSE RAISE EXCEPTION 'Unsupported disposal redaction target';
 END IF;
 IF NOT public.walshken_source_disposal_allowed(TG_TABLE_NAME::text,to_jsonb(OLD),to_jsonb(NEW)) THEN
  RAISE EXCEPTION 'Approved source-disposal manifest required for identity or attachment redaction';
 END IF;
 RETURN NEW;
END;
$redaction$;
REVOKE ALL ON FUNCTION public.walshken_guard_disposal_redaction() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.walshken_guard_disposal_redaction() TO walshken_production_app;
GRANT UPDATE(auth_id) ON public.employees TO walshken_production_app;
GRANT UPDATE(document_id) ON public.messages TO walshken_production_app;
CREATE TRIGGER approved_disposal_auth_redaction BEFORE UPDATE OF auth_id ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.walshken_guard_disposal_redaction();
CREATE TRIGGER approved_disposal_attachment_redaction BEFORE UPDATE OF document_id ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.walshken_guard_disposal_redaction();


-- PostgreSQL SELECT FOR UPDATE requires an UPDATE column privilege and UPDATE
-- policy even for immutable rows. Grant one primary-key column only where the
-- runtime has no UPDATE privilege at all. WITH CHECK(false) makes every actual
-- UPDATE impossible, while scoped SELECT policies still constrain row locks.
DO $source_row_lock_grants$
DECLARE t text; candidate regclass; identity_column text;
BEGIN
 FOREACH t IN ARRAY ARRAY['employees','credentials','sessions','invitations','staff_mfa','staff_recovery_codes','staff_avatars','compensation','staff_employment_terms','staff_work_policy_versions','work_policies','payroll_profiles','holiday_private_records','holiday_assignments','staff_employee_statutory_facts','staff_employee_statutory_reviews','attendance','breaks','corrections','staff_reporting_reviews','work_reminders','timesheets','payroll','payroll_sources','payroll_payments','payroll_reconciliations','payroll_earnings','payroll_members','payroll_openings','payroll_events','holiday_allocations','holiday_reconciliations','holiday_assessments','holiday_histories','holiday_consents','holiday_exceptions','staff_contribution_ledger','staff_country_holiday_allocations','staff_statutory_inputs','staff_statutory_input_reviews','doc_entries','doc_versions','doc_acl','doc_events','task_document_links','audit','staff_security_events','work_events','holiday_audit','messages','message_reactions','message_changes','message_mentions','meetings','meeting_members','meeting_attendance','meeting_events','meeting_recordings','leave_requests','staff_leave_adjustments','staff_leave_adjustment_reviews'] LOOP
  candidate=to_regclass('public.'||t);
  IF candidate IS NULL OR has_any_column_privilege('walshken_production_app',candidate,'UPDATE') THEN CONTINUE; END IF;
  SELECT a.attname INTO identity_column FROM pg_constraint k
   JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
   WHERE k.conrelid=candidate AND k.contype='p';
  IF identity_column IS NULL THEN RAISE EXCEPTION 'Source adapter lacks primary key: %',t; END IF;
  EXECUTE format('GRANT UPDATE(%I) ON public.%I TO walshken_production_app',identity_column,t);
  EXECUTE format('CREATE POLICY source_lock_visibility ON public.%I FOR UPDATE TO walshken_production_app USING (true) WITH CHECK (false)',t);
  EXECUTE format('CREATE POLICY source_lock_no_mutation ON public.%I AS RESTRICTIVE FOR UPDATE TO walshken_production_app USING (true) WITH CHECK (false)',t);
 END LOOP;
END;
$source_row_lock_grants$;

-- Explicit additional provider IDs only; no unrestricted integrations access.
CREATE POLICY staff_delivery_provider_select ON public.integrations FOR SELECT TO walshken_production_app USING(id IN('resend','malware-scanner'));
CREATE POLICY staff_delivery_provider_insert ON public.integrations FOR INSERT TO walshken_production_app WITH CHECK(id IN('resend','malware-scanner'));
CREATE POLICY staff_delivery_provider_update ON public.integrations FOR UPDATE TO walshken_production_app USING(id IN('resend','malware-scanner')) WITH CHECK(id IN('resend','malware-scanner'));

DO $security_postcheck$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['staff_action_permissions','staff_security_events','staff_privacy_notices','staff_privacy_acknowledgements','staff_reporting_reviews','staff_jurisdiction_versions','staff_jurisdiction_decisions','staff_work_policy_versions','employment_countries','employment_regions','staff_employment_terms','staff_upload_scans','staff_upload_scan_events','staff_leave_adjustments','staff_leave_adjustment_reviews','staff_retention_versions','staff_retention_reviews','staff_legal_holds','staff_legal_hold_releases','staff_statutory_inputs','staff_statutory_input_reviews','staff_contribution_ledger','staff_country_holiday_allocations','staff_privacy_requests','staff_privacy_request_events','staff_privacy_cleanup','staff_source_disposals','staff_source_disposal_items','staff_source_disposal_reviews','staff_source_disposal_events','staff_source_disposal_objects','staff_employer_versions','staff_employer_decisions','staff_employee_statutory_facts','staff_employee_statutory_reviews','staff_employer_levy_assessments','staff_employer_levy_reviews'] LOOP
  IF NOT has_table_privilege('walshken_production_app','public.'||t,'SELECT') OR NOT has_table_privilege('walshken_production_app','public.'||t,'INSERT') THEN RAISE EXCEPTION 'Missing runtime grant %',t; END IF;
  IF has_table_privilege('anon','public.'||t,'SELECT') OR has_table_privilege('authenticated','public.'||t,'SELECT') THEN RAISE EXCEPTION 'Unexpected Data API access %',t; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass) THEN RAISE EXCEPTION 'RLS missing %',t; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.walshken_source_disposal_allowed(text,jsonb,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.walshken_source_disposal_allowed(text,jsonb,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Disposal helper exposed'; END IF;
 IF has_schema_privilege('walshken_production_app','walshken_role_qa','USAGE') OR has_table_privilege('walshken_role_qa_runtime','public.employees','SELECT') THEN RAISE EXCEPTION 'Schema isolation lost'; END IF;
 IF (SELECT count(*) FROM public.employment_countries WHERE org_id='walshken')<>3 OR (SELECT count(*) FROM public.employment_regions WHERE org_id='walshken')<>59 THEN RAISE EXCEPTION 'Geographic seed incomplete'; END IF;
END;
$security_postcheck$;
