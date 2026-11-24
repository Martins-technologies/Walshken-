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
