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
